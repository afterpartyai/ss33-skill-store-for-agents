---
name: setup
description: Show and change ss33 plugin settings (API key, prompt matching, endpoint). Only when the user invokes /ss33:setup.
metadata:
  hermes:
    # Kept out of the model's skill list while the plugin is on: only the user runs /ss33:setup.
    fallback_for_toolsets: [ss33]
---

Run the ss33 CLI with the terminal tool as `sh "${HERMES_SKILL_DIR}/../../scripts/ss33" <command>`. It is not on PATH. If the output mentions `ss33 <command>`, it means the same command.

1. Check the current settings:

   ```
   sh "${HERMES_SKILL_DIR}/../../scripts/ss33" doctor
   ```

   The output shows what commands use and what the prompt-matching hook saw on the last prompt. It also makes one search to check whether the store accepts the API key, and lists any problems with a fix. Tell the user about those problems first.

   If the hook has no record at all, the plugin's hook hasn't run yet: check that the plugin is enabled (`hermes plugins list`), then send a prompt from inside a project. The hook skips prompts from chat apps and from sessions outside a project.

2. Explain the settings that matter.

   **API key.** It's optional and raises the free tier's limit of 5 searches a minute. The user should never paste the key into this chat, and you must never handle its value. They can set it in any of these ways:
   - In the Hermes desktop app: Settings → Plugins → ss33 → API key.
   - Add a line `SS33_API_KEY=<key>` to their Hermes `.env` file (`~/.hermes/.env`, or the profile's own), then start a new session.
   - In a terminal of their own (not through you), run the command below. Fill in the absolute path for them so they can copy it.

     ```
     sh "<absolute path of ${HERMES_SKILL_DIR}/../../scripts/ss33>" config set apiKey <key>
     ```

     This writes `~/.config/ss33/config.json` with permissions 0600.

   The plugin's hook copies a key set in Hermes into that config file when a session starts, so ss33 commands use it too. A key added mid-session reaches the commands in the next session.

   **Prompt matching.** It's off by default. When it's on, each prompt from Hermes's terminal, TUI, desktop app or editor clients, for sessions inside a project, plus a short project summary (never source code) is sent to the Skill Store, and the user may see a one-line "a published skill may fit this task" note, at most a few per session. If it's off, ask the user whether they'd like to turn it on, and say what it sends. When they say yes, run:

   ```
   sh "${HERMES_SKILL_DIR}/../../scripts/ss33" config set match.enabled true
   ```

   `false` turns it off again. The setting is shared with ss33 in other agents on this machine (Claude Code, Codex).

   **Chat apps.** Prompts that arrive through Telegram, Slack, Discord and other chat apps are not matched, because they usually have no project. To match them too, run:

   ```
   sh "${HERMES_SKILL_DIR}/../../scripts/ss33" config set match.chatApps true
   ```

3. Otherwise, change a setting only when the user asks.

4. To see what the project summary contains, run `sh "${HERMES_SKILL_DIR}/../../scripts/ss33" fingerprint` from the project's directory.
