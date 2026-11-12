import { build } from "esbuild";

// `bun run build` writes the production runtime bundle.
const args = process.argv.slice(2);
const outfile = args[0] ?? "../internal/runtime/moejs/assets/pi-durable.js";
const entry = args[1] ?? "src/main.ts";

const result = await build({
  entryPoints: [entry],
  bundle: true,
  outfile,
  // moejs loads the bundle as a script, not as an ES module. esbuild's ESM
  // output wraps lazily initialised module bodies in `__esm` helpers and can
  // reference hoisted functions before their module body ran; the IIFE
  // output keeps a single, ordered scope.
  format: "iife",
  platform: "browser",
  target: "es2022",
  mainFields: ["module", "main"],
  conditions: ["import", "module", "browser", "default"],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  legalComments: "none",
  logLevel: "info",
  metafile: true,
});

for (const [name, info] of Object.entries(result.metafile.outputs)) {
  console.log(`${name}: ${(info.bytes / 1024).toFixed(1)} KiB`);
  const external = Object.keys(info.imports).filter((i) => i.external);
  if (external.length) console.log(`  external: ${external.join(", ")}`);
}
