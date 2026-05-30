// Build the runtime `dist/` for `node dist/index.js` and the published npm
// package. We use esbuild (not tsc) so the build matches the dev runtime
// (tsx) and vitest, both of which transpile without type-checking. Strict
// type-checking is available separately via `npm run typecheck`.
//
// Strategy: bundle src/index.ts → dist/index.js as a single ESM file. We
// bundle (rather than emit per-file) because:
//   1. esbuild's per-file transpile leaves bare relative imports
//      (`from "./config"`) which Node ESM rejects — NodeNext requires
//      explicit `.js` suffixes that the source does not use.
//   2. A single bundled file makes the SEA step trivial (one input).
//   3. The Augment SDK is ESM-only, so dist/ has to be ESM anyway.
//
// Native modules and any package whose loading must happen at runtime stay
// external — they're resolved from the user's node_modules at start time.
import { build } from "esbuild";
import { writeFile, readFile, chmod, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

const require = createRequire(import.meta.url);
const pkg = require(join(ROOT, "package.json"));
const runtimeDeps = Object.keys(pkg.dependencies || {});

// Clean previous build.
if (existsSync(DIST)) {
  await rm(DIST, { recursive: true, force: true });
}
await mkdir(DIST, { recursive: true });

await build({
  entryPoints: [join(SRC, "index.ts")],
  outfile: join(DIST, "index.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // Keep runtime deps external — installed alongside the package via
  // package.json "dependencies". Bundling them would inline copies and
  // break peer-dep semantics for @augmentcode/auggie-sdk.
  external: [...runtimeDeps, "@hono/node-server"],
  // ESM needs the dynamic-require shim because some deps (Hono) use CJS
  // internals; this banner gives them a require() in the ESM context.
  banner: {
    js: [
      "import { createRequire as __aopCreateRequire } from 'node:module';",
      "const require = __aopCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  sourcemap: false,
  logLevel: "info",
});

// Ensure the bin entry has a shebang and is executable on Unix.
const entry = join(DIST, "index.js");
const contents = await readFile(entry, "utf8");
if (!contents.startsWith("#!")) {
  await writeFile(entry, "#!/usr/bin/env node\n" + contents);
}
try {
  await chmod(entry, 0o755);
} catch {
  // chmod is a no-op on Windows; ignore.
}

console.log("build: wrote dist/index.js");
