/**
 * Claude Code adapter: hook stdin JSON → core events → hook stdout JSON.
 * Hooks must never break the user's session, so every failure exits 0 with no output.
 */
import type { EventDeps } from "../core/events.js";
import { runJsonHook, userPromptSubmitHandler, type HookHandler } from "./hook-json.js";

export type { HookOutput } from "./hook-json.js";

export const HARNESS = "claude-code";

export const userPromptSubmit = userPromptSubmitHandler(HARNESS, "/ss33:add");

export const EVENTS: Record<string, HookHandler> = {
  "user-prompt-submit": userPromptSubmit,
};

/** Entry point for `ss33 hook claude-code <event>`. */
export function runHook(event: string, stdin: string, deps: EventDeps = {}): Promise<string> {
  return runJsonHook(HARNESS, EVENTS, event, stdin, deps);
}
