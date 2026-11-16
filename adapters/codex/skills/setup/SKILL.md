---
name: setup
description: Show and change ss33 plugin settings (API key, prompt matching, endpoint). Only when the user invokes it.
---

Run the ss33 CLI with `sh "<plugin root>/scripts/ss33" <command>`, using the absolute path. It is not on PATH. The plugin root is two folders above this SKILL.md, which sits at `<plugin root>/skills/setup/SKILL.md`. If the output mentions `ss33 <command>`, it means the same command.

The CLI needs network access to `mcp.ss33.ai`, which Codex's default sandbox blocks. So run every ss33 command with escalated permissions from the start, with a one-line reason (for example "ss33 needs to reach the Skill Store"). The user approves it, and can allow the `sh "<plugin root>/scripts/ss33"` prefix once to stop being asked again. If this session can't escalate (for example it never asks for approval), run the command normally. If it then fails with a network error, tell the user, and don't try to work around the sandbox.

1. Check the current settings:

   ```
   sh "<plugin root>/scripts/ss33" doctor
   ```

   The output shows what commands use and what the prompt-matching hook saw on the last prompt. It also makes one search to check whether the store accepts the API key, and lists any problems with a fix. Tell the user about those problems first.

   If the hook has no record at all, its hooks probably aren't trusted yet. Codex runs plugin hooks only after the user reviews them in `/hooks`, and asks again after each plugin update.

2. Explain the two settings that matter.

   **API key.** It's optional and raises the free tier's limit of 5 searches a minute. The user should never paste the key into this chat, and you must never handle its value. They can set it either way:
   - In a terminal of their own (not through you), run the command below. Fill in the absolute plugin-root path for them so they can copy it.

     ```
     sh "<plugin root>/scripts/ss33" config set apiKey <key>
     ```

     This writes `~/.config/ss33/config.json` with permissions 0600.
   - Or export `SS33_API_KEY` in the shell that starts Codex.

   **Prompt matching.** It's off by default. When it's on, each prompt plus a short project summary (never source code) is sent to the Skill Store, and the user may see a one-line "a published skill may fit this task" note, at most a few per session. If it's off, ask the user whether they'd like to turn it on, and say what it sends. When they say yes, run:

   ```
   sh "<plugin root>/scripts/ss33" config set match.enabled true
   ```

   `false` turns it off again, or the user can disable the ss33 hook in `/hooks`. Matching also needs the ss33 hooks to be trusted.

3. Change a setting only when the user asks.

4. To see what the project summary contains, run `sh "<plugin root>/scripts/ss33" fingerprint`.
