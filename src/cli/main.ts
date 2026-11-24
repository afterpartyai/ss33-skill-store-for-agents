/**
 * `ss33` CLI — the contract every harness adapter calls. Human-readable output by default,
 * `--json` for scripts. Hook subcommands are silent on failure by design.
 */
import { readFileSync } from "node:fs";
import { runHook as claudeCodeHook } from "../adapters/claude-code.js";
import { runHook as codexHook } from "../adapters/codex.js";
import { runHook as copilotHook } from "../adapters/copilot.js";
import { runHook as dshHook } from "../adapters/dsh.js";
import { runHook as hermesHook } from "../adapters/hermes.js";
import { isSkillSetRef, StoreClient, StoreError, type SkillSet } from "../core/client.js";
import {
  configPath,
  configSources,
  isSettableKey,
  loadConfig,
  pluginOptionsHidden,
  readHookStatus,
  redacted,
  setConfigValue,
  settableKeys,
} from "../core/config.js";
import { fingerprint } from "../core/fingerprint.js";
import { InstallError, install, installSet, projectRoot, remove, setMembers, status, update, validSet, type Target, TARGET_DIRS } from "../core/install.js";
import { buildQuery } from "../core/match.js";
import { VERSION } from "../core/version.js";

const HELP = `ss33 ${VERSION} — Skill Store CLI

Usage:
  ss33 search <query…> [--limit N] [--area AREA] [--no-context] [--json]
  ss33 get <ref>                     print a skill's SKILL.md (or a skill set's steps) without installing it
  ss33 add <ref> [--target claude|agents|both] [--dry-run] [--show] [--force] [--json]
                                     a skill-set/… ref installs every step of the set
  ss33 update [name…] [--yes] [--force] [--json]
  ss33 remove <name | skill-set/…>
  ss33 list [--json]                 installed skills and whether their files still match ss33.lock
  ss33 fingerprint [--json]          the project summary sent with searches
  ss33 config get | set <key> <value> | unset <key> | path
  ss33 doctor [--offline]            which settings are in effect where, and whether the store accepts the key
  ss33 hook claude-code|codex|copilot|dsh|hermes <event>  (used by the plugins; reads hook JSON on stdin)

Options:
  --dir PATH   project root (default: $CLAUDE_PROJECT_DIR, else nearest dir with ss33.lock or .git)

Config keys: ${settableKeys().join(", ")}
Environment: SS33_API_KEY, SS33_ENDPOINT, SS33_MATCH=1|0, SS33_MATCH_CHAT_APPS=1|0, SS33_CONFIG_DIR, SS33_STATE_DIR
`;

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(["limit", "area", "target", "dir", "tier"]);

