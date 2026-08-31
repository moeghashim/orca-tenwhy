import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardToolCall } from "./path-guard.mjs";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    const result = guardToolCall({
      toolName: event.toolName,
      input: event.input ?? {},
      cwd: ctx?.cwd || process.cwd(),
    });
    if (result?.block) return result;
    return undefined;
  });
}
