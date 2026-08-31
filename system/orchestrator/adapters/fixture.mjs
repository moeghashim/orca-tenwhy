import fs from "node:fs/promises";
import path from "node:path";

export function createOrchestratorModelFixture({ instructions = [], synthesis, batch } = {}) {
  const queue = [...instructions];
  const adapter = {
    async composeAdjustedInstructions({ attempt }) {
      const next = queue.shift();
      if (next !== undefined) return next;
      return `Retry attempt ${attempt ?? "n"} with focus on the failed checks.`;
    },
    async rewriteSynthesis({ targetRel, researchJson, currentBody, kind, record }) {
      if (typeof synthesis === "function") {
        return synthesis({ targetRel, researchJson, currentBody, kind, record });
      }
      const company = researchJson?.company?.name || "company";
      return `Deterministic synthesis for ${targetRel} (${company}).`;
    },
  };
  if (batch !== undefined) {
    adapter.rewriteAllSynthesis = async (args) => {
      if (typeof batch === "function") return batch(args);
      return batch;
    };
  }
  return adapter;
}

export function createFixtureAdapter(script) {
  const queues = {
    executor: [...(script.executor ?? [])],
    reviewer: [...(script.reviewer ?? [])],
  };
  return {
    async run({ role, n, workdir }) {
      const next = queues[role].shift();
      if (next === undefined) {
        throw new Error(`fixture exhausted for ${role} at n=${n}`);
      }
      const text = typeof next === "string" ? next : String(next.text ?? "");
      await fs.mkdir(workdir, { recursive: true });
      const outputPath = path.join(workdir, `${role}-${n}.txt`);
      await fs.writeFile(outputPath, text, "utf8");
      return {
        text,
        outputPath,
        traceRef: `fixture://${role}/${n}`,
        exitCode: 0,
        toolCalls: 0,
      };
    },
  };
}
