---
name: setup
description: Show and change ss33 plugin settings — API key, prompt matching, endpoint.
disable-model-invocation: true
allowed-tools: Bash(sh "${CLAUDE_PLUGIN_ROOT}/scripts/ss33":*)
---

Run the ss33 CLI as `sh "${CLAUDE_PLUGIN_ROOT}/scripts/ss33" <command>` (it is not on PATH). If its output mentions `ss33 <command>`, that means the same thing.

1. Check the current settings:

   ```
   sh "${CLAUDE_PLUGIN_ROOT}/scripts/ss33" doctor
   ```

   It shows two views, because Claude Code passes plugin settings (`/plugin configure`) to the prompt-matching hook but not to commands like this one:
   - **Commands**: what `/ss33:search`, `/ss33:add` and the `ss33` CLI use.
   - **Prompt-matching hook**: what the hook saw on the last prompt. This is the truth for prompt matching.

   It also makes one search to check whether the store accepts the key, and lists any problems with a fix. Relay those problems to the user first. The most common one: a key set through `/plugin configure` reaches the hook but not the commands.

2. Explain the two settings that matter:
   - **API key** (optional; raises the free tier's 5 searches/minute). The user should never paste the key into this chat. There are two ways to set it:
     - `/plugin configure ss33@ss33` (recommended; `/plugin` shows the exact name if they installed it from another marketplace) stores it in the OS keychain. On the next prompt the hook also copies it to `~/.config/ss33/config.json` (0600), so the `/ss33:*` commands use it too.
     - Alternatively, `ss33 config set apiKey <key>` in their own terminal (needs the global CLI install) or setting `SS33_API_KEY`.
   - **Prompt matching** (off by default). When it's on, each prompt plus a short project summary (never source code) is sent to the Skill Store, and Claude may get a one-line "this skill may be relevant" note, at most a few per session. If it's off, ask the user whether they'd like to turn it on, and say what it sends. They can switch it with `/plugin configure ss33@ss33` (prompt_matching), or you can run this when they say yes:

     ```
     sh "${CLAUDE_PLUGIN_ROOT}/scripts/ss33" config set match.enabled true
     ```

     (`false` turns it off again.) The plugin setting beats the config file, so if they set it in `/plugin configure`, change it there.

3. Change a setting only when the user asks, and never handle the API key value yourself.

4. To see what the project summary contains, run `sh "${CLAUDE_PLUGIN_ROOT}/scripts/ss33" fingerprint`.
