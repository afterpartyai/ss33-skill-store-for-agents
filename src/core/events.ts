/**
 * Harness-neutral events. Adapters translate their harness's hook payloads into these and format
 * the result back; all decisions live here so every harness behaves the same.
 */
import { StoreClient } from "./client.js";
import { configSources, loadConfig, stateDir, syncPluginApiKey, writeHookStatus, type Config } from "./config.js";
import { fingerprint } from "./fingerprint.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { installedSkills, LOCK_FILE, projectRoot } from "./install.js";
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
  /** False when the harness can't show `notice` to the user (Copilot); see match.ts formatHint. */
  noticeShown?: boolean;
  /**
   * Where the prompt came from, for harnesses that serve several clients (Hermes: `cli`, `tui`, `desktop`,
   * `acp`, or a chat app such as `telegram`). Chat-app prompts are skipped unless `match.chatApps` is on.
   */
  surface?: string;
  /** Skip when `cwd` isn't inside a project (no `.git`, `ss33.lock` or known manifest): a hint needs a project to fit. */
  requireProject?: boolean;
}

/** Hermes's local clients. Any other non-empty surface is a chat app (Telegram, Slack, Discord, …). */
export const LOCAL_SURFACES: ReadonlySet<string> = new Set(["cli", "tui", "desktop", "acp"]);

export function isChatSurface(surface: string | undefined): boolean {
  return Boolean(surface) && !LOCAL_SURFACES.has(surface!);
}

export interface EventDeps {
  config?: Config;
  client?: StoreClient;
  env?: Record<string, string | undefined>;
}

/** Hook budget: the user is waiting on this, so the store gets one short attempt. */
export const MATCH_TIMEOUT_MS = 3000;

/** `context` goes to the model; `notice` is shown to the user (harnesses that can't show it fall back to context only). */
/**
 * What every hook run does first: copy the plugin's API key to the config file (plugin settings don't reach the
 * /ss33:* commands), and record what the hook sees for `ss33 doctor`.
 */
function recordHookRun(harness: string, env: Record<string, string | undefined>, config: Config): void {
  const state = stateDir(env);
  try {
    if (syncPluginApiKey(env)) debugLog(state, `[${harness}] copied the plugin's API key to the config file for /ss33 commands`);
  } catch (err) {
    debugLog(state, `[${harness}] could not copy the plugin's API key: ${(err as Error).message}`);
  }
  const sources = configSources(env);
  writeHookStatus(
    {
      seenAt: new Date().toISOString(),
      harness,
      matchEnabled: config.match.enabled,
      matchSource: sources.matchEnabled,
      apiKeySet: Boolean(config.apiKey),
      apiKeySource: sources.apiKey,
    },
    env,
  );
}

/**
 * Session start, for harnesses whose prompt hook doesn't run the CLI while matching is off (Hermes checks the
 * setting before starting a process): the key copy and the doctor record happen here instead.
 */
export function onSessionStarted(ev: { harness: string }, deps: EventDeps = {}): void {
  const env = deps.env ?? process.env;
  recordHookRun(ev.harness, env, deps.config ?? loadConfig(env));
}

export async function onPromptSubmitted(ev: PromptSubmitted, deps: EventDeps = {}): Promise<{ context?: string; notice?: string; outcome: MatchOutcome }> {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadConfig(env);
  const state = stateDir(env);
  recordHookRun(ev.harness, env, config);
  if (!config.match.enabled) return { outcome: { kind: "skip", reason: "matching disabled (turn on with `ss33 config set match.enabled true`)" } };
  const pre = shouldSearch(ev.prompt);
  if (!pre.ok) {
    // Logged so "why no suggestion?" is answerable from hook.log (the prompt text itself is never logged).
    debugLog(state, `[${ev.harness}] prompt_submitted → skip: ${pre.reason}`);
    return { outcome: { kind: "skip", reason: pre.reason } };
  }

  if (isChatSurface(ev.surface) && !config.match.chatApps) {
    debugLog(state, `[${ev.harness}] prompt_submitted → skip: chat app (${ev.surface}); turn on with \`ss33 config set match.chatApps true\``);
    return { outcome: { kind: "skip", reason: "chat app" } };
  }
  if (ev.requireProject && !inProject(ev.cwd, env)) {
    debugLog(state, `[${ev.harness}] prompt_submitted → skip: no project at the session's working directory`);
    return { outcome: { kind: "skip", reason: "no project" } };
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
  const outcome = decide({ prompt: ev.prompt, projectSummary: summary, installed: installedSkills(root), session, config: config.match, ...(ev.addCommand ? { addCommand: ev.addCommand } : {}), ...(ev.noticeShown === false ? { noticeShown: false } : {}) }, result);
  if (outcome.kind === "suggest") {
    saveSession(state, ev.sessionId, { suggested: [...session.suggested, outcome.candidate.ref], hints: session.hints + 1 });
  }
  debugLog(state, `[${ev.harness}] prompt_submitted → ${outcome.kind}${outcome.kind === "suggest" ? ` ${outcome.candidate.ref} (${outcome.overlap.join(",")})` : `: ${outcome.reason}`}`);
  return outcome.kind === "suggest" ? { context: outcome.hint, notice: outcome.notice, outcome } : { outcome };
}

/** True when `cwd` is inside a git repo or an ss33 project, or itself has a manifest the fingerprint knows. */
function inProject(cwd: string, env: Record<string, string | undefined>): boolean {
  if (!cwd) return false;
  const root = projectRoot(cwd, env);
  if (existsSync(join(root, ".git")) || existsSync(join(root, LOCK_FILE))) return true;
  return fingerprint(cwd).summary !== "";
}
