---
name: setup
description: Show and change ss33 plugin settings (API key, prompt matching, endpoint). Only when the user invokes it.
disable-model-invocation: true
---

Run the ss33 CLI with `sh "<plugin root>/scripts/ss33" <command>`, using the absolute path. It is not on PATH. The plugin root is two folders above this SKILL.md, which sits at `<plugin root>/skills/setup/SKILL.md`. If the output mentions `ss33 <command>`, it means the same command.

On Windows, check once that `sh` is found (`Get-Command sh` in PowerShell): Git for Windows often doesn't put it on PATH. If it isn't found, use Git for Windows' `sh.exe` by its full path: usually `C:\Program Files\Git\bin\sh.exe`, otherwise `bin\sh.exe` in the folder above the one holding `git.exe`. In PowerShell, run `& "<path to sh.exe>" "<plugin root>/scripts/ss33" <command>`. If Git for Windows isn't installed, tell the user ss33 needs it.

Copilot asks the user to approve shell commands. That is expected: run the command and let the user approve it. The CLI needs network access to `mcp.ss33.ai`. If a command fails with a network error (for example because the session runs in Copilot's sandbox), tell the user, and don't try to work around it.

1. Check the current settings:

   ```
   sh "<plugin root>/scripts/ss33" doctor
   ```

   The output shows what commands use and what the prompt-matching hook saw on the last prompt. It also makes one search to check whether the store accepts the API key, and lists any problems with a fix. Tell the user about those problems first.

   If the hook has no record at all, the prompt hook hasn't run yet: it records itself on the next prompt the user sends.

2. Explain the two settings that matter.

   **API key.** It's optional and raises the free tier's limit of 5 searches a minute. The user should never paste the key into this chat, and you must never handle its value. They can set it either way:
   - In a terminal of their own (not through you), run the command below. Fill in the absolute plugin-root path for them so they can copy it.

     ```
     sh "<plugin root>/scripts/ss33" config set apiKey <key>
     ```

     This writes `~/.config/ss33/config.json` with permissions 0600.
   - Or export `SS33_API_KEY` in the shell that starts Copilot.

   **Prompt matching.** It's off by default. When it's on, each prompt plus a short project summary (never source code) is sent to the Skill Store, and when a published skill clearly fits, you get a note about it and mention it to the user in one line, at most a few times per session. If it's off, ask the user whether they'd like to turn it on, and say what it sends. When they say yes, run:

   ```
   sh "<plugin root>/scripts/ss33" config set match.enabled true
   ```

   `false` turns it off again.

3. Change a setting only when the user asks.

4. To see what the project summary contains, run `sh "<plugin root>/scripts/ss33" fingerprint`.
