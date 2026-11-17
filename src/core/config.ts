import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_ENDPOINT = "https://mcp.ss33.ai/mcp";

export interface MatchConfig {
  /** Prompt matching sends prompt text to the store. Off by default; users opt in. */
  enabled: boolean;
  /** Minimum keyword overlap between the prompt and a candidate before we suggest it. */
  minOverlap: number;
  /** Cap on suggestions per session, so the hint never becomes noise. */
  maxHintsPerSession: number;
  /**
   * Match prompts that arrive through chat apps (Telegram, Slack, … in Hermes). Off by default: those
   * prompts usually have no project, so a skill suggestion rarely fits (decided 2026-11-13).
   */
  chatApps: boolean;
}

export interface Config {
  endpoint: string;
  apiKey?: string;
  match: MatchConfig;
}

export const DEFAULT_CONFIG: Config = {
  endpoint: DEFAULT_ENDPOINT,
  match: { enabled: false, minOverlap: 2, maxHintsPerSession: 3, chatApps: false },
};

type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env): string {
  if (env.SS33_CONFIG_DIR) return env.SS33_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ss33");
}

export function stateDir(env: Env = process.env): string {
  if (env.SS33_STATE_DIR) return env.SS33_STATE_DIR;
  // Claude Code gives plugins a persistent data dir; prefer it when we run as a plugin.
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "ss33");
}

export function configPath(env: Env = process.env): string {
  return join(configDir(env), "config.json");
}

function readFileConfig(env: Env): Partial<Config> {
  try {
    return JSON.parse(readFileSync(configPath(env), "utf8")) as Partial<Config>;
  } catch {
    return {};
  }
}

function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** File config, then environment overrides. Env wins so CI and plugin options can override a local file. */
export function loadConfig(env: Env = process.env): Config {
  const file = readFileConfig(env);
  const match: MatchConfig = { ...DEFAULT_CONFIG.match, ...(file.match ?? {}) };
  // SS33_MATCH beats the Claude Code plugin option, which beats the config file.
  const enabled = envFlag(env.SS33_MATCH) ?? envFlag(env.CLAUDE_PLUGIN_OPTION_PROMPT_MATCHING);
  if (enabled !== undefined) match.enabled = enabled;
  const chatApps = envFlag(env.SS33_MATCH_CHAT_APPS);
  if (chatApps !== undefined) match.chatApps = chatApps;
  const apiKey = nonEmpty(env.SS33_API_KEY) ?? pluginApiKey(env) ?? nonEmpty(file.apiKey);
  return {
    endpoint: nonEmpty(env.SS33_ENDPOINT) ?? nonEmpty(file.endpoint) ?? DEFAULT_ENDPOINT,
    ...(apiKey ? { apiKey } : {}),
    match,
  };
}

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * The key a harness's own settings hold, handed to hooks only: Claude Code's plugin option
 * (`CLAUDE_PLUGIN_OPTION_API_KEY`), or the Hermes plugin's secret, which its shim passes as `SS33_PLUGIN_API_KEY`.
 */
function pluginApiKey(env: Env): string | undefined {
  return nonEmpty(env.CLAUDE_PLUGIN_OPTION_API_KEY) ?? nonEmpty(env.SS33_PLUGIN_API_KEY);
}

const SETTABLE = ["apiKey", "endpoint", "match.enabled", "match.chatApps", "match.minOverlap", "match.maxHintsPerSession"] as const;
export type SettableKey = (typeof SETTABLE)[number];

export function isSettableKey(key: string): key is SettableKey {
  return (SETTABLE as readonly string[]).includes(key);
}

export function settableKeys(): readonly string[] {
  return SETTABLE;
}

/** Writes one key to the config file. The file can hold an API key, so it is created 0600. */
export function setConfigValue(key: SettableKey, raw: string | undefined, env: Env = process.env): void {
  const file = readFileConfig(env) as Record<string, unknown>;
  const match = { ...((file.match as object | undefined) ?? {}) } as Record<string, unknown>;
  if (key === "apiKey" || key === "endpoint") {
    if (raw === undefined || raw === "") delete file[key];
    else file[key] = raw;
  } else {
    const sub = key.slice("match.".length);
    if (raw === undefined || raw === "") delete match[sub];
    else if (sub === "enabled" || sub === "chatApps") match[sub] = envFlag(raw) ?? false;
    else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer`);
      match[sub] = n;
    }
    file.match = match;
  }
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Claude Code hands the keychain-stored plugin option only to hooks, never to commands Claude runs
 * through Bash; Hermes keeps plugin secrets out of the model's terminal. The hook copies the key into
 * the config file (0600) so `/ss33:*` commands use the same key and users have one place to set it.
 * Returns true when the file was written.
 */
export function syncPluginApiKey(env: Env = process.env): boolean {
  const key = pluginApiKey(env);
  if (!key || readFileConfig(env).apiKey === key) return false;
  setConfigValue("apiKey", key, env);
  return true;
}

/** Config for display: never print the full key. */
export function redacted(config: Config): Record<string, unknown> {
  return {
    ...config,
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 8)}…(set)` : "(not set: free tier)",
  };
}

export type Source = "SS33 env var" | "plugin option" | "config file" | "default";

/** Where each effective setting came from, so `ss33 doctor` can explain surprising values. */
export function configSources(env: Env = process.env): { apiKey: Source; matchEnabled: Source } {
  const file = readFileConfig(env);
  const apiKey: Source = nonEmpty(env.SS33_API_KEY)
    ? "SS33 env var"
    : pluginApiKey(env)
      ? "plugin option"
      : nonEmpty(file.apiKey)
        ? "config file"
        : "default";
  const matchEnabled: Source =
    envFlag(env.SS33_MATCH) !== undefined
      ? "SS33 env var"
      : envFlag(env.CLAUDE_PLUGIN_OPTION_PROMPT_MATCHING) !== undefined
        ? "plugin option"
        : file.match?.enabled !== undefined
          ? "config file"
          : "default";
  return { apiKey, matchEnabled };
}

/**
 * Claude Code passes plugin options (/plugin configure) to hooks but not to commands Claude runs
 * through the Bash tool. True when we're one of those commands, so we can say our view is partial.
 */
export function pluginOptionsHidden(env: Env = process.env): boolean {
  return Boolean(env.CLAUDECODE) && !Object.keys(env).some((k) => k.startsWith("CLAUDE_PLUGIN_OPTION_"));
}

/** What the hook last saw. Lives in the config dir (not CLAUDE_PLUGIN_DATA) so Bash commands can read it. */
export interface HookStatus {
  seenAt: string;
  harness: string;
  matchEnabled: boolean;
  matchSource: Source;
  apiKeySet: boolean;
  apiKeySource: Source;
}

export function hookStatusPath(env: Env = process.env): string {
  return join(configDir(env), "hook-status.json");
}

export function writeHookStatus(status: HookStatus, env: Env = process.env): void {
  try {
    const path = hookStatusPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(status, null, 2) + "\n");
  } catch {
    // Diagnostics only: never let this break a hook.
  }
}

export function readHookStatus(env: Env = process.env): HookStatus | undefined {
  try {
    return JSON.parse(readFileSync(hookStatusPath(env), "utf8")) as HookStatus;
  } catch {
    return undefined;
  }
}
