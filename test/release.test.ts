/**
 * tools/release.mjs, run for real on a copy of the files that carry the version (SS33_RELEASE_ROOT),
 * with --no-verify so it doesn't rebuild and retest the repo.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers.js";

const TOOL = join(process.cwd(), "tools/release.mjs");
// The files the tool bumps, read from its own FILES table so this test can't drift from it.
const FILES = [...readFileSync(TOOL, "utf8").matchAll(/^ {2}\["([^"]+)",/gm)].map((m) => m[1]!);
const CURRENT = JSON.parse(readFileSync("package.json", "utf8")).version as string;

function copy(): string {
  const dir = tempDir("ss33-release-");
  for (const f of FILES) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(f, join(dir, f));
  }
  return dir;
}

function release(root: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [TOOL, ...args], { env: { ...process.env, SS33_RELEASE_ROOT: root } }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const snapshot = (root: string) => FILES.map((f) => readFileSync(join(root, f), "utf8"));
const bump = (v: string, i: number) => v.split(".").map((n, j) => (j < i ? Number(n) : j === i ? Number(n) + 1 : 0)).join(".");

test("release: knows every file that carries the version", () => {
  assert.ok(FILES.length >= 9, FILES.join(", "));
  for (const f of FILES) assert.ok(readFileSync(f, "utf8").includes(CURRENT), `${f} holds ${CURRENT}`);
});

test("release: patch, minor, major and an explicit version bump every file, and nothing else", async () => {
  for (const [arg, next] of [["patch", bump(CURRENT, 2)], ["minor", bump(CURRENT, 1)], ["major", bump(CURRENT, 0)], ["99.0.0", "99.0.0"]] as const) {
    const root = copy();
    const before = snapshot(root);
    const r = await release(root, arg, "--no-verify");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`${CURRENT.replace(/\./g, "\\.")} → ${next.replace(/\./g, "\\.")} in ${FILES.length} files`));
    assert.match(r.stdout, new RegExp(`${next.replace(/\./g, "\\.")} is ready`));
    snapshot(root).forEach((after, i) => assert.equal(after, before[i]!.split(CURRENT).join(next), `${FILES[i]}: only the version changed (${arg})`));
    // package-lock.json pins dependency versions too; only ss33's own two entries move.
    assert.equal(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages[""].version, next);
  }
});

test("release: refuses bad arguments, and a file that doesn't match leaves every file untouched", async () => {
  const root = copy();
  const before = snapshot(root);
  for (const [args, msg] of [
    [[], /usage: npm run release -- <x\.y\.z \| patch \| minor \| major> {2}\(now /],
    [["1.2"], /"1\.2" is not a version/],
    [["0.0.1"], /0\.0\.1 is not newer than /],
    [[CURRENT], /is not newer than /],
  ] as const) {
    const r = await release(root, ...args, "--no-verify");
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, msg);
  }

  // One manifest already bumped by hand: nothing may change, not even the files checked before it.
  const last = FILES.at(-1)!;
  writeFileSync(join(root, last), before.at(-1)!.split(CURRENT).join("0.0.0"));
  const r = await release(root, "patch", "--no-verify");
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`release: ${last.replace(/\./g, "\\.")}: expected 1 × version`));
  assert.deepEqual(snapshot(root).slice(0, -1), before.slice(0, -1));
});
