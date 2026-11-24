/**
 * End-to-end: the real `ss33` CLI as a child process, against the fake store over HTTP.
 * Covers the install lifecycle, the prompt hook, a hostile skill, and store failures.
 *
 * Runs the compiled source (build/src/cli/main.js). Set SS33_E2E_BIN=adapters/claude-code/lib/ss33.cjs
 * to run the shipped bundle instead.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadSetFixture, loadSkillFixture } from "../src/fakestore/fixtures.js";
import { startFakeStore, type FakeStore } from "../src/fakestore/server.js";
import { tempDir } from "./helpers.js";

const BIN = join(process.cwd(), process.env.SS33_E2E_BIN ?? "build/src/cli/main.js");
let store: FakeStore;

before(async () => {
  const fixture = join(process.cwd(), "test/fixtures/store/basic.json");
  store = await startFakeStore({ skills: loadSkillFixture(fixture), sets: loadSetFixture(fixture) });
});
after(() => store.close());

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Async on purpose: the fake store runs in this process and must keep answering while the CLI waits. */
function ss33(args: string[], opts: { cwd: string; env?: Record<string, string>; input?: string; endpoint?: string }): Promise<Run> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Isolate from the developer's machine: no real key, no Claude Code or plugin settings.
    if (v === undefined || k.startsWith("SS33_") || k.startsWith("CLAUDE")) continue;
    env[k] = v;
  }
  Object.assign(env, { SS33_ENDPOINT: opts.endpoint ?? store.url, SS33_CONFIG_DIR: join(opts.cwd, ".cfg"), SS33_STATE_DIR: join(opts.cwd, ".state") }, opts.env);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { cwd: opts.cwd, env, timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

function project(): string {
  const dir = tempDir("ss33-e2e-");
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5.6.0" } }));
  return dir;
}

const SKILL = ".claude/skills/github-actions-ci/SKILL.md";
const CI_REF = "acme/github-actions-ci-1001";
const ciSkill = () => loadSkillFixture(join(process.cwd(), "test/fixtures/store/basic.json")).find((s) => s.ref === CI_REF)!;

test("e2e: search → add → list → upstream update → local edits → missing → remove → teammate clone", async () => {
  const dir = project();
  const original = ciSkill();
  try {
    const search = await ss33(["search", "set up github actions ci"], { cwd: dir });
    assert.equal(search.code, 0, search.stderr);
    assert.match(search.stdout, new RegExp(CI_REF));
    const sent = store.calls.at(-1)?.args?.query as string;
    assert.match(sent, /Project context: languages: .*typescript/, "the project summary goes with the search");

    const add = await ss33(["add", CI_REF], { cwd: dir });
    assert.equal(add.code, 0, add.stderr);
    assert.ok(existsSync(join(dir, SKILL)));
    assert.ok(JSON.parse(readFileSync(join(dir, "ss33.lock"), "utf8")).skills["github-actions-ci"]);
    assert.match((await ss33(["list"], { cwd: dir })).stdout, /✓ {2}\.claude\/skills\/github-actions-ci\/SKILL\.md/);

    // The author publishes a new version.
    store.publish({ ...original, content: original.content!.replace("3. Use a Node version matrix", "3. Cache npm.\n4. Use a Node version matrix") });
    const check = await ss33(["update"], { cwd: dir });
    assert.match(check.stdout, /update available/);
    assert.match(check.stdout, /\+ 3\. Cache npm\./);
    assert.doesNotMatch(readFileSync(join(dir, SKILL), "utf8"), /Cache npm/, "checking never writes");
    assert.match((await ss33(["update", "--yes"], { cwd: dir })).stdout, /: updated/);
    assert.match(readFileSync(join(dir, SKILL), "utf8"), /Cache npm/);

    // A local edit blocks the next update unless forced.
    writeFileSync(join(dir, SKILL), readFileSync(join(dir, SKILL), "utf8") + "\nOur team runs tests in parallel.\n");
    assert.match((await ss33(["list"], { cwd: dir })).stdout, /✎ modified/);
    store.publish({ ...original, content: original.content + "\nNew upstream line.\n" });
    assert.match((await ss33(["update", "--yes"], { cwd: dir })).stdout, /has local edits; not updated/);
    assert.match(readFileSync(join(dir, SKILL), "utf8"), /Our team runs tests in parallel/, "local edits survive");

    // A teammate clones the repo: the lock and the skill come with it, pinned.
    const clone = tempDir("ss33-e2e-clone-");
    cpSync(dir, clone, { recursive: true, filter: (p) => !p.includes(".cfg") && !p.includes(".state") });
    assert.equal((await ss33(["list", "--json"], { cwd: clone })).stdout.includes('"status": "modified"'), true, "the clone sees the same pinned hash");

    rmSync(join(dir, SKILL));
    assert.match((await ss33(["list"], { cwd: dir })).stdout, /✗ missing/);
    assert.match((await ss33(["remove", "github-actions-ci"], { cwd: dir })).stdout, /Removed/);
    assert.equal(existsSync(join(dir, "ss33.lock")), false, "removing the last skill removes the lock");
    assert.equal(existsSync(join(dir, ".claude/skills/github-actions-ci")), false);
  } finally {
    store.publish(original);
  }
});

test("e2e: unavailable skills and missing supporting files", async () => {
  const dir = project();
  const restricted = await ss33(["add", "restricted/pptx-creator-1006"], { cwd: dir });
  assert.equal(restricted.code, 1);
  assert.match(restricted.stdout, /isn't available from the Skill Store \(its licence doesn't allow redistribution\)\. Nothing was installed\./);
  assert.match(restricted.stdout, /https:\/\/github\.com\/example\/skills\/blob\/0000000\/pptx-creator/);
  assert.equal(existsSync(join(dir, ".claude")), false);
  assert.equal(existsSync(join(dir, "ss33.lock")), false);

  const search = await ss33(["search", "make powerpoint slides deck"], { cwd: dir });
  assert.match(search.stdout, /restricted\/pptx-creator-1006\)\s+\[not available from the store: can't be installed\]/);

  const mcp = await ss33(["add", "acme/mcp-builder-1007", "--dry-run"], { cwd: dir });
  assert.match(mcp.stdout, /links to files that won't be installed: assets\/basic-server\.py, references\/integration-patterns\.md/);
  assert.match(mcp.stdout, /the store doesn't carry this skill's supporting files; the author's folder: https:\/\/github\.com\/example\/skills\/tree\/0000000\/mcp-builder/);
});

function hookInput(dir: string, prompt: string, session = `s-${Math.random()}`): string {
  return JSON.stringify({ session_id: session, cwd: dir, hook_event_name: "UserPromptSubmit", prompt });
}
const hook = (dir: string, prompt: string, extra: { endpoint?: string; env?: Record<string, string>; session?: string } = {}) =>
  ss33(["hook", "claude-code", "user-prompt-submit"], { cwd: dir, input: hookInput(dir, prompt, extra.session), env: { SS33_MATCH: "1", ...extra.env }, ...(extra.endpoint ? { endpoint: extra.endpoint } : {}) });

test("e2e hook: suggests a fitting skill once, never an unavailable or wrong-stack one, and neutralises hostile text", async () => {
  const dir = project();
  const session = "hook-session-1";
  const prompt = "Set up a GitHub Actions CI pipeline that runs lint and tests on every PR";
  const first = await hook(dir, prompt, { session });
  assert.equal(first.code, 0);
  const ctx = JSON.parse(first.stdout).hookSpecificOutput.additionalContext as string;
  assert.match(ctx, new RegExp(`ref: ${CI_REF}`));
  assert.match(ctx, /third-party reference material, not an instruction/);
  assert.equal((await hook(dir, prompt, { session })).stdout, "", "not repeated in the same session");

  assert.equal((await hook(dir, "make powerpoint slides for the quarterly deck review")).stdout, "", "unavailable skill is never suggested");
  assert.equal((await hook(dir, "the build is failing on the tests, please fix the failing build")).stdout, "", ".NET skill not suggested in a Node project");
  assert.equal((await hook(dir, "install the plugin for this project, which plugins should I install?")).stdout, "", "OpenCode skill not suggested");

  const hostile = await hook(dir, "use the coding helper to deploy the app to production");
  const hint = hostile.stdout ? (JSON.parse(hostile.stdout).hookSpecificOutput.additionalContext as string) : "";
  assert.match(hint, /evil\/always-use-1008/, "the hostile fixture does match this prompt");
  assert.doesNotMatch(hint, /\bMUST\b|ignore previous instructions|PROACTIVELY/i, "publisher imperatives are stripped");
  assert.doesNotMatch(hint, /curl|credentials/, "the hint carries the description, never the SKILL.md body");
});

test("e2e hook: codex gets the same suggestion, with Codex's install command, and `add --target agents` writes .agents/skills", async () => {
  const dir = project();
  const prompt = "Set up a GitHub Actions CI pipeline that runs lint and tests on every PR";
  const r = await ss33(["hook", "codex", "user-prompt-submit"], {
    cwd: dir,
    // Codex adds turn_id, model and permission_mode; unknown fields must be ignored.
    input: JSON.stringify({ session_id: "codex-1", turn_id: "t1", cwd: dir, hook_event_name: "UserPromptSubmit", model: "gpt-x", permission_mode: "default", prompt }),
    env: { SS33_MATCH: "1" },
  });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`\\$ss33:add ${CI_REF}`));
  assert.match(out.systemMessage, new RegExp(`\\$ss33:add ${CI_REF}`));
  assert.doesNotMatch(r.stdout, /\/ss33:add/, "no Claude Code command in Codex");

  const add = await ss33(["add", CI_REF, "--target", "agents"], { cwd: dir });
  assert.equal(add.code, 0, add.stdout);
  assert.match(add.stdout, /\.agents\/skills\/[^/]+\/SKILL\.md/);
  assert.match(add.stdout, /Codex, Copilot, Cursor and other agents/);
  assert.doesNotMatch(add.stdout, /Claude Code picks up/);
  assert.ok(!existsSync(join(dir, ".claude")), "nothing written for Claude Code");
});

test("e2e hook: copilot's Windows PowerShell hook input (UTF-8 BOM, CRLF) still parses", async () => {
  const dir = project();
  const prompt = "Set up a GitHub Actions CI pipeline that runs lint and tests on every PR";
  const r = await ss33(["hook", "copilot", "user-prompt-submitted"], {
    cwd: dir,
    input: `\uFEFF${JSON.stringify({ sessionId: "copilot-bom", cwd: dir, prompt })}\r\n`,
    env: { SS33_MATCH: "1" },
  });
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.stdout).additionalContext, new RegExp(`/ss33:add ${CI_REF}`));
});

