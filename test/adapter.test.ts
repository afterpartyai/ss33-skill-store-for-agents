import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runHook } from "../src/adapters/claude-code.js";
import { runHook as runCodexHook } from "../src/adapters/codex.js";
import { DEFAULT_CONFIG, readHookStatus } from "../src/core/config.js";
import { candidate, fakeClient, tempDir } from "./helpers.js";

const prompt = "Set up a GitHub Actions CI pipeline that runs lint and tests on every PR";

function input(p: string, session = "sess-1", cwd = tempDir()): string {
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return JSON.stringify({ session_id: session, cwd, hook_event_name: "UserPromptSubmit", prompt: p });
}

test("claude-code hook: injects additionalContext once per skill per session", async () => {
  const env = { SS33_STATE_DIR: tempDir(), SS33_CONFIG_DIR: tempDir() };
  const calls: { method: string }[] = [];
  const deps = {
    env,
    config: { ...DEFAULT_CONFIG, match: { ...DEFAULT_CONFIG.match, enabled: true } },
    client: fakeClient({ calls, candidates: [candidate("b/gha-2", "Github Actions CI", "GitHub Actions pipeline with lint and test steps")] }),
  };
  const out = JSON.parse(await runHook("user-prompt-submit", input(prompt), deps));
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /b\/gha-2/);
  assert.match(out.systemMessage, /\/ss33:add b\/gha-2/, "the user sees the suggestion directly");
  assert.match(out.hookSpecificOutput.additionalContext, /user has been shown/);
  assert.equal(await runHook("user-prompt-submit", input(prompt), deps), "", "same skill is not suggested twice in a session");
  assert.match(readFileSync(join(env.SS33_STATE_DIR, "hook.log"), "utf8"), /suggest b\/gha-2/);
  const status = readHookStatus(env);
  assert.equal(status?.matchEnabled, true, "the hook records what it saw, for `ss33 doctor`");
  assert.equal(status?.apiKeySet, false);
});

test("claude-code hook: silent when disabled, on bad input, and on store errors", async () => {
  const env = { SS33_STATE_DIR: tempDir(), SS33_CONFIG_DIR: tempDir() };
  const calls: { method: string }[] = [];
  const disabled = { env, config: { ...DEFAULT_CONFIG, match: { ...DEFAULT_CONFIG.match, enabled: false } }, client: fakeClient({ calls }) };
  assert.equal(await runHook("user-prompt-submit", input(prompt), disabled), "");
  assert.equal(calls.length, 0, "no network call when matching is off");

  const enabled = { ...DEFAULT_CONFIG, match: { ...DEFAULT_CONFIG.match, enabled: true } };
  assert.equal(await runHook("user-prompt-submit", "not json", { env, config: enabled }), "");
  assert.equal(await runHook("unknown-event", "{}", { env, config: enabled }), "");
  assert.equal(await runHook("user-prompt-submit", input(prompt), { env, config: enabled, client: fakeClient({ status: 401 }) }), "");
  assert.match(readFileSync(join(env.SS33_STATE_DIR, "hook.log"), "utf8"), /failed: Skill Store rejected the API key/);
});

test("codex hook: same decision as Claude Code, with Codex's install command", async () => {
  const env = { SS33_STATE_DIR: tempDir(), SS33_CONFIG_DIR: tempDir() };
  const deps = {
    env,
    config: { ...DEFAULT_CONFIG, match: { ...DEFAULT_CONFIG.match, enabled: true } },
    client: fakeClient({ calls: [], candidates: [candidate("b/gha-2", "Github Actions CI", "GitHub Actions pipeline with lint and test steps")] }),
  };
  const out = JSON.parse(await runCodexHook("user-prompt-submit", input(prompt, "codex-sess"), deps));
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /install it with \$ss33:add b\/gha-2\./);
  assert.match(out.systemMessage, /\$ss33:add b\/gha-2/);
  assert.match(readFileSync(join(env.SS33_STATE_DIR, "hook.log"), "utf8"), /\[codex\] prompt_submitted → suggest b\/gha-2/);
  assert.equal(readHookStatus(env)?.harness, "codex");
  assert.equal(await runCodexHook("unknown-event", "{}", deps), "");
  assert.equal(await runCodexHook("user-prompt-submit", "not json", deps), "");
});
