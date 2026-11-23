# CLAUDE.md: ss33 Skill Store for agents

This repo holds a harness-agnostic core and CLI for the ss33 Skill Store (an MCP server at `https://mcp.ss33.ai/mcp`), plus five plugin adapters: **Claude Code**, **Codex**, **Hermes Agent**, **Cursor** and **GitHub Copilot**. The core turns the store into three features:

1. **Prompt matching (off by default; users opt in).** A prompt hook (`UserPromptSubmit`, Copilot's `userPromptSubmitted`, or Hermes's `pre_llm_call`) adds a one-line "this skill may be relevant" note, only when a candidate passes local fit checks. Cursor has no prompt matching (see Cursor specifics).
2. **Project-aware search.** A short project summary, built from manifests only (never source), is sent with every search.
3. **Native skill install.** Skills are written as regular `SKILL.md` files, pinned by content hash in `ss33.lock`.

## Layout

```
src/core/        harness-agnostic logic. No harness-specific code here.
  client.ts        MCP-over-HTTP client (search_skills, get_skill). No SDK dependency.
  config.ts        config file + env precedence, state dir
  fingerprint.ts   project summary from manifests and lockfile names
  match.ts         prompt → suggest / none / skip decision, hint text
  install.ts       add / update / remove / status, ss33.lock
  skillfile.ts     frontmatter parsing, provenance stamp, hashing
  events.ts        harness-neutral events (onPromptSubmitted). Adapters call these.
  state.ts         per-session suggestion memory, hook debug log
  diff.ts          small line diff for reviewing updates
src/adapters/
  hook-json.ts     shared stdin/stdout JSON plumbing (Claude Code and Codex use the same hook dialect)
  claude-code.ts   Claude Code mapping: harness name, `/ss33:add`
  codex.ts         Codex mapping: harness name, `$ss33:add`
  copilot.ts       Copilot mapping: `ss33 hook copilot user-prompt-submitted` gets {sessionId, cwd, prompt}, prints {additionalContext}
  hermes.ts        Hermes mapping: `ss33 hook hermes pre-llm-call` gets {session_id, cwd, prompt, surface}, prints {context, notice}
src/cli/main.ts  `ss33` CLI: the contract every adapter calls
adapters/claude-code/    the Claude Code plugin root (what gets installed)
  .claude-plugin/plugin.json   manifest + userConfig (api_key, prompt_matching)
  .claude-plugin/icon.png      directory listing icon (ss33.ai's own)
  hooks/hooks.json             SessionStart → runtime prefetch; UserPromptSubmit → ss33 hook claude-code user-prompt-submit
  skills/{search,add,update,list,setup}/SKILL.md   → /ss33:search, /ss33:add, …
  scripts/ss33                 POSIX sh launcher: finds or downloads Node.js, runs lib/ss33.cjs
  lib/ss33.cjs                 BUILT bundle (committed; see design notes)
adapters/codex/          the Codex plugin root
  .codex-plugin/plugin.json    manifest + interface (display name, icon, default prompt)
  hooks/hooks.json             SessionStart → runtime prefetch; UserPromptSubmit → ss33 hook codex user-prompt-submit
  skills/{search,add,update,list,setup}/SKILL.md   → $ss33:search, $ss33:add, …  (agents/openai.yaml: user-only)
  scripts/ss33, lib/ss33.cjs   COPIES made by `npm run build`; never edit them here
  assets/icon.png
adapters/hermes/         the Hermes plugin root (`hermes plugins install afterpartyai/ss33-skill-store-for-agents/adapters/hermes`)
  plugin.yaml                  manifest: requires_hermes, declared tool and hooks, api_key secret (config_schema)
  __init__.py                  stdlib-only Python shim: pre_llm_call → ss33 CLI → {"context"} + ctx.post_message(notice);
                               on_session_start → runtime prefetch; the ss33_search tool; registers the skills
  skills/{search,add,update,list,setup}/SKILL.md   → /ss33:search, … (hidden from the model by fallback_for_toolsets)
  scripts/ss33, lib/ss33.cjs   COPIES made by `npm run build`; never edit them here
adapters/cursor/         the Cursor plugin root (IDE and the `agent` CLI)
  .cursor-plugin/plugin.json   manifest (Cursor's schema rejects unknown keys)
  hooks/hooks.json             sessionStart → runtime prefetch (no prompt hook: see Cursor specifics)
  skills/ss33-{search,add,update,list,setup}/SKILL.md   → /ss33-search, /ss33-add, …  (user-only: disable-model-invocation)
  scripts/ss33, lib/ss33.cjs   COPIES made by `npm run build`; never edit them here
  assets/icon.png
adapters/copilot/        the GitHub Copilot plugin root (Copilot CLI; VS Code agent plugins read the same format)
  plugin.json                  manifest (Copilot's legacy format, with skills/hooks paths)
  hooks/hooks.json             Copilot's own format: sessionStart → runtime prefetch; userPromptSubmitted → ss33 hook copilot user-prompt-submitted
  skills/{search,add,update,list,setup}/SKILL.md   → /ss33:search, /ss33:add, …  (user-only: disable-model-invocation)
  scripts/ss33, lib/ss33.cjs   COPIES made by `npm run build`; never edit them here
.claude-plugin/marketplace.json   Claude Code installs straight from this GitHub repo
.agents/plugins/marketplace.json  Codex installs from this repo (Codex prefers it over .claude-plugin/)
.cursor-plugin/marketplace.json   Cursor installs from this repo
.github/plugin/marketplace.json   Copilot installs from this repo (Copilot prefers it over .claude-plugin/)
src/fakestore/   local stand-in for the store (tests, evals, manual runs). Compiled, never bundled into the plugin.
  server.ts        scripted skills → cassettes → (record mode) the real store; auth, free tier, faults, /_admin
  cassettes.ts     recorded responses, one JSON file per (tool, args)
  cli.ts           `npm run fake-store -- …`
test/            node:test. *.test.ts run in `npm test`; live.test.ts hits the real store when SS33_LIVE=1
  helpers.ts       in-process fetch stand-in (unit tests)
  fakestore.test.ts   the fake store itself
  e2e-cli.test.ts  real CLI as a child process vs the fake store: lifecycle, hook, hostile skill, outages
  matching/        prompt-matching eval: cases.jsonl, baseline.json, run.ts (report), corpus.ts
  matching.test.ts regression gate against matching/baseline.json
  fixtures/store/  scripted skills (basic.json + SKILL.md bodies)
  cassettes/live/  real store answers for the matching cases (recorded; replayed offline)
```