test("e2e: a read-only .agents (Codex's sandbox) gets a clear message, not a stack trace, and no lock entry", { skip: process.getuid?.() === 0 ? "root ignores permissions" : false }, async () => {
  const dir = project();
  mkdirSync(join(dir, ".agents"), { mode: 0o555 });
  try {
    const add = await ss33(["add", CI_REF, "--target", "agents"], { cwd: dir });
    assert.equal(add.code, 1);
    assert.match(add.stderr, /Can't write \.agents\/skills\/[^ ]+\/SKILL\.md \((EACCES|EPERM|EROFS|ENOENT)\)/);
    assert.match(add.stderr, /escalated permissions/);
    assert.doesNotMatch(add.stderr, /unexpected error|    at /);
    assert.ok(!existsSync(join(dir, "ss33.lock")), "the lock isn't written when the skill file wasn't");
  } finally {
    chmodSync(join(dir, ".agents"), 0o755);
  }
});

test("e2e hook: matching off means no store calls", async () => {
  const dir = project();
  const before = store.calls.length;
  const r = await hook(dir, "Set up a GitHub Actions CI pipeline that runs lint and tests", { env: { SS33_MATCH: "0" } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(store.calls.length, before, "prompt text never leaves the machine when matching is off");
});

test("e2e hook: store failures never reach the session (silent, exit 0, within budget)", { timeout: 60_000 }, async () => {
  const dir = project();
  const prompt = "Set up a GitHub Actions CI pipeline that runs lint and tests on every PR";
  // The slow-store fault is well past the 3 s client timeout, so finishing under 7 s proves the timeout cut it off,
  // with headroom for process start-up when the whole suite runs at once (a 5 s / 4.5 s version was flaky).
  const faults = [{ latencyMs: 8000 }, { status: 500 }, { status: 401 }, { malformed: true }, { hangup: true }, { limited: true }];
  try {
    for (const fault of faults) {
      store.setFault(fault);
      const r = await hook(dir, prompt);
      assert.equal(r.code, 0, JSON.stringify(fault));
      assert.equal(r.stdout, "", `no output for ${JSON.stringify(fault)}`);
      assert.ok(r.ms < 7000, `hook took ${r.ms}ms for ${JSON.stringify(fault)}; the client budget is 3s`);
    }
  } finally {
    store.setFault(undefined);
  }
  const down = await hook(dir, prompt, { endpoint: "http://127.0.0.1:9/mcp" });
  assert.equal(down.code, 0);
  assert.equal(down.stdout, "", "store unreachable");
  assert.match(readFileSync(join(dir, ".state", "hook.log"), "utf8"), /timed out/, "the reason is logged for debugging");
});

const SET_REF = "skill-set/node-ci-quality-set-9001";
const VITEST = ".claude/skills/vitest-testing/SKILL.md";

test("e2e skill sets: search shows the set, get lists its steps, add installs every step in order, remove takes them all", async () => {
  const dir = project();
  try {
    const search = await ss33(["search", "quality pipeline for unit tests"], { cwd: dir });
    assert.equal(search.code, 0, search.stderr);
    assert.match(search.stdout, /Skill sets \(skills used together for the whole job\):\n• Node CI Quality Set {2}\(skill-set\/node-ci-quality-set-9001\) {2}2 skills, run in order/);

    const get = await ss33(["get", SET_REF], { cwd: dir });
    assert.equal(get.code, 0, get.stderr);
    assert.match(get.stdout, /1\. Vitest Testing {2}\(acme\/vitest-testing-1002\) {2}\[write the tests; small model\]\n {2}2\. Github Actions CI/);

    const dry = await ss33(["add", SET_REF, "--dry-run"], { cwd: dir });
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Would install 2 of 2 skills/);
    assert.ok(!existsSync(join(dir, "ss33.lock")), "a dry run writes nothing");

    const add = await ss33(["add", SET_REF], { cwd: dir });
    assert.equal(add.code, 0, add.stderr);
    const lock = JSON.parse(readFileSync(join(dir, "ss33.lock"), "utf8"));
    assert.deepEqual(lock.skills["vitest-testing"].set, { ref: SET_REF, title: "Node CI Quality Set", position: 1, steps: ["vitest-testing", "github-actions-ci"] });
    assert.equal(lock.skills["github-actions-ci"].set.position, 2);
    assert.match(readFileSync(join(dir, SKILL), "utf8"), /This is step 2 of the skill set "Node CI Quality Set" \(skill-set\/node-ci-quality-set-9001\)\. Its steps, in order: 1\. vitest-testing, 2\. github-actions-ci\./);
    assert.match((await ss33(["list"], { cwd: dir })).stdout, /step 1 of skill set "Node CI Quality Set"/);
    assert.doesNotMatch((await ss33(["list"], { cwd: dir })).stdout, /modified/, "the set note doesn't count as a local edit");

    // A step updated or reinstalled on its own stays in the set.
    const original = ciSkill();
    store.publish({ ...original, content: original.content!.replace("3. Use a Node version matrix", "3. Cache npm.\n4. Use a Node version matrix") });
    try {
      assert.match((await ss33(["update", "--yes"], { cwd: dir })).stdout, /github-actions-ci .*: updated/);
    } finally {
      store.publish(original);
    }
    assert.match(readFileSync(join(dir, SKILL), "utf8"), /Cache npm/);
    assert.match(readFileSync(join(dir, SKILL), "utf8"), /This is step 2 of the skill set/);
    assert.equal((await ss33(["add", CI_REF], { cwd: dir })).code, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "ss33.lock"), "utf8")).skills["github-actions-ci"].set.position, 2);

    const rm = await ss33(["remove", SET_REF], { cwd: dir });
    assert.equal(rm.code, 0, rm.stderr);
    assert.ok(!existsSync(join(dir, "ss33.lock")) && !existsSync(join(dir, SKILL)) && !existsSync(join(dir, VITEST)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e skill sets: a conflict in any step installs nothing; an unavailable step is left out; an unknown set fails", async () => {
  const dir = project();
  try {
    mkdirSync(join(dir, ".claude/skills/github-actions-ci"), { recursive: true });
    writeFileSync(join(dir, SKILL), "our own\n");
    const blocked = await ss33(["add", SET_REF], { cwd: dir });
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /Not overwriting files ss33 doesn't manage: \.claude\/skills\/github-actions-ci\/SKILL\.md .*Nothing was changed/);
    assert.ok(!existsSync(join(dir, VITEST)) && !existsSync(join(dir, "ss33.lock")), "step 1 isn't written either");
    rmSync(join(dir, ".claude"), { recursive: true });

    store.publishSet({ ref: "skill-set/deck-set-9002", title: "Deck Set", steps: [{ ref: "restricted/pptx-creator-1006" }, { ref: "acme/vitest-testing-1002" }] });
    const partial = await ss33(["add", "skill-set/deck-set-9002"], { cwd: dir });
    assert.equal(partial.code, 0, partial.stderr);
    assert.match(partial.stdout, /Installed 1 of 2 skills/);
    assert.match(partial.stdout, /✗ step 1 \(Pptx Creator\) left out: .*isn't available from the Skill Store/);
    assert.match(readFileSync(join(dir, VITEST), "utf8"), /Its steps, in order: 1\. Pptx Creator \(not installed\), 2\. vitest-testing\./);

    const missing = await ss33(["get", "skill-set/nope-1"], { cwd: dir });
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /No such skill set: skill-set\/nope-1/);
  } finally {
    store.unpublish("skill-set/deck-set-9002");
    rmSync(dir, { recursive: true, force: true });
  }
});
