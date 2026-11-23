/**
 * scripts/ss33, the POSIX sh launcher that finds or downloads Node.js. These run it for real with `sh`,
 * against a local "nodejs.org" so nothing is downloaded. The real download is exercised in CI
 * (the `launcher` job) on Linux, macOS and Windows.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers.js";

const LAUNCHER = join(process.cwd(), "adapters/claude-code/scripts/ss33");
const NODE_VERSION = "v24.22.2";
const skip = platform() === "win32" ? "POSIX shell tests; Windows is covered by the CI launcher job" : false;
const plat = `${platform() === "darwin" ? "darwin" : "linux"}-${arch() === "arm64" ? "arm64" : "x64"}`;

function run(args: string[], env: Record<string, string>, input = ""): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile("sh", [LAUNCHER, ...args], { env: { PATH: process.env.PATH ?? "", HOME: tempDir(), SS33_NO_SYSTEM_NODE: "1", ...env }, timeout: 20_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr, ms: Date.now() - started }),
    );
    child.stdin?.end(input);
  });
}

/** A runtime dir that already holds "Node.js" (a link to the node running the tests). */
function cachedRuntime(): string {
  const dir = tempDir();
  const bin = join(dir, `node-${NODE_VERSION}-${plat}`, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  return dir;
}

test("launcher: runs the bundle with an explicit or cached runtime, not needing node on PATH", { skip }, async () => {
  const explicit = await run(["version"], { SS33_NODE: process.execPath, SS33_RUNTIME_DIR: tempDir() });
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.match(explicit.stdout, /^\d+\.\d+\.\d+/);

  const cached = await run(["version"], { SS33_RUNTIME_DIR: cachedRuntime() });
  assert.equal(cached.code, 0, cached.stderr);
  assert.equal(cached.stderr, "", "no download message when the runtime is cached");

  const prefetch = await run(["__prefetch-runtime"], { SS33_RUNTIME_DIR: cachedRuntime() });
  assert.deepEqual([prefetch.code, prefetch.stdout, prefetch.stderr], [0, "", ""]);

  // DeepSeek Harness gives its shell commands the executable running it; no download needed.
  const dsh = await run(["version"], { DSH_NODE_EXECUTABLE: process.execPath, SS33_RUNTIME_DIR: tempDir(), SS33_NODE_DIST: "http://127.0.0.1:9/never" });
  assert.equal(dsh.code, 0, dsh.stderr);
  assert.equal(dsh.stderr, "", "no download");
});

test("launcher: a hook with no runtime exits 0 silently and fetches in the background", { skip }, async () => {
  const runtime = tempDir();
  // Nothing listens on port 9: the background fetch fails, the hook must not care.
  const r = await run(["hook", "claude-code", "user-prompt-submit"], { SS33_RUNTIME_DIR: runtime, SS33_NODE_DIST: "http://127.0.0.1:9" }, '{"prompt":"set up ci"}');
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""], "a hook never prints or fails because of the runtime");
  assert.ok(r.ms < 3000, `returned in ${r.ms} ms, without waiting for the download`);
  const s = await run(["__prefetch-runtime"], { SS33_RUNTIME_DIR: runtime, SS33_NODE_DIST: "http://127.0.0.1:9" });
  assert.deepEqual([s.code, s.stdout], [0, ""]);
});

test("launcher: a download that doesn't match the pinned checksum is never used", { skip }, async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.end("not node.js");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as { port: number };
  try {
    const runtime = tempDir();
    const r = await run(["version"], { SS33_RUNTIME_DIR: runtime, SS33_NODE_DIST: `http://127.0.0.1:${port}` });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /did not match its pinned checksum/);
    assert.match(r.stderr, /Install Node\.js 22 or newer/);
    assert.deepEqual(requests, [`/${NODE_VERSION}/node-${NODE_VERSION}-${plat}.tar.gz`]);
    assert.deepEqual(
      readdirSync(runtime).filter((f) => !f.startsWith(".lock")),
      [],
      "nothing unpacked, no temp files left behind",
    );
    assert.ok(!existsSync(join(runtime, `.lock-node-${NODE_VERSION}-${plat}`)), "the lock is released");
  } finally {
    server.close();
  }
});

test("launcher: downloads, verifies, unpacks and uses a runtime, even under a path with a backslash", { skip }, async () => {
  // A stand-in archive laid out like nodejs.org's: node-<v>-<plat>/bin/node (here a script running the real node).
  const src = tempDir();
  const name = `node-${NODE_VERSION}-${plat}`;
  mkdirSync(join(src, name, "bin"), { recursive: true });
  writeFileSync(join(src, name, "bin/node"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  const archive = join(tempDir(), `${name}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", src, name]);
  const body = readFileSync(archive);
  const server = createServer((_req, res) => res.end(body));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as { port: number };
  try {
    // Windows runtime paths contain backslashes; `sha256sum <file>` then prefixes its output with "\\".
    const runtime = join(tempDir(), "with\\backslash");
    const env = { SS33_RUNTIME_DIR: runtime, SS33_NODE_DIST: `http://127.0.0.1:${port}`, SS33_TEST_NODE_SHA256: createHash("sha256").update(body).digest("hex") };
    const first = await run(["version"], env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^\d+\.\d+\.\d+/);
    assert.match(first.stderr, /downloading Node\.js/);
    assert.ok(existsSync(join(runtime, name, "bin/node")));
    const second = await run(["version"], env);
    assert.deepEqual([second.code, second.stderr], [0, ""], "the second run uses the cache");
  } finally {
    server.close();
  }
});

test("launcher: uses the first node on PATH that is new enough, skipping an older one ahead of it", { skip }, async () => {
  // Hermes's terminal puts the user's own tools (here an old Node.js) ahead of Hermes's bundled one.
  const old = tempDir();
  writeFileSync(join(old, "node"), "#!/bin/sh\necho 14\n", { mode: 0o755 });
  const good = tempDir();
  symlinkSync(process.execPath, join(good, "node"));
  const r = await run(["version"], {
    PATH: `${old}:${good}:/usr/bin:/bin`,
    SS33_NO_SYSTEM_NODE: "",
    SS33_RUNTIME_DIR: tempDir(),
    SS33_NODE_DIST: "http://127.0.0.1:9/never",
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
  assert.equal(r.stderr, "", "no download");
});

test("launcher: works when started without its tools on PATH (Git for Windows' sh from PowerShell)", { skip }, async () => {
  const empty = tempDir(); // a PATH with no dirname, uname, …
  const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile("/bin/sh", [LAUNCHER, "version"], { env: { PATH: empty, HOME: tempDir(), SS33_NODE: process.execPath, SS33_RUNTIME_DIR: tempDir() }, timeout: 20_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});