/** `valueFlags` are flags that take a value (`--port 8080`); others are booleans unless written `--flag=value`. */
export function parseArgs(argv: string[], valueFlags: Iterable<string> = VALUE_FLAGS): Parsed {
  const takesValue = new Set(valueFlags);
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (inline !== undefined) flags[k] = inline;
      else if (takesValue.has(k) && i + 1 < argv.length) flags[k] = argv[++i]!;
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function targetsFrom(v: string | undefined): Target[] {
  if (!v || v === "claude") return ["claude"];
  if (v === "agents") return ["agents"];
  if (v === "both") return ["claude", "agents"];
  throw new InstallError(`--target must be claude, agents or both (got "${v}")`);
}

function client(): StoreClient {
  const config = loadConfig();
  return new StoreClient({
    endpoint: config.endpoint,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    clientName: "ss33-cli",
    clientVersion: VERSION,
  });
}

function readStdin(): string {
  try {
    // Windows PowerShell 5.1 prepends a UTF-8 BOM when it pipes text to a native program (Copilot's powershell hooks).
    return readFileSync(0, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

export async function main(argv: string[], out = (s: string) => process.stdout.write(s + "\n")): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  const json = flags.json === true;
  const root = () => projectRoot(process.cwd(), process.env, str(flags.dir));

  switch (cmd) {
    case undefined:
    case "help":
      out(HELP);
      return 0;
    case "version":
      out(VERSION);
      return 0;

    case "search": {
      const query = rest.join(" ").trim();
      if (!query) return usage("search needs a query", out);
      const summary = flags["no-context"] ? undefined : fingerprint(root()).summary || undefined;
      const res = await client().search(buildQuery(query, summary), {
        limit: Number(str(flags.limit) ?? 5),
        ...(str(flags.area) ? { area: str(flags.area)! } : {}),
        ...(str(flags.tier) ? { tier: str(flags.tier)! } : {}),
      });
      if (json) return out(JSON.stringify(res, null, 2)), 0;
      if (res.limited) out(`Rate limited: ${res.message ?? "free-tier limit reached"}`);
      else if (!res.found) out(`No matching skills.${res.message ? ` ${res.message}` : ""}`);
      for (const c of res.candidates) {
        out(`• ${c.title}  (${c.ref})${c.available === false ? "  [not available from the store: can't be installed]" : ""}`);
        if (c.what_it_does) out(`    ${truncate(c.what_it_does, 240)}`);
      }
      const sets = res.skillSets ?? [];
      if (sets.length) {
        out(`\nSkill sets (skills used together for the whole job):`);
        for (const set of sets) {
          out(`• ${set.title}  (${set.ref})  ${set.skill_refs.length} skills${set.sequential ? ", run in order" : ""}`);
          if (set.what_it_does) out(`    ${truncate(set.what_it_does, 240)}`);
        }
      }
      if (res.candidates.some((c) => c.available !== false) || sets.length) out(`\nInstall one with: ss33 add <ref>${sets.length ? " (a skill-set/… ref installs the whole set)" : ""}`);
      if (res.storeNote) out(`\n${res.storeNote}`);
      return 0;
    }

    case "get": {
      const ref = rest[0];
      if (!ref) return usage("get needs a skill ref (from `ss33 search`)", out);
      try {
        if (isSkillSetRef(ref)) {
          const set = await client().getSkillSet(ref);
          out(json ? JSON.stringify(set, null, 2) : describeSet(set));
          return 0;
        }
        const skill = await client().fetchSkill(ref);
        out(skill.markdown);
        if (skill.filesNotStored && skill.sourceUrl) out(`\n(Supporting files aren't in the store: ${skill.sourceUrl})`);
        return 0;
      } catch (err) {
        if (err instanceof StoreError && (err.kind === "unavailable" || err.kind === "not_found")) {
          out(`${err.message}${err.sourceUrl ? ` The author publishes it here: ${err.sourceUrl}` : ""}`);
          return 1;
        }
        throw err;
      }
    }

    case "add": {
      const ref = rest[0];
      if (!ref) return usage("add needs a skill ref (from `ss33 search`)", out);
      if (isSkillSetRef(ref)) return addSet(ref, root(), flags, out);
      let plan;
      try {
        plan = await install(client(), root(), ref, {
          targets: targetsFrom(str(flags.target)),
          force: flags.force === true,
          dryRun: flags["dry-run"] === true,
        });
      } catch (err) {
        if (!(err instanceof StoreError && err.kind === "unavailable")) throw err;
        if (json) return out(JSON.stringify({ ref, available: false, error: err.message, sourceUrl: err.sourceUrl ?? null }, null, 2)), 1;
        out(`${err.message} Nothing was installed.`);
        if (err.sourceUrl) out(`The author publishes it here: ${err.sourceUrl}\nCheck its licence before copying it into your project.`);
        return 1;
      }
      if (json) return out(JSON.stringify({ ...plan, content: flags.show ? plan.content : undefined }, null, 2)), 0;
      const verb = flags["dry-run"] ? "Would install" : plan.replacing ? "Reinstalled" : "Installed";
      out(`${verb} "${plan.name}" from ${plan.ref}`);
      out(`  ${truncate(plan.description, 300)}`);
      for (const p of plan.paths) out(`  → ${p}`);
      out(`  sha256 ${plan.sha256.slice(0, 16)}…`);
      if (plan.conflicts.length) out(`  ⚠ existing files not managed by ss33: ${plan.conflicts.join(", ")} (needs --force)`);
      if (plan.missingFiles.length) out(`  ⚠ links to files that won't be installed: ${plan.missingFiles.join(", ")}`);
      if (plan.filesNotStored) out(`  ⚠ the store doesn't carry this skill's supporting files${plan.sourceUrl ? `; the author's folder: ${plan.sourceUrl}` : ""}`);
      if (plan.storeFiles.length) out(`  ⚠ the store sent ${plan.storeFiles.length} supporting file(s) that this version of ss33 doesn't install yet: ${plan.storeFiles.join(", ")}`);
      if (flags.show) out(`\n----- SKILL.md -----\n${plan.content}`);
      if (!flags["dry-run"]) out(`\n${pickUpNote(plan.paths, plan.name)}`);
      return 0;
    }

    case "update": {
      const results = await update(client(), root(), { names: rest, apply: flags.yes === true, force: flags.force === true });
      if (json) return out(JSON.stringify(results, null, 2)), 0;
      if (!results.length) out("No skills installed (nothing in ss33.lock).");
      for (const r of results) {
        const label = {
          unchanged: "up to date",
          available: "update available (run `ss33 update --yes` to apply)",
          updated: "updated",
          "blocked-local-edits": "has local edits; not updated (use --force to overwrite)",
          error: `error: ${r.error}`,
        }[r.state];
        out(`• ${r.name} (${r.ref}): ${label}`);
        if (r.diff && r.state !== "unchanged") out(indent(r.diff));
      }
      return results.some((r) => r.state === "error") ? 1 : 0;
    }

    case "remove": {
      const name = rest[0];
      if (!name) return usage("remove needs a skill name (see `ss33 list`)", out);
      if (isSkillSetRef(name)) {
        const members = setMembers(root(), name);
        if (!members.length) throw new InstallError(`No skills from ${name} in ss33.lock`);
        for (const m of members) {
          const { entry, removed, ignored } = remove(root(), m);
          out(`Removed "${m}" (${entry.ref}) from ss33.lock${removed.length ? `: ${removed.join(", ")}` : ""}`);
          for (const i of ignored) out(`  Left alone: ${i.path} (${i.reason}). Check where this ss33.lock came from.`);
        }
        return 0;
      }
      const { entry, removed, ignored } = remove(root(), name);
      out(`Removed "${name}" (${entry.ref}) from ss33.lock${removed.length ? `: ${removed.join(", ")}` : ""}`);
      // A lock path ss33 wouldn't create (../.., absolute, through a symlink) is never deleted.
      for (const i of ignored) out(`  Left alone: ${i.path} (${i.reason}). Check where this ss33.lock came from.`);
      return 0;
    }

    case "list": {
      const s = status(root());
      if (json) return out(JSON.stringify(s, null, 2)), 0;
      if (!s.length) out("No skills installed from the Skill Store in this project.");
      for (const { name, entry, files } of s) {
        out(`• ${name}  (${entry.ref}, installed ${entry.installedAt.slice(0, 10)})`);
        const set = validSet(entry.set);
        if (set) out(`    step ${set.position} of skill set "${set.title}" (${set.ref})`);
        const mark = { ok: "✓", modified: "✎ modified", missing: "✗ missing", ignored: "⚠ ignored" } as const;
        for (const f of files) out(`    ${mark[f.status]}  ${f.path}${f.reason ? ` (${f.reason})` : ""}`);
      }
      return 0;
    }

    case "fingerprint": {
      const fp = fingerprint(root());
      out(json ? JSON.stringify(fp, null, 2) : fp.summary || "(nothing detected)");
      return 0;
    }

    case "config": {
      const [sub, key, value] = rest;
      if (sub === "path") return out(configPath()), 0;
      if (sub === "get" || sub === undefined) {
        out(JSON.stringify({ ...redacted(loadConfig()), sources: configSources() }, null, 2));
        if (pluginOptionsHidden()) out(`\n${HIDDEN_NOTE}`);
        return 0;
      }
      if ((sub === "set" || sub === "unset") && key) {
        if (!isSettableKey(key)) return usage(`unknown config key "${key}". Keys: ${settableKeys().join(", ")}`, out);
        if (sub === "set" && value === undefined) return usage(`config set ${key} needs a value`, out);
        setConfigValue(key, sub === "set" ? value : undefined);
        out(sub === "set" ? `Set ${key}${key === "apiKey" ? "" : ` = ${value}`} in ${configPath()}` : `Unset ${key}`);
        return 0;
      }
      return usage("config get | set <key> <value> | unset <key> | path", out);
    }

    case "doctor":
      return doctor(flags.offline === true, out);

    case "hook": {
      const [harness, event] = rest;
      const run = harness ? HOOKS[harness] : undefined;
      if (!run || !event) return 0;
      const result = await run(event, readStdin());
      if (result) out(result);
      return 0;
    }

    default:
      return usage(`unknown command "${cmd}"`, out);
  }
}

const HOOKS: Record<string, (event: string, stdin: string) => Promise<string>> = { "claude-code": claudeCodeHook, codex: codexHook, copilot: copilotHook, dsh: dshHook, hermes: hermesHook };

function describeSet(set: SkillSet): string {
  const lines = [`Skill set: ${set.title}  (${set.ref}${set.version ? `, version ${set.version}` : ""})`];
  if (set.what_it_does) lines.push(`  ${truncate(set.what_it_does, 400)}`);
  lines.push(`  ${set.steps.length} skills${set.sequential ? ", used in this order" : ""}:`);
  for (const st of set.steps) {
    const extra = [st.label, st.model_size ? `${st.model_size} model` : "", st.available === false ? "not available from the store" : ""].filter(Boolean).join("; ");
    lines.push(`  ${st.position}. ${st.title}  (${st.ref})${extra ? `  [${extra}]` : ""}`);
  }
  return lines.join("\n");
}

async function addSet(ref: string, root: string, flags: Record<string, string | true>, out: (s: string) => void): Promise<number> {
  const dryRun = flags["dry-run"] === true;
  const res = await installSet(client(), root, ref, { targets: targetsFrom(str(flags.target)), force: flags.force === true, dryRun });
  if (flags.json === true) {
    const plans = flags.show ? res.plans : res.plans.map(({ content: _c, ...p }) => p);
    return out(JSON.stringify({ set: res.set, plans, skipped: res.skipped }, null, 2)), res.plans.length ? 0 : 1;
  }
  out(describeSet(res.set));
  out("");
  if (!res.plans.length) {
    out(`None of this set's skills can be installed from the store. Nothing was installed.`);
    for (const k of res.skipped) out(`  ✗ step ${k.position}: ${k.reason}${k.sourceUrl ? ` The author publishes it here: ${k.sourceUrl}` : ""}`);
    return 1;
  }
  out(`${dryRun ? "Would install" : "Installed"} ${res.plans.length} of ${res.set.steps.length} skills:`);
  for (const plan of res.plans) {
    out(`${plan.set?.position ?? "•"}. "${plan.name}" from ${plan.ref}${plan.replacing ? " (already installed; reinstalled)" : ""}`);
    out(`   ${truncate(plan.description, 300)}`);
    for (const p of plan.paths) out(`   → ${p}`);
    if (plan.conflicts.length) out(`   ⚠ existing files not managed by ss33: ${plan.conflicts.join(", ")} (needs --force)`);
    if (plan.missingFiles.length) out(`   ⚠ links to files that won't be installed: ${plan.missingFiles.join(", ")}`);
    if (plan.filesNotStored) out(`   ⚠ the store doesn't carry this skill's supporting files${plan.sourceUrl ? `; the author's folder: ${plan.sourceUrl}` : ""}`);
  }
  for (const k of res.skipped) out(`✗ step ${k.position} (${k.title}) left out: ${k.reason}${k.sourceUrl ? ` The author publishes it here: ${k.sourceUrl}` : ""}`);
  if (flags.show) for (const plan of res.plans) out(`\n----- ${plan.set?.position ?? ""}. ${plan.name}/SKILL.md -----\n${plan.content}`);
  if (!dryRun) {
    const first = res.plans[0]!;
    out(`\nEach skill is tracked in ss33.lock as a step of this set (see \`ss33 list\`); remove them all with \`ss33 remove ${res.set.ref}\`.`);
    out(pickUpNote(first.paths, res.plans.map((p) => p.name).join('", "'), res.plans.length > 1));
  }
  return 0;
}

/** Which agents load the skill from where it was written. */
function pickUpNote(paths: string[], name: string, several = false): string {
  const notes: string[] = [];
  if (paths.some((p) => p.startsWith(TARGET_DIRS.claude + "/"))) notes.push(`Claude Code picks up new skills automatically; ${several ? "they appear as" : "it appears as"} "${name}".`);
  if (paths.some((p) => p.startsWith(TARGET_DIRS.agents + "/")))
    notes.push(
      `Codex, Copilot, Cursor and other agents that read ${TARGET_DIRS.agents}/ load ${several ? "them" : "it"} as "${name}" (in Codex, Copilot or Cursor, start a new session if ${several ? "they don't" : "it doesn't"} appear; ` +
        `Hermes loads it only once the repo is trusted with \`hermes skills trust\`).`,
    );
  return notes.join("\n");
}

const HIDDEN_NOTE =
  "Note: this command runs inside Claude Code, which doesn't pass plugin settings (/plugin configure) to it. " +
  "The prompt-matching hook does see them, so its settings may differ: run `ss33 doctor` to compare.";

function yesNo(v: boolean): string {
  return v ? "yes" : "no";
}

/** Explains the effective settings for this command and for the hook, then checks the key with one search. */
async function doctor(offline: boolean, out: (s: string) => void): Promise<number> {
  const config = loadConfig();
  const sources = configSources();
  out(`ss33 ${VERSION}`);
  out(`Commands (/ss33:*, the ss33 CLI):`);
  out(`  API key set: ${yesNo(Boolean(config.apiKey))} (${sources.apiKey})`);
  out(`  prompt matching: ${config.match.enabled ? "on" : "off"} (${sources.matchEnabled})`);
  const hook = readHookStatus();
  if (hook) {
    out(`Prompt-matching hook (as of its last run, ${hook.seenAt}):`);
    out(`  API key set: ${yesNo(hook.apiKeySet)} (${hook.apiKeySource})`);
    out(`  prompt matching: ${hook.matchEnabled ? "on" : "off"} (${hook.matchSource})`);
  } else out(`Prompt-matching hook: no record yet (it writes one on the next prompt, or next session in Hermes).`);

  const problems: string[] = [];
  if (hook && hook.apiKeySet && !config.apiKey) {
    problems.push(
      "The hook has an API key (from the plugin settings) but commands don't, so /ss33:search and /ss33:add use the free tier. " +
        "Fix: send any prompt so the hook copies the key over (0.1.8+), or run `ss33 config set apiKey <key>`, or export SS33_API_KEY.",
    );
  }
  if (hook && hook.matchEnabled !== config.match.enabled && pluginOptionsHidden()) {
    problems.push(`Prompt matching is ${hook.matchEnabled ? "on" : "off"} for the hook (which is what counts); commands just can't see the plugin setting.`);
  }

  if (!offline) {
    try {
      const res = await client().search("github actions ci", { limit: 1 });
      const freeTier = /free tier|free searches/i.test(`${res.storeNote ?? ""} ${res.message ?? ""}`);
      if (res.limited) out(`Store: reachable, but rate limited right now${config.apiKey ? "" : " (free tier)"}.`);
      else if (config.apiKey && freeTier) {
        out("Store: reachable, but it treated the request as free tier even though a key was sent.");
        problems.push("The store didn't apply your API key. Check it at https://ss33.ai/skills/account.");
      } else out(`Store: reachable, ${config.apiKey ? "API key accepted" : "free tier (no key)"}.`);
    } catch (err) {
      out(`Store: ${(err as Error).message}`);
      if (err instanceof StoreError && err.kind === "auth") problems.push("The store rejected the API key. Create a new one at https://ss33.ai/skills/account.");
      if (err instanceof StoreError && err.kind === "network") problems.push("The store can't be reached from here, so search, add and update won't work. See the fixes above.");
    }
  }

  out(problems.length ? `\nProblems:\n${problems.map((p) => `  • ${p}`).join("\n")}` : "\nNo problems found.");
  return problems.length ? 1 : 0;
}

function usage(msg: string, out: (s: string) => void): number {
  out(`ss33: ${msg}\n\nRun \`ss33 help\` for usage.`);
  return 2;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

// Only run when executed directly (the bundle), not when imported by tests.
const invokedDirectly = process.argv[1] && /ss33(\.mjs|\.cjs)?$|cli[\\/]main\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof StoreError || err instanceof InstallError) {
        process.stderr.write(`ss33: ${err.message}\n`);
        process.exit(1);
      }
      process.stderr.write(`ss33: unexpected error: ${(err as Error)?.stack ?? err}\n`);
      process.exit(1);
    },
  );
}

export { TARGET_DIRS };
