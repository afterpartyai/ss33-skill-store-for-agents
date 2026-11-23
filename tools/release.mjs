#!/usr/bin/env node
// Bump the version everywhere it lives, rebuild every plugin's bundle and run the tests.
//
//   npm run release -- 0.4.7          (or patch | minor | major)
//
// Then commit the result (in the fix PR, or a release PR) and, once merged, tag and publish:
//   git tag -a v0.4.7 -m v0.4.7 <merge commit> && git push origin v0.4.7 && gh release create v0.4.7 --notes-file <notes>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every file that carries the version, with the pattern that matches it. test/packaging.test.ts checks they agree.
const v = (s) => s.replace(/\./g, "\\.");
const FILES = [
  ["package.json", (old) => new RegExp(`^(  "version": ")${v(old)}(")`, "m"), 1],
  ["package-lock.json", (old) => new RegExp(`^(  "version": "|      "version": ")${v(old)}(")`, "gm"), 2], // top level and packages[""]
  ["src/core/version.ts", (old) => new RegExp(`(VERSION = ")${v(old)}(")`), 1],
  ["adapters/claude-code/.claude-plugin/plugin.json", (old) => new RegExp(`^(  "version": ")${v(old)}(")`, "m"), 1],
  ["adapters/codex/.codex-plugin/plugin.json", (old) => new RegExp(`^(  "version": ")${v(old)}(")`, "m"), 1],
  ["adapters/hermes/plugin.yaml", (old) => new RegExp(`^(version: )${v(old)}()$`, "m"), 1],
  ["adapters/cursor/.cursor-plugin/plugin.json", (old) => new RegExp(`^(  "version": ")${v(old)}(")`, "m"), 1],
  ["adapters/copilot/plugin.json", (old) => new RegExp(`^(  "version": ")${v(old)}(")`, "m"), 1],
];

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const arg = process.argv[2];
if (!arg) fail(`usage: npm run release -- <x.y.z | patch | minor | major>  (now ${current})`);

const [maj, min, pat] = current.split(".").map(Number);
const next = { patch: `${maj}.${min}.${pat + 1}`, minor: `${maj}.${min + 1}.0`, major: `${maj + 1}.0.0` }[arg] ?? arg;
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`"${arg}" is not a version (x.y.z) or patch | minor | major`);
const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
if (cmp(next, current) <= 0) fail(`${next} is not newer than ${current}`);

// Check every file first, so a mismatch leaves nothing half-bumped.
const edits = FILES.map(([file, pattern, count]) => {
  const text = readFileSync(join(root, file), "utf8");
  const found = text.match(new RegExp(pattern(current).source, "gm"))?.length ?? 0;
  if (found !== count) fail(`${file}: expected ${count} × version ${current}, found ${found}`);
  return [file, text.replace(pattern(current), `$1${next}$2`)];
});
for (const [file, text] of edits) writeFileSync(join(root, file), text);
console.log(`release: ${current} → ${next} in ${edits.length} files`);

for (const script of ["build", "test"]) {
  const r = spawnSync("npm", ["run", script, "--silent"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) fail(`npm run ${script} failed; the version files are already bumped`);
}

console.log(`
release: ${next} is ready. Next:
  - commit everything, including the rebuilt adapters/*/lib/ss33.cjs
  - hermes plugins validate adapters/hermes   (if Hermes is installed)
  - after merging: git tag -a v${next} -m v${next} <merge commit> && git push origin v${next}
                   gh release create v${next} --title "v${next}" --notes-file <notes>`);
