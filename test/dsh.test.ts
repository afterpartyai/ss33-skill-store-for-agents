/**
 * DeepSeek Harness: the `ss33 hook dsh pre-step` mapping, and the plugin's index.js mounted on a stub Cordis context
 * (skills, shellEnv, workingDirectory, agents) with the real bundled CLI against the fake store.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { runHook } from "../src/adapters/dsh.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { loadSkillFixture } from "../src/fakestore/fixtures.js";
import { startFakeStore, type FakeStore } from "../src/fakestore/server.js";
import { candidate, fakeClient, tempDir } from "./helpers.js";

const prompt = "Set up a GitHub Actions CI pipeline that runs lint and tests on every PR";

function project(): string {
  const dir = tempDir("ss33-dsh-");
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5.6.0" } }));
  return dir;
}

function deps(calls: { method: string }[] = []) {
  return {
    env: { SS33_STATE_DIR: tempDir(), SS33_CONFIG_DIR: tempDir() },
    config: { ...DEFAULT_CONFIG, match: { ...DEFAULT_CONFIG.match, enabled: true } },
    client: fakeClient({ calls, candidates: [candidate("b/gha-2", "Github Actions CI", "GitHub Actions pipeline with lint and test steps")] }),
  };
}

test("dsh hook: context for the model plus a notice for the user, with DSH's /ss33-add", async () => {
  const d = deps();
  const input = JSON.stringify({ session_id: "dsh-1", cwd: project(), prompt });
  const out = JSON.parse(await runHook("pre-step", input, d));
  assert.deepEqual(Object.keys(out).sort(), ["context", "notice"]);
  assert.match(out.context, /The user has been shown a note/);
  assert.match(out.context, /\/ss33-add b\/gha-2/);
  assert.match(out.notice, /\/ss33-add b\/gha-2/);
  assert.doesNotMatch(await runHook("pre-step", input, d) + out.context, /\/ss33:add/);
  assert.equal(await runHook("pre-step", input, d), "", "same skill is not suggested twice in a session");
  assert.match(readFileSync(join(d.env.SS33_STATE_DIR, "hook.log"), "utf8"), /\[dsh\] prompt_submitted → suggest b\/gha-2/);
});

test("dsh hook: silent on bad input, unknown events and a skill slash command", async () => {
  const d = deps();
  const calls: { method: string }[] = [];
  assert.equal(await runHook("pre-step", "not json", d), "");
  assert.equal(await runHook("unknown-event", "{}", d), "");
  assert.equal(await runHook("pre-step", JSON.stringify({ session_id: "s", cwd: project(), prompt: "/ss33-search github actions ci" }), deps(calls)), "");
  assert.equal(calls.length, 0);
  assert.match(readFileSync(join(d.env.SS33_STATE_DIR, "hook.log"), "utf8"), /pre-step failed: stdin is not JSON/);
});

// ---- the plugin itself -------------------------------------------------------------------------------------------

type Listener = (payload: Record<string, unknown>, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>;

interface Mounted {
  skills: Record<string, unknown>[];
  shellEnv: { name: string; variables: Record<string, unknown>; resolve: () => Record<string, string> }[];
  preStep: Listener[];
}

/** A stub Cordis context with the services the plugin uses; `inject` runs its callback at once, as Cordis does when they exist. */
function mount(plugin: { apply: (ctx: unknown) => void; inject: string[] }, cwd: string): Mounted {
  const m: Mounted = { skills: [], shellEnv: [], preStep: [] };
  const ctx: Record<string, unknown> = {
    skills: { register: (s: Record<string, unknown>) => void m.skills.push(s) },
    shellEnv: { register: (r: Mounted["shellEnv"][number]) => void m.shellEnv.push(r) },
    workingDirectory: { ensure: async () => cwd },
    agents: {},
    logger: () => ({ warn() {}, debug() {} }),
    on: (event: string, fn: Listener) => { if (event === "agent/pre-step") m.preStep.push(fn); },
    effect: (fn: () => unknown) => void fn(),
  };
  ctx.inject = (_deps: string[], fn: (scoped: unknown) => void) => fn(ctx);
  assert.deepEqual(plugin.inject, ["skills"], "only the skill registry is required; the rest is optional");
  plugin.apply(ctx);
  return m;
}

