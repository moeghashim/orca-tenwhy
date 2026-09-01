import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);

function resolvePkg(spec) {
  return pathToFileURL(require.resolve(spec)).href;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "react" || specifier.startsWith("react/")) {
    return { url: resolvePkg(specifier), shortCircuit: true };
  }
  if (specifier === "react-dom" || specifier.startsWith("react-dom/")) {
    return { url: resolvePkg(specifier), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".css")) {
    return { format: "module", source: "export default {};\n", shortCircuit: true };
  }
  if (!url.endsWith(".jsx")) return nextLoad(url, context);
  const source = readFileSync(new URL(url), "utf8");
  const { code } = transformSync(source, {
    loader: "jsx",
    jsx: "automatic",
    format: "esm",
    sourcefile: url,
  });
  return { format: "module", source: code, shortCircuit: true };
}
