import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loopsPath = path.join(__dirname, "loops.yaml");

function assert(cond, msg) {
  if (!cond) {
    console.error(msg);
    process.exit(1);
  }
}

const doc = yaml.parse(fs.readFileSync(loopsPath, "utf8"));

assert(doc?.caps?.iteration_cap === 4, "caps.iteration_cap === 4");
assert(doc?.caps?.retry_cap === 2, "caps.retry_cap === 2");

const roles = doc?.roles ?? {};
assert(Object.keys(roles).length > 0, "roles is a non-empty object");

// Exact model strings recorded in system/config/environment.md (P0.1–P0.4).
// The executor id is the Grok CLI "latest" (P0.2); its Pi/xai catalog id is
// re-verified after `/login xai` (environment.md P0.1 PENDING) and this table
// must be updated in the same commit as loops.yaml if it differs.
const EXPECTED_MODELS = {
  orchestrator: "claude-fable-5",
  reviewer: "gpt-5.6-luna",
  executor: "grok-4.6",
};
const REQUIRED_ROLES = Object.keys(EXPECTED_MODELS);
for (const name of REQUIRED_ROLES) {
  assert(roles[name], `roles.${name} is defined`);
}
for (const [name, role] of Object.entries(roles)) {
  assert(
    role?.model === EXPECTED_MODELS[name],
    `roles.${name}.model === ${JSON.stringify(EXPECTED_MODELS[name])} (got ${JSON.stringify(role?.model)})`,
  );
  assert(role?.auth === "oauth", `roles.${name}.auth === oauth`);
  const level = role?.effort ?? role?.thinking;
  assert(level === "high", `roles.${name} effort/thinking === high (got ${JSON.stringify(level)})`);
}

const loops = doc?.loops ?? {};
assert(Object.keys(loops).length > 0, "loops is a non-empty object");
for (const [name, loop] of Object.entries(loops)) {
  assert(typeof loop?.gate === "string", `loops.${name}.gate is a string`);
}

const loopNames = new Set(Object.keys(loops));
const edges = Array.isArray(doc?.edges) ? doc.edges : [];
for (const [i, edge] of edges.entries()) {
  assert(loopNames.has(edge?.from), `edges[${i}].from references a defined loop`);
  assert(loopNames.has(edge?.to), `edges[${i}].to references a defined loop`);
}

const adj = new Map();
for (const name of loopNames) adj.set(name, []);
for (const edge of edges) adj.get(edge.from).push(edge.to);

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map();
for (const name of loopNames) color.set(name, WHITE);

function hasCycleFrom(node) {
  color.set(node, GRAY);
  for (const next of adj.get(node) ?? []) {
    if (color.get(next) === GRAY) return true;
    if (color.get(next) === WHITE && hasCycleFrom(next)) return true;
  }
  color.set(node, BLACK);
  return false;
}

let cyclic = false;
for (const name of loopNames) {
  if (color.get(name) === WHITE && hasCycleFrom(name)) {
    cyclic = true;
    break;
  }
}
assert(!cyclic, "no edge cycles");

console.log("loops.yaml ok");