## Commands

- `npm install`: dev deps only (typescript, esbuild, @types/node). The runtime has **zero dependencies**.
- `npm test`: compiles to `build/` and runs everything offline: unit, fake-store, end-to-end (real CLI vs fake store) and the matching regression gate. About 7 s.
- `npm run test:live`: also hits the real store (set `SS33_API_KEY` to avoid the 5/min free-tier limit).
- `npm run eval:matching`: matching report (offline replay). `-- --verbose` shows every case; `-- --record` records answers for new cases from the real store (uses your key); `-- --update-baseline` accepts the current numbers.
- `npm run fake-store -- --skills test/fixtures/store/basic.json`: run the fake store; point anything at it with `SS33_ENDPOINT=<printed url>`. `--help` for record/auth/fault options; faults and new skill versions can be set at runtime via `POST /_admin/fault` and `POST /_admin/skills`.
- `npm run build`: typechecks, bundles `src/cli/main.ts` → `adapters/claude-code/lib/ss33.cjs`, then copies the bundle and the launcher into `adapters/codex/`, `adapters/hermes/`, `adapters/cursor/` and `adapters/copilot/`. **Run this and commit every plugin after any `src/` or launcher change.** CI and `test/packaging.test.ts` fail if a copy is stale.
- `claude plugin validate adapters/claude-code --strict` and `claude plugin validate .`: manifest checks.
- Try it in Claude Code without installing: `claude --plugin-dir ./adapters/claude-code` (use `SS33_MATCH=1` to force matching on).
- Try it in Codex: `codex plugin marketplace add "$PWD" && codex plugin add ss33@ss33`, start a new session and trust the hooks. Use a throwaway `CODEX_HOME` (copy `auth.json` into it) to keep your own Codex setup clean. The TUI runs hooks in a long-lived app-server daemon that keeps the environment it started with, so stop that daemon before testing with different `SS33_*` variables.
- Hermes: `hermes plugins validate adapters/hermes` (the catalog's admission checks). Try it with a throwaway Hermes (its own checkout and `HERMES_HOME`, plus `SS33_CONFIG_DIR`/`SS33_STATE_DIR`) so your own setup stays clean: `hermes plugins install "file://$PWD#adapters/hermes" --ref $(git rev-parse HEAD) --enable` installs a committed checkout. Hermes runs plugins inside its gateway, which keeps the environment it started with: run `hermes gateway stop` before testing with different `SS33_*` variables. Plugin commands (`/ss33:*`) only exist in the interactive CLI, TUI and desktop, not in `hermes chat -q`.
- Cursor: `agent --plugin-dir ./adapters/cursor --workspace <project>` loads this checkout without installing (CLI). Set `SS33_CONFIG_DIR`/`SS33_STATE_DIR` to keep your own ss33 config clean, and when starting `agent` from inside Claude Code, unset `CLAUDECODE` and `CLAUDE_PROJECT_DIR` (they leak into Cursor's hooks and shells). There's no official validator; the JSON schemas are in `cursor/plugins` (`schemas/plugin.schema.json`, `schemas/marketplace.schema.json`). For the IDE, copy (don't symlink) the folder to `~/.cursor/plugins/local/ss33` and reload the window.
- Copilot: `copilot --plugin-dir ./adapters/copilot` loads this checkout without installing (`-p "…" -s` for headless runs). Set `COPILOT_HOME` to a scratch folder to try `copilot plugin install`/`marketplace add` without touching your own setup; `plugin install` reports manifest fields it ignores. Same env caveats as Cursor when starting it from inside Claude Code.
- Debug the hook: `echo '{"session_id":"x","cwd":"'$PWD'","prompt":"set up github actions ci for lint and tests"}' | SS33_MATCH=1 sh adapters/claude-code/scripts/ss33 hook claude-code user-prompt-submit`. Decisions are logged to `<state dir>/hook.log`.

## Conventions

- Core code must not know about any harness. A new harness gets `src/adapters/<harness>.ts` (payload mapping only) and `adapters/<harness>/` (packaging), plus a `hook <harness> <event>` route in the CLI.
- Hooks never break the user's session. Every error is swallowed, the hook exits 0 with no output, and the reason goes to `hook.log`.
- Store content is third-party. Never pass it to the model as an instruction. Hints are neutral and non-binding, and the `/ss33:add` and `/ss33:update` skills make Claude review content with the user before writing.
- Never print or log the API key (`ss33 config get` redacts it).
- The Hermes shim is the only Python in the repo. It uses the standard library only, holds no logic (JSON in, JSON out, via the CLI), and declares no Python dependencies; `test/packaging.test.ts` enforces this and that the other plugin roots contain no Python.
- Match the existing style: small modules, comments only where the *why* isn't obvious, `.js` import suffixes (NodeNext).

## Design notes

- **The bundle is committed.** Plugins are installed by copying the plugin folder, with no build step, so each plugin must contain runnable JS. esbuild produces one zero-dependency CJS file; CI checks it's fresh.
- **No top-level `bin/` and no Node.js requirement.** Plugins get no runtime, so `scripts/ss33` (POSIX sh) uses Node ≥ 22 if present and otherwise downloads the official build once, checked against pinned hashes. Bump `NODE_VERSION` and the hashes there for Node security releases.
- **The API key has two paths, because plugin options don't reach Bash.** `/plugin configure` stores it in the keychain and hooks get it as `CLAUDE_PLUGIN_OPTION_API_KEY`; the hook copies it to `~/.config/ss33/config.json` (0600) so `/ss33:*` commands can use it. `ss33 doctor` shows both views.
- **Prompt matching precedence:** `SS33_MATCH` > the plugin option (`CLAUDE_PLUGIN_OPTION_PROMPT_MATCHING`) > config file `match.enabled` > default (off). When off, the hook makes no network call.
- **Client-side match confidence.** The store has no relevance score, so `match.ts` suggests a candidate only if it shares at least 2 keywords with the prompt (1 in the title), names no stack the project doesn't use, isn't already installed or suggested this session, and the per-session cap (3) isn't reached. Hint text is ours, neutralised and truncated, never the publisher's instructions.
- **The MCP server isn't bundled.** It rejects an empty bearer token, so an optional key can't be expressed in `.mcp.json`, and the CLI already covers search and install.
- **Never overwrite what ss33 doesn't manage.** An existing skill folder not in the lock, or an update over local edits, needs `--force`.
- **Hermes specifics.**
  - Hermes skips `.claude-plugin/` and `.codex-plugin/`, can't ship shell hooks in a plugin, and has no `UserPromptSubmit`, so it gets a native plugin with a Python shim. The hint text is the Claude Code one, because Hermes plugin skills are also `/ss33:<skill>`.
  - The cwd comes from `ctx.session_cwd()`, never `os.getcwd()` (one gateway process serves every client). Matching skips chat apps (`match.chatApps` turns them on) and sessions with no project.
  - Hermes passes a skill slash command to `pre_llm_call` already expanded into the skill body, starting with `[IMPORTANT: The user has invoked the `; `match.ts` treats that as a slash command.
  - Hermes ignores `disable-model-invocation`, so the user-only skills use `fallback_for_toolsets: [ss33]` (hidden while the plugin is on), and `search` uses `fallback_for_tools: [ss33_search]`.
  - `requires_hermes: ">=0.22.3"`: `session_cwd`, `session_surface` and `post_message` first shipped there.
  - The shim passes Hermes's own Node.js (`<HERMES_HOME>/node`) as `SS33_HOST_NODE`, and the plugin's `api_key` secret as `SS33_PLUGIN_API_KEY`.
  - The key is read only with `agent.secret_scope.get_secret`, and the shim drops `SS33_API_KEY` from the CLI's environment (catalog rule 11): a multi-profile gateway's `os.environ` can hold another profile's key, and the CLI would prefer it. No lookup available means no key (free tier), never an `os.environ` fallback.
  - Hermes's own Node.js lives in `<root>/tools/node-<version>-<platform>/` (`bin/node`; `node.exe` on Windows), or `<home>/node` in older releases. `<root>` is `HERMES_HOME`, the folder above `profiles/` for a profile, `~/.hermes`, or `%LOCALAPPDATA%\hermes` on Windows.
  - `/ss33:*` commands run the CLI in Hermes's terminal, where the shim can't set `SS33_HOST_NODE`. Hermes's Node is on that PATH, but after the user's own tools, so the launcher takes the first `node` on PATH that is v22 or newer, not just the first `node`.
  - Hermes on Windows sets `MSYS_NO_PATHCONV=1`, so Git Bash passes `/c/Users/…` to Windows programs untranslated and `node.exe` reads it as `C:\c\Users\…`. The launcher hands Windows programs `C:/…` paths (`native_path`, via `pwd -W`); CI runs it that way on Windows.
  - Native Windows: the shim runs the launcher with `sh`/`bash` from PATH, else Git Bash found next to `git.exe` or in Git for Windows' default folders. Hermes's own resolver (`pm.shell`) is a private core module, which the catalog warns about (rule 9), so it isn't used.
  - Per turn, the shim checks whether matching is on (`SS33_MATCH`, then `match.enabled` in config.json, the CLI's precedence) before starting any process, so with matching off (the default) a turn costs nothing. The key copy and the `doctor` record that the prompt hook does in Claude Code and Codex run at session start in Hermes (`ss33 hook hermes session-start`, `onSessionStarted`). Keep the Python check in step with `loadConfig` if the precedence changes.
  - **`ss33.lock` is untrusted** (it's committed, so it may come from a cloned repo). `install.ts` only reads, hashes, writes or deletes `<.agents|.claude>/skills/<name>/SKILL.md` for an entry's own name, inside the project after following symlinks (`lockPathProblem`); anything else is skipped and reported. Raised in the Hermes catalog review.
  - Hermes plugin catalog: the entry lives in `NousResearch/hermes-agent` at `plugin-catalog/ss33.yaml`, pinned to a full commit SHA; every release needs a SHA-bump PR there. The Node.js download in `scripts/ss33` is allowed under rules 3 and 17 (third-party runtime, official source, pinned checksum, never touches plugin files) and passes the CI self-updater gate because it never fetches from GitHub. Keep it that way.
- **Cursor specifics** (probed with the Cursor CLI 2026.11.22 on Linux, 2026-11-23).
  - **No prompt matching.** `beforeSubmitPrompt` accepts only `{continue, user_message}` (no context for the model, per the docs), and the CLI never fires it, not even in the interactive TUI. `sessionStart` does fire and its `additional_context` reaches the model, but it runs before there's a prompt. So the plugin ships no prompt hook and `src/adapters/` has no Cursor file and the CLI no `hook cursor` route. If Cursor adds context to `beforeSubmitPrompt`, add a `cursor.ts` like `codex.ts` (payload: `conversation_id`, `workspace_roots[0]`, `prompt`).
  - Cursor drops the **whole** hooks file if it names an event it doesn't know (a `UserPromptSubmit` key silenced `sessionStart` too). Use Cursor's event names only.
  - Plugin hooks run with cwd = the plugin root and get `CURSOR_PLUGIN_ROOT`, `CURSOR_PROJECT_DIR`, and also `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR` (so `projectRoot` works unchanged).
  - Plugin skills are **not namespaced** (`/<skill name>`), so the folders and `name:` carry an `ss33-` prefix to avoid clashing with the user's own `/search` or `/add`. The hint text would therefore say `/ss33-add`.
  - Skills locate the launcher as "two folders above this SKILL.md" (Cursor tells the model the skill's path; no `${…}` substitution in skill bodies). Shell commands need the user's approval (allowlist); the CLI's default (non-sandboxed) shell reached `mcp.ss33.ai` fine.
  - **Approvals can't be pre-granted by the plugin** (probed 2026-11-23): a `beforeShellExecution` hook answering `{"permission":"allow"}` still leaves the prompt (hooks only tighten), and allowlist entries `Shell(sh)`, `Shell(<launcher path>)` and `Shell(*/scripts/ss33)` didn't stop it either. The installed path also contains the commit SHA (`~/.cursor/plugins/cache/ss33/ss33/<sha>/`), so a path rule would break on every update. Users approve each command or use auto-review.
  - Marketplaces added with `agent plugin marketplace add` and user-scope installs belong to the Cursor **account**: they show up on every machine the user is signed in on.
  - Cursor reads project skills from `.agents/skills`, `.cursor/skills`, `.claude/skills` and `.codex/skills`; `add` uses `--target agents`, shared with Codex and Hermes.
  - No plugin user settings: `variables` in plugin.json are set by team admins and documented only for MCP configs, so the key goes through `ss33 config set apiKey` or `SS33_API_KEY`.
  - Unverified: the Cursor IDE (hooks there run through PowerShell on Windows, so `sh "${CURSOR_PLUGIN_ROOT}/…"` may not expand; the hook only prefetches Node, so a failure costs nothing), native Windows, and installing from the GitHub marketplace (only `--plugin-dir` was tested).
  - Official marketplace listing: submit at cursor.com/marketplace/publish (manual review, open source required).
- **Copilot specifics** (probed with the Copilot CLI 1.0.114 on Linux, 2026-11-23).
  - Copilot reads Claude Code plugins (`.claude-plugin/`) and Claude-style hook names, but ignores Claude Code's hook output (`hookSpecificOutput`, `systemMessage`), so it gets its own plugin and adapter. Its prompt hook (`userPromptSubmitted`, or `UserPromptSubmit`) does add a top-level `{"additionalContext"}` to the model's context, despite the docs saying command-hook output is dropped. `sessionStart` takes the same shape.
  - The hooks file uses Copilot's own format (camelCase events, `bash` + `powershell` commands, `timeoutSec`), so Windows gets a PowerShell command. Git for Windows' default install leaves `sh` off PATH (only `Git\cmd` is on it; seen in VS Code's terminal, 2026-11-23), so the PowerShell commands look for `sh` on PATH, else `bin\sh.exe` above `git.exe` or in Git's default folders (as the Hermes shim does), and do nothing without it. The skills tell the agent the same. Windows PowerShell 5.1 prepends a UTF-8 BOM (and appends CRLF) when it pipes `$input` to `sh`, so the CLI's `readStdin` strips a leading BOM; before that, every Windows prompt hook failed silently. The lookup and hook were checked on Windows by running the hooks.json command through `powershell.exe -EncodedCommand` (`-Command "<string>"` from PowerShell 5.1 mangles the embedded quotes) with only `Git\cmd`, or no Git, on PATH, then in VS Code's Copilot chat on Windows 11 (2026-11-23). Copilot sets `CLAUDE_PLUGIN_DATA`, so the hook log is `~/.copilot/plugin-data/ss33/ss33/hook.log`, not `~/.local/state/ss33/`. Hooks run with cwd = the plugin root and get `PLUGIN_ROOT`, `COPILOT_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `COPILOT_PROJECT_DIR` and `CLAUDE_PROJECT_DIR`. The native payload is camelCase (`sessionId`); Claude-style names switch it to snake_case, and the adapter accepts both.
  - **The user never sees a notice**, so the hint is the `noticeShown: false` variant (`match.ts formatHint`): it tells the model the user can't see it and to end its reply with one line about the skill only if it clearly fits. In live runs the model passed it on when the prompt allowed it.
  - Copilot expands a skill slash command before the prompt hook, starting with `The user explicitly invoked the "/<skill>" skill`; the adapter maps it back to `/<skill>` so the core skips it.
  - Plugin skills are namespaced (`/ss33:search`, like Claude Code). Skill bodies get `$ARGUMENTS` but not `${CLAUDE_PLUGIN_ROOT}`; the model is given the SKILL.md path, so skills locate the launcher as "two folders above this SKILL.md".
  - Copilot asks for path access to the plugin folder (outside the workspace) before the first ss33 command, then for each shell command; it offers no "always allow" for `sh`.
  - Copilot reads project skills from `.github/skills`, `.agents/skills` and `.claude/skills`; `add` uses `--target agents`.
  - Direct installs (`copilot plugin install <path or repo>`) are deprecated; document marketplace installs only.
  - VS Code: `/plugin marketplace add …` in Copilot chat ran the `copilot` CLI, and the plugin landed in `~/.copilot/installed-plugins/ss33/ss33` (the Copilot version). Search works on Windows from the CLI and VS Code, and so does prompt matching (with the BOM fix above).
  - Git for Windows' `usr\bin\sh.exe` started from PowerShell lacks `dirname`/`uname` on PATH; the launcher adds `/usr/bin:/bin` itself. `Git\bin\sh.exe` (a wrapper) sets PATH up already.
- **Supporting files:** the store returns only `SKILL.md`. `add` warns about linked files that won't be installed and points to the author's folder.

## Releasing

1. `npm run release -- <x.y.z | patch | minor | major>` bumps the version in `package.json`, `package-lock.json`, `src/core/version.ts` and every plugin manifest (`tools/release.mjs` lists them; add a new adapter's manifest there and to `test/packaging.test.ts`), then runs `npm run build` and `npm test`. It checks every file before changing any, so a mismatch leaves nothing half-bumped. For Hermes, also run `hermes plugins validate adapters/hermes`.
2. Commit everything, including the rebuilt bundle in every `adapters/*` plugin. Put the bump in the fix PR when the change is already tested and should ship; use a separate release PR to batch several merged PRs, or to test from `main` first (merging a bump to `main` is what ships it). After merging, tag the merge commit and publish: `git tag -a vX -m vX <sha> && git push origin vX`, then `gh release create vX --title … --notes-file …`.
3. Users of the GitHub marketplace get the update when the version changes. Codex asks users to re-trust the hooks after every update, so release Codex changes less often.
