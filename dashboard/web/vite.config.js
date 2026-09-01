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
    rollupOptions: {
      input: {
        main: path.join(dir, "index.html"),
        customer: path.join(dir, "customer.html"),
        graph: path.join(dir, "graph.html"),
      },
    },
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:4310" },
  },
});