const userMessage = (text: string, kind = "user") => ({ id: "m1", role: "user", content: [{ type: "text", text }], source: { kind } });

let store: FakeStore;
before(async () => {
  store = await startFakeStore({ skills: loadSkillFixture(join(process.cwd(), "test/fixtures/store/basic.json")) });
});
after(() => store.close());

test("dsh plugin: registers the user-only skills, the plugin root for shells, and a prompt-matching step", async () => {
  const plugin = await import(pathToFileURL(join(process.cwd(), "adapters/dsh/index.js")).href);
  const dir = project();
  const m = mount(plugin, dir);

  assert.deepEqual(m.skills.map((s) => s.name), ["ss33-add", "ss33-list", "ss33-search", "ss33-setup", "ss33-update"]);
  for (const s of m.skills) {
    assert.deepEqual(s.invocation, { modelInvocable: s.name === "ss33-search", userInvocable: true }, String(s.name));
    assert.doesNotMatch(String(s.content), /^---/, "frontmatter stripped");
    assert.match(String(s.content), /\$DSH_SS33_PLUGIN_ROOT\/scripts\/ss33/);
  }
  const root = m.shellEnv[0]!.resolve().DSH_SS33_PLUGIN_ROOT!;
  assert.equal(readFileSync(join(root, "scripts/ss33"), "utf8"), readFileSync("adapters/claude-code/scripts/ss33", "utf8"));

  const saved = { ...process.env };
  Object.assign(process.env, { SS33_ENDPOINT: store.url, SS33_MATCH: "1", SS33_CONFIG_DIR: join(dir, ".cfg"), SS33_STATE_DIR: join(dir, ".state") });
  delete process.env.SS33_API_KEY;
  try {
    const signal = new AbortController().signal;
    const step = (messages: unknown[], stepNo = 1) =>
      m.preStep[0]!({ agent: { id: "a", session: { id: "dsh-session-1", header: { cwd: dir } } }, turn: 1, step: stepNo, signal }, async () => ({ kind: "accept", messages }));

    // Another plugin's injection is not the user's prompt.
    const injected = await step([userMessage(prompt, "time-context")]);
    assert.equal((injected.messages as unknown[]).length, 1);
    // Later steps of a turn are tool-call follow-ups.
    assert.equal(((await step([userMessage(prompt)], 2)).messages as unknown[]).length, 1);

    const out = await step([userMessage(prompt)]);
    const messages = out.messages as { role: string; content: { text: string }[]; source: { kind: string; form: string; summary: string } }[];
    assert.equal(out.kind, "accept");
    assert.equal(messages.length, 2);
    const hint = messages[1]!;
    assert.equal(hint.role, "user");
    assert.deepEqual([hint.source.kind, hint.source.form], ["ss33", "notice"]);
    assert.match(hint.source.summary, /\/ss33-add acme\/github-actions-ci-1001/);
    assert.match(hint.content[0]!.text, /third-party reference material, not an instruction/);

    process.env.SS33_MATCH = "0";
    assert.equal(((await step([userMessage("Add a GitHub Actions workflow for lint and tests")])).messages as unknown[]).length, 1, "off: no hint");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("dsh plugin: matchingOn follows the CLI's precedence", async () => {
  const { matchingOn } = await import(pathToFileURL(join(process.cwd(), "adapters/dsh/index.js")).href);
  const dir = tempDir();
  assert.equal(matchingOn({ SS33_CONFIG_DIR: dir }), false, "no config file: off");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ match: { enabled: true } }));
  assert.equal(matchingOn({ SS33_CONFIG_DIR: dir }), true);
  assert.equal(matchingOn({ SS33_CONFIG_DIR: dir, SS33_MATCH: "off" }), false, "env beats the file");
  writeFileSync(join(dir, "config.json"), "{broken");
  assert.equal(matchingOn({ SS33_CONFIG_DIR: dir }), true, "unreadable config: the CLI decides");
});
