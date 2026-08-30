import fs from "node:fs/promises";
import path from "node:path";

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
      };
    },
  };
}
