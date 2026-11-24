/**
 * The `ss33` CLI in-process (`main()` with an output collector), against the fake store over HTTP.
 * e2e-cli.test.ts covers the lifecycle as a child process; this covers every command's output,
 * usage errors, `config` and `doctor`.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { main, parseArgs } from "../src/cli/main.js";
import { writeHookStatus } from "../src/core/config.js";
import { VERSION } from "../src/core/version.js";
import { loadSetFixture, loadSkillFixture } from "../src/fakestore/fixtures.js";
import { startFakeStore, type FakeStore } from "../src/fakestore/server.js";
import { tempDir } from "./helpers.js";

const FIXTURE = join(process.cwd(), "test/fixtures/store/basic.json");
const CI_REF = "acme/github-actions-ci-1001";
const SET_REF = "skill-set/node-ci-quality-set-9001";
let store: FakeStore;

before(async () => {
  store = await startFakeStore({ skills: loadSkillFixture(FIXTURE), sets: loadSetFixture(FIXTURE) });
});
after(() => store.close());

// Each test file runs in its own process, so this file owns process.env.
beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("SS33_") || k.startsWith("CLAUDE")) delete process.env[k];
  const home = tempDir("ss33-cli-home-");
  Object.assign(process.env, { SS33_ENDPOINT: store.url, SS33_CONFIG_DIR: join(home, "cfg"), SS33_STATE_DIR: join(home, "state") });
  store.setFault(undefined);
});

async function run(...argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await main(argv, (s) => lines.push(s) > 0);
  return { code, out: lines.join("\n") };
}

function project(): string {
  const dir = tempDir("ss33-cli-");
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5.6.0" } }));
  return dir;
}

test("cli parseArgs: value flags, --flag=value, booleans, and -- ends the flags", () => {
  assert.deepEqual(parseArgs(["search", "ci", "--limit", "3", "--json", "--area=devops"]), { positional: ["search", "ci"], flags: { limit: "3", json: true, area: "devops" } });
  assert.deepEqual(parseArgs(["add", "x", "--target"]), { positional: ["add", "x"], flags: { target: true } }, "a value flag at the end is a boolean");
  assert.deepEqual(parseArgs(["search", "--", "--not-a-flag", "x"]), { positional: ["search", "--not-a-flag", "x"], flags: {} });
  assert.deepEqual(parseArgs(["--port", "80"], ["port"]).flags, { port: "80" });
});

test("cli: help, version, unknown commands and missing arguments", async () => {
  for (const argv of [[], ["help"]]) {
    const r = await run(...argv);
    assert.equal(r.code, 0);
    assert.match(r.out, /^ss33 \d+\.\d+\.\d+ — Skill Store CLI/);
  }
  assert.deepEqual(await run("version"), { code: 0, out: VERSION });

  const usages: [string[], RegExp][] = [
    [["frobnicate"], /unknown command "frobnicate"/],
    [["search"], /search needs a query/],
    [["search", "  "], /search needs a query/],
    [["get"], /get needs a skill ref/],
    [["add"], /add needs a skill ref/],
    [["remove"], /remove needs a skill name/],
    [["config", "set", "nope", "1"], /unknown config key "nope"\. Keys: apiKey, endpoint/],
    [["config", "set", "endpoint"], /config set endpoint needs a value/],
    [["config", "frob"], /config get \| set/],
    [["config", "set"], /config get \| set/],
  ];
  for (const [argv, re] of usages) {
    const r = await run(...argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.out, re);
    assert.match(r.out, /Run `ss33 help` for usage\.$/);
  }
});

test("cli: a bad --target is an install error, before anything is fetched", async () => {
  const dir = project();
  const before = store.calls.length;
  await assert.rejects(run("add", CI_REF, "--target", "everywhere", "--dir", dir), /--target must be claude, agents or both \(got "everywhere"\)/);
  assert.equal(store.calls.length, before);
});

test("cli search: candidates, unavailable skills, skill sets, the install line, and --json", async () => {
  const dir = project();
  const r = await run("search", "write", "unit", "tests", "with", "vitest", "in", "a", "ci", "pipeline", "--dir", dir, "--limit", "4");
  assert.equal(r.code, 0);
  assert.match(r.out, /• Vitest Testing {2}\(acme\/vitest-testing-1002\)\n {4}Write and run unit tests/);
  assert.match(r.out, /Skill sets \(skills used together for the whole job\):\n• Node CI Quality Set {2}\(skill-set\/node-ci-quality-set-9001\) {2}2 skills, run in order/);
  assert.match(r.out, /Install one with: ss33 add <ref> \(a skill-set\/… ref installs the whole set\)/);
  const sent = store.calls.at(-1)!;
  assert.equal(sent.args?.limit, 4);
  assert.match(String(sent.args?.query), /Project context: .*typescript/);

  const slides = await run("search", "make", "powerpoint", "slides", "--no-context", "--dir", dir);
  assert.match(slides.out, /\(restricted\/pptx-creator-1006\) {2}\[not available from the store: can't be installed\]/);
  assert.doesNotMatch(String(store.calls.at(-1)!.args?.query), /Project context/, "--no-context sends the bare query");

  await run("search", "ci", "--area", "devops", "--tier", "verified", "--no-context");
  assert.equal(store.calls.at(-1)!.args?.area, "devops");
  assert.equal(store.calls.at(-1)!.args?.tier, "verified");

  const json = await run("search", "github", "actions", "ci", "--json", "--no-context");
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.out).candidates[0].ref, CI_REF);
});

test("cli search: no match, rate limited, and the free-tier note", async () => {
  const none = await run("search", "zzz", "qqq", "xylophone", "--no-context");
  assert.equal(none.code, 0);
  assert.match(none.out, /^No matching skills\. No skill in the corpus covers this/);
  assert.doesNotMatch(none.out, /Install one with/);

  store.setFault({ limited: true, times: 1 });
  const limited = await run("search", "github", "actions", "ci", "--no-context");
  assert.equal(limited.code, 0);
  assert.match(limited.out, /^Rate limited: Free-tier limit reached\./);

  const metered = await startFakeStore({ skills: loadSkillFixture(FIXTURE), auth: { keys: ["k"], freeTierPerMinute: 5 } });
  try {
    process.env.SS33_ENDPOINT = metered.url;
    assert.match((await run("search", "github", "actions", "ci", "--no-context")).out, /\n\nFree tier: 4 free searches left/);
  } finally {
    await metered.close();
  }
});

test("cli get: a skill, a skill set (text and --json), supporting files, and what the store can't serve", async () => {
  const skill = await run("get", CI_REF);
  assert.equal(skill.code, 0);
  assert.match(skill.out, /^---\nname: github-actions-ci/);

  const mcp = await run("get", "acme/mcp-builder-1007");
  assert.match(mcp.out, /\(Supporting files aren't in the store: https:\/\/github\.com\/example\/skills\/tree\/0000000\/mcp-builder\)$/);

  const set = await run("get", SET_REF);
  assert.equal(set.code, 0);
  assert.match(set.out, /^Skill set: Node CI Quality Set {2}\(skill-set\/node-ci-quality-set-9001/);
  assert.match(set.out, /2 skills, used in this order:\n {2}1\. Vitest Testing {2}\(acme\/vitest-testing-1002\) {2}\[write the tests; small model\]\n {2}2\. Github Actions CI {2}\(acme\/github-actions-ci-1001\) {2}\[run them in CI; frontier model\]/);
  const setJson = JSON.parse((await run("get", SET_REF, "--json")).out);
  assert.deepEqual(setJson.steps.map((s: { ref: string }) => s.ref), ["acme/vitest-testing-1002", CI_REF]);

  const restricted = await run("get", "restricted/pptx-creator-1006");
  assert.equal(restricted.code, 1);
  assert.match(restricted.out, /The author publishes it here: https:\/\/github\.com\/example\/skills\/blob\/0000000\/pptx-creator\/SKILL\.md$/);
  const missing = await run("get", "nope/nope-1");
  assert.equal(missing.code, 1);
  assert.doesNotMatch(missing.out, /author publishes/);

  store.setFault({ status: 500, times: 1 });
  await assert.rejects(run("get", CI_REF), /Skill Store HTTP 500/, "other store errors reach the top-level handler");
});

test("cli add: dry run, --show, --json, reinstall, conflicts, and unavailable skills", async () => {
  const dir = project();
  const dry = await run("add", CI_REF, "--dir", dir, "--dry-run", "--show");
  assert.equal(dry.code, 0);
  assert.match(dry.out, /^Would install "github-actions-ci" from acme\/github-actions-ci-1001\n/);
  assert.match(dry.out, /→ \.claude\/skills\/github-actions-ci\/SKILL\.md\n {2}sha256 [0-9a-f]{16}…/);
  assert.match(dry.out, /----- SKILL\.md -----\n---\nname: github-actions-ci/);
  assert.doesNotMatch(dry.out, /picks up new skills/, "a dry run has no pick-up note");
  assert.throws(() => readFileSync(join(dir, "ss33.lock")), "a dry run writes nothing");

  const both = await run("add", CI_REF, "--dir", dir, "--target", "both");
  assert.match(both.out, /^Installed "github-actions-ci"/);
  assert.match(both.out, /Claude Code picks up new skills automatically; it appears as "github-actions-ci"\.\nCodex, Copilot, Cursor and other agents that read \.agents\/skills\/ load it/);
  assert.match((await run("add", CI_REF, "--dir", dir)).out, /^Reinstalled "github-actions-ci"/);

  const json = JSON.parse((await run("add", "acme/vitest-testing-1002", "--dir", dir, "--json", "--target", "agents")).out);
  assert.deepEqual(json.paths, [".agents/skills/vitest-testing/SKILL.md"]);
  assert.equal(json.content, undefined, "content only with --show");
  assert.match(JSON.parse((await run("add", "acme/vitest-testing-1002", "--dir", dir, "--json", "--show", "--dry-run")).out).content, /^---\n/);

  mkdirSync(join(dir, ".claude/skills/postgres-migrations"), { recursive: true });
  writeFileSync(join(dir, ".claude/skills/postgres-migrations/SKILL.md"), "mine\n");
  const conflict = await run("add", "acme/postgres-migrations-1003", "--dir", dir, "--dry-run");
  assert.match(conflict.out, /⚠ existing files not managed by ss33: \.claude\/skills\/postgres-migrations\/SKILL\.md \(needs --force\)/);

  const mcp = await run("add", "acme/mcp-builder-1007", "--dir", dir, "--dry-run");
  assert.match(mcp.out, /⚠ the store doesn't carry this skill's supporting files; the author's folder: https:\/\/github\.com\/example\/skills\/tree\/0000000\/mcp-builder/);

  const restricted = await run("add", "restricted/pptx-creator-1006", "--dir", dir);
  assert.equal(restricted.code, 1);
  assert.match(restricted.out, /Nothing was installed\.\nThe author publishes it here: .*\nCheck its licence/);
  const restrictedJson = JSON.parse((await run("add", "restricted/pptx-creator-1006", "--dir", dir, "--json")).out);
  assert.deepEqual([restrictedJson.available, restrictedJson.sourceUrl], [false, "https://github.com/example/skills/blob/0000000/pptx-creator/SKILL.md"]);

  await assert.rejects(run("add", "nope/nope-1", "--dir", dir), /no such skill/i, "other errors reach the top-level handler");
});

test("cli add skill-set: dry run, --json, --show, and the pick-up note for every step", async () => {
  const dir = project();
  const dry = await run("add", SET_REF, "--dir", dir, "--dry-run");
  assert.equal(dry.code, 0);
  assert.match(dry.out, /Would install 2 of 2 skills:\n1\. "vitest-testing" from acme\/vitest-testing-1002\n/);
  assert.doesNotMatch(dry.out, /remove them all/);

  const json = JSON.parse((await run("add", SET_REF, "--dir", dir, "--json", "--dry-run")).out);
  assert.equal(json.set.ref, SET_REF);
  assert.equal(json.plans.length, 2);
  assert.equal(json.plans[0].content, undefined);
  assert.match(JSON.parse((await run("add", SET_REF, "--dir", dir, "--json", "--dry-run", "--show")).out).plans[1].content, /^---\n/);

  const real = await run("add", SET_REF, "--dir", dir, "--show", "--target", "agents");
  assert.match(real.out, /----- 1\. vitest-testing\/SKILL\.md -----\n---/);
  assert.match(real.out, /remove them all with `ss33 remove skill-set\/node-ci-quality-set-9001`\.\nCodex, Copilot, Cursor and other agents that read \.agents\/skills\/ load them as "vitest-testing", "github-actions-ci" \(in Codex, Copilot or Cursor, start a new session if they don't appear/);
  assert.match((await run("add", SET_REF, "--dir", dir, "--target", "agents")).out, /"vitest-testing" from acme\/vitest-testing-1002 \(already installed; reinstalled\)/);

  const list = await run("list", "--dir", dir);
  assert.match(list.out, /• vitest-testing {2}\(acme\/vitest-testing-1002, installed \d{4}-\d\d-\d\d\)\n {4}step 1 of skill set "Node CI Quality Set" \(skill-set\/node-ci-quality-set-9001\)/);

  const removed = await run("remove", SET_REF, "--dir", dir);
  assert.equal(removed.code, 0);
  assert.match(removed.out, /Removed "vitest-testing" .*\nRemoved "github-actions-ci"/);
  await assert.rejects(run("remove", SET_REF, "--dir", dir), /No skills from skill-set\/node-ci-quality-set-9001 in ss33\.lock/);
});

test("cli update, list and remove: empty project, --json, update states and errors", async () => {
  const dir = project();
  assert.deepEqual(await run("update", "--dir", dir), { code: 0, out: "No skills installed (nothing in ss33.lock)." });
  assert.deepEqual(await run("list", "--dir", dir), { code: 0, out: "No skills installed from the Skill Store in this project." });
  assert.deepEqual(JSON.parse((await run("list", "--dir", dir, "--json")).out), []);

  await run("add", CI_REF, "--dir", dir);
  assert.match((await run("update", "--dir", dir)).out, /^• github-actions-ci \(acme\/github-actions-ci-1001\): up to date$/);
  assert.equal(JSON.parse((await run("update", "--dir", dir, "--json")).out)[0].state, "unchanged");

  const ci = loadSkillFixture(FIXTURE).find((s) => s.ref === CI_REF)!;
  store.publish({ ...ci, content: ci.content!.replace("# ", "# Updated: ") });
  try {
    const available = await run("update", "--dir", dir);
    assert.equal(available.code, 0);
    assert.match(available.out, /update available \(run `ss33 update --yes` to apply\)\n {4}/);

    writeFileSync(join(dir, ".claude/skills/github-actions-ci/SKILL.md"), "local edit\n");
    assert.match((await run("update", "--dir", dir, "--yes")).out, /has local edits; not updated \(use --force to overwrite\)/);
    assert.match((await run("update", "--dir", dir, "--yes", "--force")).out, /: updated\n/);
  } finally {
    store.publish(ci);
  }

  const unknown = await run("update", "nope", "--dir", dir);
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /• nope \(\?\): error: not in ss33\.lock/);

  const listed = await run("list", "--dir", dir);
  assert.match(listed.out, /✓ {2}\.claude\/skills\/github-actions-ci\/SKILL\.md/);
  writeFileSync(join(dir, ".claude/skills/github-actions-ci/SKILL.md"), "edited again\n");
  assert.match((await run("list", "--dir", dir)).out, /✎ modified {2}\.claude/);

  assert.match((await run("remove", "github-actions-ci", "--dir", dir)).out, /^Removed "github-actions-ci" \(acme\/github-actions-ci-1001\) from ss33\.lock: \.claude\/skills\/github-actions-ci\/SKILL\.md$/);
  await assert.rejects(run("remove", "github-actions-ci", "--dir", dir));
});

test("cli fingerprint: the summary, --json, and an empty project", async () => {
  const dir = project();
  assert.match((await run("fingerprint", "--dir", dir)).out, /languages: .*typescript/);
  assert.ok(JSON.parse((await run("fingerprint", "--dir", dir, "--json")).out).languages.includes("typescript"));
  const empty = tempDir("ss33-cli-empty-");
  mkdirSync(join(empty, ".git"));
  assert.deepEqual(await run("fingerprint", "--dir", empty), { code: 0, out: "(nothing detected)" });
});

test("cli config: path, get (redacted), set, unset, and the Claude Code note", async () => {
  const path = (await run("config", "path")).out;
  assert.equal(path, join(process.env.SS33_CONFIG_DIR!, "config.json"));

  assert.match((await run("config", "set", "apiKey", "sk-secret-123456789")).out, /^Set apiKey in /);
  assert.match((await run("config", "set", "match.minOverlap", "3")).out, /^Set match\.minOverlap = 3 in /);
  const got = await run("config", "get");
  assert.equal(got.code, 0);
  const shown = JSON.parse(got.out);
  assert.equal(shown.apiKey, "sk-secre…(set)");
  assert.equal(shown.match.minOverlap, 3);
  assert.equal(shown.sources.apiKey, "config file");
  assert.ok(!got.out.includes("sk-secret-123456789"), "the key is never printed");
  assert.deepEqual(JSON.parse((await run("config")).out).match, shown.match, "bare `config` is `config get`");

  await assert.rejects(run("config", "set", "match.minOverlap", "-1"), /non-negative integer/);
  assert.deepEqual(await run("config", "unset", "apiKey"), { code: 0, out: "Unset apiKey" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).apiKey, undefined);

  process.env.CLAUDECODE = "1";
  assert.match((await run("config", "get")).out, /\n\nNote: this command runs inside Claude Code, which doesn't pass plugin settings/);
  process.env.CLAUDE_PLUGIN_OPTION_PROMPT_MATCHING = "true";
  assert.doesNotMatch((await run("config", "get")).out, /Note:/, "no note when the plugin options are visible");
});

test("cli doctor: offline, with and without a hook record, and the mismatches it explains", async () => {
  const offline = await run("doctor", "--offline");
  assert.equal(offline.code, 0);
  assert.match(offline.out, /^ss33 \S+\nCommands \(\/ss33:\*, the ss33 CLI\):\n {2}API key set: no \(default\)\n {2}prompt matching: off \(default\)\nPrompt-matching hook: no record yet/);
  assert.match(offline.out, /\nNo problems found\.$/);
  assert.doesNotMatch(offline.out, /Store:/);

  writeHookStatus({ seenAt: "2026-11-24T10:00:00.000Z", harness: "claude-code", matchEnabled: true, matchSource: "plugin option", apiKeySet: true, apiKeySource: "plugin option" });
  process.env.CLAUDECODE = "1";
  const mismatch = await run("doctor", "--offline");
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.out, /Prompt-matching hook \(as of its last run, 2026-11-24T10:00:00\.000Z\):\n {2}API key set: yes \(plugin option\)\n {2}prompt matching: on \(plugin option\)/);
  assert.match(mismatch.out, /Problems:\n {2}• The hook has an API key .* but commands don't/);
  assert.match(mismatch.out, /• Prompt matching is on for the hook \(which is what counts\)/);
});

test("cli doctor: the store's answer (accepted, free tier, rate limited, rejected key, unreachable)", async () => {
  assert.match((await run("doctor")).out, /Store: reachable, free tier \(no key\)\.\n\nNo problems found\./);

  process.env.SS33_API_KEY = "sk-test";
  assert.match((await run("doctor")).out, /Store: reachable, API key accepted\./);

  store.setFault({ limited: true, times: 1 });
  assert.match((await run("doctor")).out, /Store: reachable, but rate limited right now\./);
  delete process.env.SS33_API_KEY;
  store.setFault({ limited: true, times: 1 });
  assert.match((await run("doctor")).out, /rate limited right now \(free tier\)\./);

  store.setFault({ status: 401, times: 1 });
  process.env.SS33_API_KEY = "sk-revoked";
  const rejected = await run("doctor");
  assert.equal(rejected.code, 1);
  assert.match(rejected.out, /Store: Skill Store rejected the API key/);
  assert.match(rejected.out, /• The store rejected the API key\. Create a new one/);

  process.env.SS33_ENDPOINT = "http://127.0.0.1:9/mcp";
  const down = await run("doctor");
  assert.equal(down.code, 1);
  assert.match(down.out, /• The store can't be reached from here/);

  // A store that ignores the key sent (says "free tier" anyway).
  const ignoring = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id } = JSON.parse(body) as { id: number };
      const data = { candidates: [], found: false, store_note: "Free tier: 4 free searches left this minute from this address." };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } }));
    });
  });
  await new Promise<void>((r) => ignoring.listen(0, "127.0.0.1", r));
  try {
    process.env.SS33_ENDPOINT = `http://127.0.0.1:${(ignoring.address() as AddressInfo).port}/mcp`;
    const ignored = await run("doctor");
    assert.equal(ignored.code, 1);
    assert.match(ignored.out, /Store: reachable, but it treated the request as free tier even though a key was sent\./);
    assert.match(ignored.out, /• The store didn't apply your API key\./);
  } finally {
    ignoring.close();
  }
});

test("cli hook: an unknown harness or a missing event exits 0 with no output", async () => {
  assert.deepEqual(await run("hook"), { code: 0, out: "" });
  assert.deepEqual(await run("hook", "vscode", "user-prompt-submit"), { code: 0, out: "" });
  assert.deepEqual(await run("hook", "claude-code"), { code: 0, out: "" });
});
