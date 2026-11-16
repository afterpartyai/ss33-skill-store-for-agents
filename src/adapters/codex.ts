/**
 * Codex adapter. Codex's hooks use Claude Code's JSON dialect: UserPromptSubmit gets
 * `{session_id, turn_id, cwd, prompt, model, …}` on stdin and accepts
 * `{systemMessage, hookSpecificOutput: {additionalContext}}` (verified with Codex 0.167, 2026-11-10).
 * The differences that matter are elsewhere: plugin skills are invoked as `$ss33:<skill>`, and
 * installed skills go to `.agents/skills` (see adapters/codex/).
 */
import type { EventDeps } from "../core/events.js";
import { runJsonHook, userPromptSubmitHandler, type HookHandler } from "./hook-json.js";

export const HARNESS = "codex";

export const userPromptSubmit = userPromptSubmitHandler(HARNESS, "$ss33:add");

export const EVENTS: Record<string, HookHandler> = {
  "user-prompt-submit": userPromptSubmit,
};

/** Entry point for `ss33 hook codex <event>`. */
export function runHook(event: string, stdin: string, deps: EventDeps = {}): Promise<string> {
  return runJsonHook(HARNESS, EVENTS, event, stdin, deps);
}
