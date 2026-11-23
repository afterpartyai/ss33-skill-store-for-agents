/**
 * GitHub Copilot adapter (Copilot CLI; VS Code agent plugins read the same hooks file). The plugin uses Copilot's own
 * hook format (`userPromptSubmitted`), which gets `{sessionId, timestamp, cwd, prompt}` on stdin and takes a top-level
 * `{"additionalContext"}` on stdout (verified with Copilot CLI 1.0.114, 2026-11-23). Claude Code's `hookSpecificOutput`
 * is ignored there, and so is `systemMessage`: the user sees nothing, so the hint asks the model to pass a fitting
 * suggestion on (`noticeShown: false`). snake_case input (Claude-style hook names) is accepted too.
 */
import { stateDir } from "../core/config.js";
import { onPromptSubmitted, type EventDeps } from "../core/events.js";
import { debugLog } from "../core/state.js";

export const HARNESS = "copilot";

/** Plugin skills are namespaced `/<plugin>:<skill>` in Copilot, the same as in Claude Code. */
export const ADD_COMMAND = "/ss33:add";

/**
 * Copilot expands a skill slash command (`/ss33:add …`, `/vitest …`) before the prompt hook sees it, starting with this
 * sentence. The user already picked a skill, so it's mapped back to `/<skill>`, which the core skips as a slash command.
 */
const SKILL_INVOCATION = /^\s*The user explicitly invoked the "([^"]+)" skill/;

export function promptForMatching(prompt: string): string {
  const m = SKILL_INVOCATION.exec(prompt);
  return m ? (m[1]!.startsWith("/") ? m[1]! : `/${m[1]}`) : prompt;
}

export interface UserPromptSubmittedInput {
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
}

export interface CopilotHookOutput {
  additionalContext: string;
}

export async function userPromptSubmitted(stdin: string, deps: EventDeps = {}): Promise<CopilotHookOutput | undefined> {
  let input: UserPromptSubmittedInput;
  try {
    input = JSON.parse(stdin) as UserPromptSubmittedInput;
  } catch {
    return undefined;
  }
  if (typeof input.prompt !== "string") return undefined;
  const sessionId = input.sessionId ?? input.session_id;
  const { context } = await onPromptSubmitted(
    {
      prompt: promptForMatching(input.prompt),
      cwd: input.cwd || process.cwd(),
      ...(sessionId ? { sessionId } : {}),
      harness: HARNESS,
      addCommand: ADD_COMMAND,
      noticeShown: false,
    },
    deps,
  );
  return context ? { additionalContext: context } : undefined;
}

const EVENTS: Record<string, (stdin: string, deps?: EventDeps) => Promise<CopilotHookOutput | undefined>> = {
  "user-prompt-submitted": userPromptSubmitted,
};

/** Entry point for `ss33 hook copilot <event>`. Always resolves; errors go to the debug log only. */
export async function runHook(event: string, stdin: string, deps: EventDeps = {}): Promise<string> {
  const handler = EVENTS[event];
  if (!handler) return "";
  try {
    const out = await handler(stdin, deps);
    return out ? JSON.stringify(out) : "";
  } catch (err) {
    debugLog(stateDir(deps.env ?? process.env), `[${HARNESS}] ${event} failed: ${(err as Error)?.message ?? err}`);
    return "";
  }
}
