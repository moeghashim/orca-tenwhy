import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: dir,
  publicDir: false,
  build: {
    outDir: path.join(dir, "dist"),
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:4310" },
  },
});
