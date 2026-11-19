# ss33 Skill Store for agents

> **Public beta.** Things may change between versions, and prompt-matching suggestions are still being tuned. Feedback and bug reports: [support@readyai.ai](mailto:support@readyai.ai) or [GitHub Issues](https://github.com/afterpartyai/ss33-skill-store-for-agents/issues).

Use the [ss33 Skill Store](https://ss33.ai) from your coding agent without spending model tokens on searching:

- **`/ss33:search`**: finds skills that fit *this* project. A short summary of the stack goes with the search: package manager, versions, services. It's built from manifest files only, never your source code.
- **`/ss33:add <ref>`**: reviews a skill with you, then installs it as a native skill (`.claude/skills/<name>/SKILL.md`), pinned in `ss33.lock` so your team gets the same version.
- **`/ss33:update`**: shows what changed upstream and applies updates only when you say so. It never overwrites your local edits without asking.
- **Prompt matching (off by default, opt in)**: if a published skill clearly fits what you just asked, you see a one-line note suggesting it (`/ss33:add <ref>` to review it). At most a few per session. It sends your prompt to the store, so it stays off until you turn it on (see [Privacy](#privacy)).

Claude Code, Codex and [Hermes Agent](https://github.com/NousResearch/hermes-agent) are supported. In Codex the commands are written `$ss33:search`, `$ss33:add`, and so on. In Codex and Hermes, skills install to `.agents/skills/`.

## Install (Claude Code)

```
/plugin marketplace add afterpartyai/ss33-skill-store-for-agents
/plugin install ss33@ss33
```

Claude Code asks for the two settings below when you install. Change them later with `/plugin configure ss33@ss33`, or run `/ss33:setup`.

To get updates automatically, turn on auto-update for the `ss33` marketplace under `/plugin` → Marketplaces (it's off by default for marketplaces other than Anthropic's).

Settings:

- **API key**: create one at https://ss33.ai/skills/account (the free tier allows 5 searches/minute). It's stored in your OS keychain; on your next prompt the plugin also copies it to `~/.config/ss33/config.json` (0600) so `/ss33:search` and `/ss33:add` use it too. `/ss33:setup` checks that the store accepts it.
- **Prompt matching**: off by default; switch it on here if you want suggestions.

No other installs are needed. ss33 runs on Node.js: it uses yours if you have version 22 or newer, and otherwise downloads the official Node.js build once (about 30 MB, checked against a pinned checksum) into `~/.cache/ss33/runtime`. The download starts in the background when your first session starts, so it never holds up a prompt.

## Install (Codex)

Needs Codex 0.164 or newer (tested with 0.164 and 0.167):

```
codex plugin marketplace add afterpartyai/ss33-skill-store-for-agents
codex plugin add ss33@ss33
```

Then start a new Codex session and run `$ss33:setup` to set your API key and, if you want it, turn on prompt matching. Codex will also say **"Hooks need review"**: trust the two ss33 hooks (or review them in `/hooks`). Without that, the commands still work but prompt matching can't run. Codex asks again after every plugin update, because trust is tied to the plugin's contents.

What's different from Claude Code:

- **Commands** are skills: `$ss33:search <task>`, `$ss33:add <ref>`, `$ss33:update`, `$ss33:list`, `$ss33:setup`.
- **Approvals:** Codex's default sandbox blocks network access and keeps `.agents/` read-only, so Codex asks you to approve each ss33 command. To stop being asked, choose the option that allows the `sh …/scripts/ss33` prefix.
- **Installed skills** go to `.agents/skills/<name>/` and are pinned in `ss33.lock`. Codex loads them in new sessions as `$<name>`.
- **API key:** Codex plugins have no settings screen. In your own terminal, run the command `$ss33:setup` shows you (`sh <plugin root>/scripts/ss33 config set apiKey <key>`). It writes `~/.config/ss33/config.json` (0600). Don't paste the key into the chat. An `SS33_API_KEY` exported in your shell isn't reliable in Codex: its background app server may have started before you set it.
- **Prompt matching** is off by default. Turn it on (or off again) with `$ss33:setup`, or disable the ss33 hook in `/hooks`.

## Install (Hermes Agent)

Needs Hermes 0.22.3 or newer (tested with 0.23.2):

```
hermes plugins install afterpartyai/ss33-skill-store-for-agents/adapters/hermes --enable
```

Then start a new session inside a project and run `/ss33:setup` to check the connection and, if you want it, turn on prompt matching. Hermes uses its own Node.js for ss33 when it has one, so there's usually nothing to download.

What's different from Claude Code:

- **Commands** (`/ss33:search`, `/ss33:add`, `/ss33:update`, `/ss33:list`, `/ss33:setup`) work in Hermes's interactive terminal, TUI and desktop app. Hermes doesn't offer plugin commands in `hermes chat -q` or in chat apps (Telegram, Slack, …).
- **Search tool:** the agent can search the store itself with the `ss33_search` tool, and suggests `/ss33:add <ref>` rather than installing anything.
- **Installed skills** go to `.agents/skills/<name>/` and are pinned in `ss33.lock`. Hermes loads project skills only from repos you trust: run `hermes skills trust` in the repo once. New sessions then have the skill as `/<name>`.
- **API key:** set it in the desktop app (Settings → Plugins → ss33), or add `SS33_API_KEY=<key>` to `~/.hermes/.env`. The plugin copies it to `~/.config/ss33/config.json` (0600) when your next session starts, so `/ss33:*` commands use it too. Don't paste the key into the chat.
- **Prompt matching** is off by default. Turn it on (or off again) with `/ss33:setup`. Even when it's on, it only runs for sessions inside a project, and never for prompts from chat apps unless you also turn on `match.chatApps`.
- **Terminal backend:** `/ss33:*` commands run in Hermes's terminal, so they need the local backend (not docker, modal, …). Prompt matching and `ss33_search` run inside Hermes and work with any backend.

## Commands

| Command | What it does |
|---|---|
| `/ss33:search <task>` | Search the store (Claude may also use this on its own for specialised tasks) |
| `/ss33:add <ref>` | Preview, review and install a skill |
| `/ss33:update [name…]` | Check for and apply updates |
| `/ss33:list` | Installed skills, and whether their files still match the lock |
| `/ss33:setup` | Show settings, check that the store accepts your key, and explain any problems |

The same operations are available as a CLI (`ss33 search | add | update | remove | list | fingerprint | config | doctor`). Run `ss33 help` for details.

Claude Code puts `ss33` on the PATH only for commands it runs itself, not in your own terminal. To use it there, install it globally (this route needs npm, so Node.js ≥ 22):

```
git clone https://github.com/afterpartyai/ss33-skill-store-for-agents.git
npm install -g ./ss33-skill-store-for-agents
```

This links to the clone, so `git pull` there updates the CLI. (Installing straight from GitHub with `npm install -g github:…` doesn't work: npm links to a temporary clone that it then deletes.)

## Privacy

- **Searches** send your query plus the project summary (see it with `ss33 fingerprint`).
- **Prompt matching** (only if you turn it on) sends each prompt (truncated to 600 characters) plus the summary.
- **Never sent:** source code, file contents or dependency trees.

The store's [privacy policy](https://ss33.ai/skills/privacy) covers everything the plugin sends: searches, matched prompts and the project summary all go to the Skill Store's MCP server at `mcp.ss33.ai`. The plugin sends nothing anywhere else, apart from a one-time Node.js download from nodejs.org if you don't have Node ≥ 22.

## Support

Email [support@readyai.ai](mailto:support@readyai.ai), or open an issue on [GitHub](https://github.com/afterpartyai/ss33-skill-store-for-agents/issues).

## Development

See [CLAUDE.md](CLAUDE.md) for the layout, the commands and the conventions.

```
npm install
npm test             # unit, fake-store, end-to-end and matching-regression tests (offline)
npm run eval:matching  # prompt-matching precision/recall report
npm run build        # typecheck + rebuild the bundle in adapters/claude-code, adapters/codex and adapters/hermes (commit all three)
claude --plugin-dir ./adapters/claude-code
codex plugin marketplace add "$PWD" && codex plugin add ss33@ss33   # Codex, from this checkout
hermes plugins validate adapters/hermes   # Hermes manifest, registrations and security scan
```

## License

[MIT](LICENSE)
