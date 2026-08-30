import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_TEXT_MAX = 60 * 1024;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PYTHON = path.join(ROOT, "system/tools/.venv/bin/python");
const SCRAPE = path.join(ROOT, "system/tools/scrape.py");

function truncate(text: string): string {
  if (text.length <= TOOL_TEXT_MAX) return text;
  return text.slice(0, TOOL_TEXT_MAX);
}

function formatExtraction(extracted: {
  title?: string;
  text?: string;
  links?: Array<{ href?: string; text?: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`title: ${extracted.title ?? ""}`);
  lines.push(`text: ${extracted.text ?? ""}`);
  lines.push("links:");
  for (const link of extracted.links ?? []) {
    lines.push(`- ${link.href ?? ""} (${link.text ?? ""})`);
  }
  return truncate(lines.join("\n"));
}

function runScrape(
  url: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      PYTHON,
      [SCRAPE, "--url", url, "--loop-run-id", env.TENWHY_LOOP_RUN_ID ?? "", "--db", env.TENWHY_DB ?? ""],
      { cwd: ROOT, env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const onAbort = () => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort);
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function lastJson(text: string): Record<string, unknown> | null {
  const lines = text.trim().split(/\n+/);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      /* try previous line */
    }
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "scrape",
    label: "Scrape",
    description:
      "Fetch a web page via Scrapling. Use scrape to fetch any web page you cite; never claim a URL you did not scrape.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL to fetch" }),
    }),
    promptGuidelines: [
      "Use scrape to fetch any web page you cite; never claim a URL you did not scrape.",
    ],
    async execute(_toolCallId, params, signal) {
      const loopRunId = process.env.TENWHY_LOOP_RUN_ID;
      const db = process.env.TENWHY_DB;
      if (!loopRunId || !db) {
        return {
          content: [
            {
              type: "text" as const,
              text: "ERROR: TENWHY_LOOP_RUN_ID and TENWHY_DB must be set",
            },
          ],
          details: {},
        };
      }

      const url = String(params.url ?? "");
      let result: { code: number; stdout: string; stderr: string };
      try {
        result = await runScrape(url, process.env, signal);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: { url },
        };
      }

      const printed = lastJson(result.stdout) ?? lastJson(result.stderr) ?? {};
      if (result.code === 3 || printed.refused) {
        const reason = String(printed.reason ?? "unknown");
        return {
          content: [
            {
              type: "text" as const,
              text: `REFUSED: ${reason} ${url}`,
            },
          ],
          details: { url, reason, refused: true },
        };
      }
      if (result.code !== 0) {
        const errText = String(printed.error ?? result.stderr.trim() ?? `exit ${result.code}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `ERROR: ${errText}`,
            },
          ],
          details: { url },
        };
      }

      const contentPath = String(printed.content_path ?? "");
      const httpStatus = printed.http_status ?? null;
      let extracted: { title?: string; text?: string; links?: Array<{ href?: string; text?: string }> } = {};
      if (contentPath) {
        try {
          extracted = JSON.parse(await readFile(contentPath, "utf8"));
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `ERROR: failed to read extraction JSON: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: { url, http_status: httpStatus, content_path: contentPath },
          };
        }
      }

      return {
        content: [{ type: "text" as const, text: formatExtraction(extracted) }],
        details: { url, http_status: httpStatus, content_path: contentPath },
      };
    },
  });
}
