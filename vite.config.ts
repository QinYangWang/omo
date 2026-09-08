import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Workspace and Shiki are already lazy-loaded. Their largest minified
    // chunks stay below 1 MB (and roughly 265 kB gzip), so Vite's generic
    // 500 kB warning is too low for these intentionally deferred assets.
    chunkSizeWarningLimit: 1000,
  },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: { port: 5188, strictPort: true },
});
