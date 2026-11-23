---
name: ss33-setup
description: Show and change ss33 plugin settings (API key, endpoint). Only when the user invokes it.
disable-model-invocation: true
---

Run the ss33 CLI with `sh "<plugin root>/scripts/ss33" <command>`, using the absolute path. It is not on PATH. The plugin root is two folders above this SKILL.md, which sits at `<plugin root>/skills/ss33-setup/SKILL.md`. If the output mentions `ss33 <command>`, it means the same command.

Cursor asks the user to approve each shell command that isn't on their allowlist. That is expected: run the command and let the user approve it. The CLI needs network access to `mcp.ss33.ai`. If a command fails with a network error (for example because the session runs in Cursor's sandbox), tell the user and offer to run it again outside the sandbox. Don't try to work around it another way.

1. Check the current settings:

   ```
   sh "<plugin root>/scripts/ss33" doctor
   ```

   The output shows the settings commands use. It also makes one search to check whether the store accepts the API key, and lists any problems with a fix. Tell the user about those problems first.

   Ignore the "Prompt-matching hook" lines: Cursor's plugin hooks can't add a note to a prompt, so the Cursor plugin has no prompt matching. To find skills, the user runs `/ss33-search`, and you can also search when a task needs a specialised procedure.

2. Explain the API key setting.

   It's optional and raises the free tier's limit of 5 searches a minute. The user should never paste the key into this chat, and you must never handle its value. They can set it either way:
   - In a terminal of their own (not through you), run the command below. Fill in the absolute plugin-root path for them so they can copy it.

     ```
     sh "<plugin root>/scripts/ss33" config set apiKey <key>
     ```

     This writes `~/.config/ss33/config.json` with permissions 0600.
   - Or export `SS33_API_KEY` in the shell that starts Cursor (`cursor` or `agent`).

3. Change a setting only when the user asks.

4. To see what the project summary contains, run `sh "<plugin root>/scripts/ss33" fingerprint`.
