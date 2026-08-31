import { spawn } from "node:child_process";

const MODEL = "claude-fable-5";

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--model", MODEL, "--effort", "high", "--output-format", "json", prompt], {
      encoding: "utf8",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const text = parsed.result ?? parsed.text ?? parsed.content ?? stdout;
        resolve(typeof text === "string" ? text : JSON.stringify(text));
      } catch {
        resolve(stdout.trim());
      }
    });
  });
}

export function createClaudeAdapter() {
  return {
    async composeAdjustedInstructions({
      loopName,
      failedChecks,
      reviewerNotes,
      attempt,
      previousInstructions,
    }) {
      const checks = (failedChecks || [])
        .map((c) => `- ${c.check_name}: ${c.detail ?? ""}`)
        .join("\n");
      const prompt = `You are the loop orchestrator for "${loopName}". The last run failed its exit gate.
This is attempt ${attempt ?? "?"}.
Failed checks:
${checks}

Last reviewer notes:
${reviewerNotes || "(none)"}

Previous adjusted instructions:
${previousInstructions || "(none)"}

Write concise adjusted instructions for the next executor attempt. Mention every failed check name. Do not repeat the previous instructions verbatim.`;
      return runClaude(prompt);
    },
    async rewriteSynthesis({ targetRel, researchJson, currentBody }) {
      const prompt = `Rewrite the synthesis body for ${targetRel} from this RESEARCH.json (do not include frontmatter or a History section):
${JSON.stringify(researchJson).slice(0, 8000)}

Current body:
${String(currentBody || "").slice(0, 4000)}`;
      return runClaude(prompt);
    },
    async rewriteAllSynthesis({ targets, researchJson }) {
      const listing = (targets || [])
        .map((t) => {
          const slice = t.record ? JSON.stringify(t.record).slice(0, 1500) : "";
          return `### ${t.rel} (${t.kind || ""})\nResearch slice: ${slice || "(full RESEARCH.json)"}\nCurrent body:\n${String(t.currentBody || "").slice(0, 2000)}`;
        })
        .join("\n\n");
      const prompt = `Return a JSON object mapping each relative markdown path to a rewritten synthesis body. Do not include frontmatter or a History section. Keys must be the exact paths listed.

RESEARCH.json:
${JSON.stringify(researchJson).slice(0, 12000)}

${listing}`;
      const text = await runClaude(prompt);
      const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
      const raw = fence ? fence[1] : String(text).trim();
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        throw new Error("batch synthesis JSON must be an object");
      }
      return obj;
    },
  };
}
