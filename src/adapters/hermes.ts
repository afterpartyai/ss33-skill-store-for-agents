/**
 * Hermes Agent adapter. Hermes has no shell-command hooks that a plugin can ship, so the plugin's
 * Python shim (adapters/hermes/__init__.py) registers a `pre_llm_call` hook and pipes this JSON to
 * `ss33 hook hermes pre-llm-call`:
 *
 *   stdin  {session_id, cwd, prompt, surface}   cwd = ctx.session_cwd(), surface = ctx.session_surface()
 *   stdout {context, notice}                    or nothing
 *
 * The shim returns `{"context": context}` to Hermes (appended to the turn's user message) and shows
 * `notice` with `ctx.post_message`. Unlike Claude Code and Codex, Hermes serves chat apps too:
 * those prompts, and sessions outside a project, are skipped (see core/events.ts).
 */
import { stateDir } from "../core/config.js";
import { onPromptSubmitted, type EventDeps } from "../core/events.js";
import { debugLog } from "../core/state.js";

export const HARNESS = "hermes";

/** Plugin skills are slash commands named `/<plugin>:<skill>` in Hermes, the same as in Claude Code. */
export const ADD_COMMAND = "/ss33:add";

/**
 * Hermes expands a skill slash command (`/ss33:add …`, `/vitest …`) into the skill's body before
 * `pre_llm_call` sees it, always starting with this note (agent/skill_commands.py). The user already
 * picked a skill, so it's mapped back to `/<skill>`, which the core skips as a slash command.
 */
const SKILL_INVOCATION = /^\s*\[IMPORTANT: The user has invoked the (?:"([^"]+)" )?/;

export function promptForMatching(prompt: string): string {
  const m = SKILL_INVOCATION.exec(prompt);
  return m ? `/${m[1] ?? "skill"}` : prompt;
}

export interface PreLlmCallInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  surface?: string;
}

export interface HermesHookOutput {
  context: string;
  notice?: string;
}

export async function preLlmCall(stdin: string, deps: EventDeps = {}): Promise<HermesHookOutput | undefined> {
  let input: PreLlmCallInput;
  try {
    input = JSON.parse(stdin) as PreLlmCallInput;
  } catch {
    return undefined;
  }
  if (typeof input.prompt !== "string") return undefined;
  const { context, notice } = await onPromptSubmitted(
    {
      prompt: promptForMatching(input.prompt),
      // No fallback to process.cwd(): in Hermes that is the gateway's directory, not the session's.
      cwd: typeof input.cwd === "string" ? input.cwd : "",
      ...(input.session_id ? { sessionId: input.session_id } : {}),
      harness: HARNESS,
      addCommand: ADD_COMMAND,
      surface: typeof input.surface === "string" ? input.surface : "",
      requireProject: true,
    },
    deps,
  );
  if (!context) return undefined;
  return { context, ...(notice ? { notice } : {}) };
}

const EVENTS: Record<string, (stdin: string, deps?: EventDeps) => Promise<HermesHookOutput | undefined>> = {
  "pre-llm-call": preLlmCall,
};

/** Entry point for `ss33 hook hermes <event>`. Always resolves; errors go to the debug log only. */
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
