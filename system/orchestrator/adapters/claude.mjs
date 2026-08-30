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
    async composeAdjustedInstructions({ loopName, failedChecks, reviewerNotes }) {
      const checks = (failedChecks || [])
        .map((c) => `- ${c.check_name}: ${c.detail ?? ""}`)
        .join("\n");
      const prompt = `You are the loop orchestrator for "${loopName}". The last run failed its exit gate.
Failed checks:
${checks}

Last reviewer notes:
${reviewerNotes || "(none)"}

Write concise adjusted instructions for the next executor attempt. Mention every failed check name.`;
      return runClaude(prompt);
    },
    async rewriteSynthesis({ targetRel, researchJson, currentBody }) {
      const prompt = `Rewrite the synthesis body for ${targetRel} from this RESEARCH.json (do not include frontmatter or a History section):
${JSON.stringify(researchJson).slice(0, 8000)}

Current body:
${String(currentBody || "").slice(0, 4000)}`;
      return runClaude(prompt);
    },
  };
}
