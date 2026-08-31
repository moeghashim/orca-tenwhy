import fs from "node:fs";
import path from "node:path";

const READ_TOOLS = new Set(["read", "ls", "grep", "find"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const ALLOWED_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);

export function deepestExistingAncestor(absPath) {
  let cur = path.resolve(absPath);
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

export function isInside(candidate, root) {
  const rootAbs = path.resolve(root);
  const rootReal = fs.existsSync(rootAbs) ? fs.realpathSync(rootAbs) : rootAbs;
  const resolved = path.resolve(candidate);
  const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  return resolved === rootReal || resolved.startsWith(prefix);
}

/** Resolve a tool path through the deepest existing realpath ancestor (symlink-safe). */
export function resolveGuardedPath(inputPath, cwd) {
  const abs = path.resolve(cwd, inputPath == null || inputPath === "" ? "." : String(inputPath));
  const ancestor = deepestExistingAncestor(abs);
  if (!fs.existsSync(ancestor)) {
    return { ok: false, reason: `path not resolvable: ${inputPath}` };
  }
  let ancestorReal;
  try {
    ancestorReal = fs.realpathSync(ancestor);
  } catch (err) {
    return { ok: false, reason: `realpath failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const suffix = path.relative(ancestor, abs);
  if (suffix.startsWith("..") || path.isAbsolute(suffix)) {
    return { ok: false, reason: `symlink escape: ${inputPath}` };
  }
  const resolved = suffix ? path.resolve(ancestorReal, suffix) : ancestorReal;
  return { ok: true, resolved, ancestorReal };
}

export function guardToolCall({ toolName, input = {}, cwd }) {
  const name = String(toolName ?? "");
  if (!ALLOWED_TOOLS.has(name)) {
    return { block: true, reason: `tool ${name} is not allowed` };
  }
  if (!cwd) {
    return { block: true, reason: "cwd is required" };
  }
  const rawPath = Object.prototype.hasOwnProperty.call(input, "path") ? input.path : ".";
  const resolved = resolveGuardedPath(rawPath, cwd);
  if (!resolved.ok) {
    return { block: true, reason: resolved.reason };
  }
  let repoReal;
  try {
    repoReal = fs.realpathSync(cwd);
  } catch (err) {
    return { block: true, reason: `cwd realpath failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (READ_TOOLS.has(name)) {
    if (!isInside(resolved.resolved, repoReal)) {
      return { block: true, reason: `read path escapes customer repo: ${resolved.resolved}` };
    }
    return undefined;
  }
  if (WRITE_TOOLS.has(name)) {
    const websiteRoot = path.join(cwd, "website");
    if (!isInside(resolved.resolved, websiteRoot)) {
      return { block: true, reason: `write path escapes website/: ${resolved.resolved}` };
    }
    if (!isInside(resolved.ancestorReal, repoReal)) {
      return { block: true, reason: `write path escapes customer repo: ${resolved.resolved}` };
    }
    return undefined;
  }
  return { block: true, reason: `tool ${name} is not allowed` };
}
