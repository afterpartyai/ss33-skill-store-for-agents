import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promptForMatching, runHook } from "../src/adapters/copilot.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { candidate, fakeClient, tempDir } from "./helpers.js";

const prompt = "Set up a GitHub Actions CI pipeline that runs lint and tests on every PR";

/** Copilot's own hook format: camelCase, as `userPromptSubmitted` sends it (Copilot CLI 1.0.114). */
function input(p: string, session = "cop-1", cwd = tempDir()): string {
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return JSON.stringify({ sessionId: session, timestamp: 1795451273911, cwd, prompt: p });
}

function deps(calls: { method: string }[] = []) {
  return {
    env: { SS33_STATE_DIR: tempDir(), SS33_CONFIG_DIR: tempDir() },
    config: { ...DEFAULT_CONFIG, match: { ...DEFAULT_CONFIG.match, enabled: true } },
    client: fakeClient({ calls, candidates: [candidate("b/gha-2", "Github Actions CI", "GitHub Actions pipeline with lint and test steps")] }),
  };
}

test("copilot hook: top-level additionalContext that asks the model to pass the suggestion on", async () => {
  const d = deps();
  const out = JSON.parse(await runHook("user-prompt-submitted", input(prompt), d));
  // Copilot ignores hookSpecificOutput and systemMessage, so only additionalContext is sent.
  assert.deepEqual(Object.keys(out), ["additionalContext"]);
  assert.match(out.additionalContext, /install it with \/ss33:add b\/gha-2\./);
  assert.match(out.additionalContext, /user can't see this note/);
  assert.doesNotMatch(out.additionalContext, /has been shown/);
  assert.equal(await runHook("user-prompt-submitted", input(prompt), d), "", "same skill is not suggested twice in a session");
  assert.match(readFileSync(join(d.env.SS33_STATE_DIR, "hook.log"), "utf8"), /\[copilot\] prompt_submitted → suggest b\/gha-2/);
});

test("copilot hook: accepts the snake_case payload of Claude-style hook names", async () => {
  const cwd = tempDir();
  mkdirSync(join(cwd, ".git"));
  const out = await runHook("user-prompt-submitted", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd, prompt }), deps());
  assert.match(JSON.parse(out).additionalContext, /b\/gha-2/);
});

test("copilot hook: a skill slash command, which Copilot expands before the hook, is skipped", async () => {
  const expanded = 'The user explicitly invoked the "/ss33:search" skill. Follow its instructions now.\n\n<skill-context name="search">set up github actions ci for lint and tests</skill-context>';
  assert.equal(promptForMatching(expanded), "/ss33:search");
  assert.equal(promptForMatching('The user explicitly invoked the "vitest" skill.'), "/vitest");
  assert.equal(promptForMatching(prompt), prompt);
  const calls: { method: string }[] = [];
  assert.equal(await runHook("user-prompt-submitted", input(expanded), deps(calls)), "");
  assert.equal(calls.length, 0, "no search for a skill the user already picked");
});

test("copilot hook: silent when disabled, on bad input, unknown events and store errors", async () => {
  const d = deps();
  const calls: { method: string }[] = [];
  const off = { ...d, config: { ...DEFAULT_CONFIG, match: { ...DEFAULT_CONFIG.match, enabled: false } }, client: fakeClient({ calls }) };
  assert.equal(await runHook("user-prompt-submitted", input(prompt), off), "");
  assert.equal(calls.length, 0, "no network call when matching is off");
  assert.equal(await runHook("user-prompt-submitted", "not json", d), "");
  assert.equal(await runHook("unknown-event", "{}", d), "");
  assert.equal(await runHook("user-prompt-submitted", input(prompt), { ...d, client: fakeClient({ status: 401 }) }), "");
  assert.match(readFileSync(join(d.env.SS33_STATE_DIR, "hook.log"), "utf8"), /failed: Skill Store rejected the API key/);
  assert.match(readFileSync(join(d.env.SS33_STATE_DIR, "hook.log"), "utf8"), /user-prompt-submitted failed: stdin is not JSON/);
});
