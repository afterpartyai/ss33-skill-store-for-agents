/**
 * Harness-neutral events. Adapters translate their harness's hook payloads into these and format
 * the result back; all decisions live here so every harness behaves the same.
 */
import { StoreClient } from "./client.js";
import { configSources, loadConfig, stateDir, syncPluginApiKey, writeHookStatus, type Config } from "./config.js";
import { fingerprint } from "./fingerprint.js";
import { installedSkills, projectRoot } from "./install.js";
import { buildQuery, decide, shouldSearch, type MatchOutcome } from "./match.js";
import { debugLog, loadSession, saveSession } from "./state.js";
import { VERSION } from "./version.js";

export interface PromptSubmitted {
  prompt: string;
  cwd: string;
  sessionId?: string;
  harness: string;
  /** The harness's way to invoke the add skill, quoted in hints (default `/ss33:add`). */
  addCommand?: string;
}

export interface EventDeps {
  config?: Config;
  client?: StoreClient;
  env?: Record<string, string | undefined>;
}

/** Hook budget: the user is waiting on this, so the store gets one short attempt. */
export const MATCH_TIMEOUT_MS = 3000;

/** `context` goes to the model; `notice` is shown to the user (harnesses that can't show it fall back to context only). */
export async function onPromptSubmitted(ev: PromptSubmitted, deps: EventDeps = {}): Promise<{ context?: string; notice?: string; outcome: MatchOutcome }> {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadConfig(env);
  const state = stateDir(env);
  try {
    if (syncPluginApiKey(env)) debugLog(state, `[${ev.harness}] copied the plugin's API key to the config file for /ss33 commands`);
  } catch (err) {
    debugLog(state, `[${ev.harness}] could not copy the plugin's API key: ${(err as Error).message}`);
  }
  const sources = configSources(env);
  writeHookStatus(
    {
      seenAt: new Date().toISOString(),
      harness: ev.harness,
      matchEnabled: config.match.enabled,
      matchSource: sources.matchEnabled,
      apiKeySet: Boolean(config.apiKey),
      apiKeySource: sources.apiKey,
    },
    env,
  );
  if (!config.match.enabled) return { outcome: { kind: "skip", reason: "matching disabled (turn on with `ss33 config set match.enabled true`)" } };
  const pre = shouldSearch(ev.prompt);
  if (!pre.ok) {
    // Logged so "why no suggestion?" is answerable from hook.log (the prompt text itself is never logged).
    debugLog(state, `[${ev.harness}] prompt_submitted → skip: ${pre.reason}`);
    return { outcome: { kind: "skip", reason: pre.reason } };
  }

  const root = projectRoot(ev.cwd, env);
  const session = loadSession(state, ev.sessionId);
  if (session.hints >= config.match.maxHintsPerSession) return { outcome: { kind: "skip", reason: "session hint cap reached" } };

  const client =
    deps.client ??
    new StoreClient({
      endpoint: config.endpoint,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      timeoutMs: MATCH_TIMEOUT_MS,
      clientName: `ss33-${ev.harness}`,
      clientVersion: VERSION,
    });
  const summary = fingerprint(root).summary;
  const result = await client.search(buildQuery(ev.prompt, summary), { limit: 3 });
  const outcome = decide({ prompt: ev.prompt, projectSummary: summary, installed: installedSkills(root), session, config: config.match, ...(ev.addCommand ? { addCommand: ev.addCommand } : {}) }, result);
  if (outcome.kind === "suggest") {
    saveSession(state, ev.sessionId, { suggested: [...session.suggested, outcome.candidate.ref], hints: session.hints + 1 });
  }
  debugLog(state, `[${ev.harness}] prompt_submitted → ${outcome.kind}${outcome.kind === "suggest" ? ` ${outcome.candidate.ref} (${outcome.overlap.join(",")})` : `: ${outcome.reason}`}`);
  return outcome.kind === "suggest" ? { context: outcome.hint, notice: outcome.notice, outcome } : { outcome };
}
