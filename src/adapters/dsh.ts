/**
 * DeepSeek Harness (DSH) adapter. DSH plugins are in-process JavaScript (Cordis), not shell hooks, so the plugin's
 * `index.js` (adapters/dsh/) listens to `agent/pre-step` and, on a turn's first step while prompt matching is on,
 * pipes this JSON to `ss33 hook dsh pre-step`:
 *
 *   stdin  {session_id, cwd, prompt}     prompt = the text of the user's own messages in this step
 *   stdout {context, notice}             or nothing
 *
 * `index.js` appends `context` to the step as a user-role message whose source is a `notice`: DSH shows the user its
 * one-line summary (`notice`) and the model reads the full text, like Claude Code's systemMessage + additionalContext.
 */
import { stateDir } from "../core/config.js";
import { onPromptSubmitted, type EventDeps } from "../core/events.js";
import { debugLog } from "../core/state.js";

export const HARNESS = "dsh";

/** DSH doesn't namespace plugin skills (`/<skill name>`), so the plugin's skills carry an `ss33-` prefix. */
export const ADD_COMMAND = "/ss33-add";

export interface PreStepInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
}

export interface DshHookOutput {
  context: string;
  notice?: string;
}

export async function preStep(stdin: string, deps: EventDeps = {}): Promise<DshHookOutput | undefined> {
  let input: PreStepInput;
  try {
    input = JSON.parse(stdin) as PreStepInput;
  } catch {
    throw new Error("stdin is not JSON"); // fixed text: the parser's message would quote the prompt into hook.log
  }
  if (typeof input.prompt !== "string") return undefined;
  const { context, notice } = await onPromptSubmitted(
    {
      prompt: input.prompt,
      // No fallback to process.cwd(): that is the DSH host's directory, which serves every session.
      cwd: typeof input.cwd === "string" ? input.cwd : "",
      ...(input.session_id ? { sessionId: input.session_id } : {}),
      harness: HARNESS,
      addCommand: ADD_COMMAND,
    },
    deps,
  );
  if (!context) return undefined;
  return { context, ...(notice ? { notice } : {}) };
}

const EVENTS: Record<string, (stdin: string, deps?: EventDeps) => Promise<DshHookOutput | undefined>> = {
  "pre-step": preStep,
};

/** Entry point for `ss33 hook dsh <event>`. Always resolves; errors go to the debug log only. */
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
