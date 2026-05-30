// Build a Node.js Single Executable Application for the current host.
//
// Usage: node scripts/build-sea.mjs <target>
//   target ∈ { linux-x64, linux-arm64, darwin-x64, darwin-arm64, win-x64 }
//
// The target is informational — it names the output file. SEA does not
// cross-compile; each platform must be built on its own runner. The script
// asserts the host architecture/OS matches the requested target.
//
// Steps (follows the recipe at nodejs.org/api/single-executable-applications.html):
//   1. esbuild bundles src/index.ts into a single CJS file (auggie-sdk is
//      ESM-only but esbuild down-converts via dynamic import shim).
//   2. node --experimental-sea-config builds sea-prep.blob.
//   3. Copy the host node binary to the output path.
//   4. postject injects the blob into the binary.
//   5. On macOS, re-sign with an ad-hoc signature so Gatekeeper allows it.
//   6. Archive (tar.gz on Unix, zip on Windows) for upload-artifact.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { writeFile, mkdir, rm, copyFile, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execPath, platform, arch } from "node:process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD = join(ROOT, "build", "sea");

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/build-sea.mjs <target>");
  console.error("  target: linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64 | win-x64");
  process.exit(1);
}

// Sanity-check that the host matches the requested target. SEA cannot
// cross-compile; the build node binary IS the output runtime.
const HOST = `${platform === "win32" ? "win" : platform}-${arch}`;
if (HOST !== target) {
  console.error(`Host (${HOST}) does not match requested target (${target}).`);
  console.error("SEA does not cross-compile — run this on a matching runner.");
  process.exit(1);
}

const isWindows = platform === "win32";
const isMac = platform === "darwin";
const exeSuffix = isWindows ? ".exe" : "";
const binaryName = `augment-open-proxy-${target}${exeSuffix}`;

// Clean previous SEA output.
if (existsSync(BUILD)) {
  await rm(BUILD, { recursive: true, force: true });
}
await mkdir(BUILD, { recursive: true });
await mkdir(join(BUILD, "dist"), { recursive: true });

// 1. Bundle as CJS — SEA's default mainFormat. We could use ESM mode but
// CJS is the older, more battle-tested path and works on every Node ≥ 20.
const bundlePath = join(BUILD, "bundle.cjs");
console.log("sea: bundling src/index.ts → build/sea/bundle.cjs");
await build({
  entryPoints: [join(ROOT, "src", "index.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  // Bundle everything — SEA binaries are self-contained, no node_modules at runtime.
  // No `external` list here.
  sourcemap: false,
  // Some deps probe for native modules at require time; mark known
  // problematic ones to fail loudly if encountered.
  logLevel: "info",
});

// 2. Build the SEA blob.
const seaConfigPath = join(BUILD, "sea-config.json");
const blobPath = join(BUILD, "sea-prep.blob");
await writeFile(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);
console.log("sea: generating sea-prep.blob");
execSync(`"${execPath}" --experimental-sea-config "${seaConfigPath}"`, {
  stdio: "inherit",
});

// 3. Copy the host node binary as the base for our executable.
const outBinary = join(BUILD, "dist", binaryName);
console.log(`sea: copying host node (${execPath}) → ${outBinary}`);
await copyFile(execPath, outBinary);
await chmod(outBinary, 0o755).catch(() => {});

// 4. On macOS, strip the existing signature before postject mutates the binary.
if (isMac) {
  console.log("sea: stripping macOS signature");
  try {
    execSync(`codesign --remove-signature "${outBinary}"`, { stdio: "inherit" });
  } catch (err) {
    console.warn("sea: codesign --remove-signature failed (continuing):", err.message);
  }
}

// 5. Inject the blob with postject.
const sentinel = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const postjectArgs = [
  `"${outBinary}"`,
  "NODE_SEA_BLOB",
  `"${blobPath}"`,
  "--sentinel-fuse",
  sentinel,
];
if (isMac) {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
console.log("sea: injecting blob with postject");
execSync(`npx postject ${postjectArgs.join(" ")}`, {
  stdio: "inherit",
  cwd: ROOT,
});

// 6. Re-sign on macOS with an ad-hoc signature. Without this Gatekeeper
// will refuse to launch the binary on recent macOS versions.
if (isMac) {
  console.log("sea: ad-hoc signing binary");
  execSync(`codesign --sign - "${outBinary}"`, { stdio: "inherit" });
}

// 7. Quick sanity check: ensure the file grew (blob got injected).
const finalStat = await stat(outBinary);
const nodeStat = await stat(execPath);
console.log(
  `sea: binary size ${(finalStat.size / 1024 / 1024).toFixed(1)} MB ` +
    `(host node was ${(nodeStat.size / 1024 / 1024).toFixed(1)} MB)`,
);
if (finalStat.size <= nodeStat.size) {
  console.error("sea: postject did not enlarge the binary — injection likely failed");
  process.exit(1);
}

// 8. Archive for distribution. tar.gz on Unix, zip on Windows.
const archiveBase = `augment-open-proxy-${target}`;
const distDir = join(BUILD, "dist");
process.chdir(distDir);
// Stage README + LICENSE alongside the binary so the archive is self-explanatory.
await copyFile(join(ROOT, "README.md"), join(distDir, "README.md"));
await copyFile(join(ROOT, "LICENSE"), join(distDir, "LICENSE"));

if (isWindows) {
  const zipPath = join(distDir, `${archiveBase}.zip`);
  console.log(`sea: archiving → ${archiveBase}.zip`);
  // PowerShell's Compress-Archive is always available on GitHub Windows runners.
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Force -Path '${binaryName}','README.md','LICENSE' -DestinationPath '${zipPath}'"`,
    { stdio: "inherit" },
  );
} else {
  console.log(`sea: archiving → ${archiveBase}.tar.gz`);
  execSync(
    `tar -czf "${archiveBase}.tar.gz" "${binaryName}" README.md LICENSE`,
    { stdio: "inherit" },
  );
}

console.log(`sea: done → build/sea/dist/${archiveBase}.{tar.gz,zip}`);
