/**
 * Shared plumbing for harnesses whose hooks speak Claude Code's JSON dialect (Claude Code, Codex):
 * stdin JSON → core event → `{systemMessage, hookSpecificOutput}` on stdout.
 * Hooks must never break the user's session, so every failure resolves to "" (no output).
 */
import { stateDir } from "../core/config.js";
import { onPromptSubmitted, type EventDeps } from "../core/events.js";
import { debugLog } from "../core/state.js";

export interface UserPromptSubmitInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  hook_event_name?: string;
}

export interface HookOutput {
  /** Shown to the user by the harness, so surfacing a suggestion doesn't depend on the model mentioning it. */
  systemMessage?: string;
  hookSpecificOutput: { hookEventName: "UserPromptSubmit"; additionalContext: string };
}

export type HookHandler = (stdin: string, deps?: EventDeps) => Promise<HookOutput | undefined>;

export function userPromptSubmitHandler(harness: string, addCommand: string): HookHandler {
  return async (stdin, deps = {}) => {
    let input: UserPromptSubmitInput;
    try {
      input = JSON.parse(stdin) as UserPromptSubmitInput;
    } catch {
      return undefined;
    }
    if (typeof input.prompt !== "string") return undefined;
    const { context, notice } = await onPromptSubmitted(
      {
        prompt: input.prompt,
        cwd: input.cwd || process.cwd(),
        ...(input.session_id ? { sessionId: input.session_id } : {}),
        harness,
        addCommand,
      },
      deps,
    );
    if (!context) return undefined;
    return { ...(notice ? { systemMessage: notice } : {}), hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } };
  };
}

/** Runs one hook event. Always resolves; errors go to the debug log only. */
export async function runJsonHook(harness: string, events: Record<string, HookHandler>, event: string, stdin: string, deps: EventDeps = {}): Promise<string> {
  const handler = events[event];
  if (!handler) return "";
  try {
    const out = await handler(stdin, deps);
    return out ? JSON.stringify(out) : "";
  } catch (err) {
    debugLog(stateDir(deps.env ?? process.env), `[${harness}] ${event} failed: ${(err as Error)?.message ?? err}`);
    return "";
  }
}
