---
name: ss33-setup
description: Show and change ss33 plugin settings (API key, endpoint). Only when the user invokes it.
disable-model-invocation: true
---

Run the ss33 CLI with `sh "$DSH_SS33_PLUGIN_ROOT/scripts/ss33" <command>`. It is not on PATH. DSH sets `DSH_SS33_PLUGIN_ROOT` in every shell command; if it is empty, use the absolute path of the folder two levels above this skill's folder, which is `<plugin root>/skills/ss33-setup/`. Run it from the user's workspace, never after `cd`-ing into the plugin folder. If the output mentions `ss33 <command>`, it means the same command.

On Windows, if you only have PowerShell, check once that `sh` is found (`Get-Command sh`): Git for Windows often doesn't put it on PATH. If it isn't found, use Git for Windows' `sh.exe` by its full path: usually `C:\Program Files\Git\bin\sh.exe`, otherwise `bin\sh.exe` in the folder above the one holding `git.exe`. In PowerShell, run `& "<path to sh.exe>" "$env:DSH_SS33_PLUGIN_ROOT/scripts/ss33" <command>`. If Git for Windows isn't installed, tell the user ss33 needs it.

The CLI needs network access to `mcp.ss33.ai`. If a command fails with a network or permission error (DSH's sandbox can block either), tell the user and offer to run it again with the permission it needs. Don't try to work around it another way.

1. Check the current settings:

   ```
   sh "$DSH_SS33_PLUGIN_ROOT/scripts/ss33" doctor
   ```

   The output shows the settings commands use. It also makes one search to check whether the store accepts the API key, and lists any problems with a fix. Tell the user about those problems first.

   The "Prompt-matching hook" lines describe prompt matching, which is off by default. When it's on, the plugin checks each new prompt against the store and shows the user a one-line note when a skill may fit. The user turns it on with `sh "$DSH_SS33_PLUGIN_ROOT/scripts/ss33" config set match.enabled true` (and off with `false`); it takes effect on the next prompt. Offer to run it when they ask; it writes `~/.config/ss33/config.json`, outside the workspace, so the sandbox may need the user's approval, or they can run it in a terminal of their own.

2. Explain the API key setting.

   It's optional and raises the free tier's limit of 5 searches a minute. The user should never paste the key into this chat, and you must never handle its value. They can set it either way:
   - In a terminal of their own (not through you), run the command below. Fill in the absolute plugin-root path (the value of `DSH_SS33_PLUGIN_ROOT`) for them so they can copy it.

     ```
     sh "<plugin root>/scripts/ss33" config set apiKey <key>
     ```

     This writes `~/.config/ss33/config.json` with permissions 0600.
   - Or export `SS33_API_KEY` in the environment that starts DSH (the shell running `dsh`, or DSH Desktop's).

3. Change a setting only when the user asks.

4. To see what the project summary contains, run `sh "$DSH_SS33_PLUGIN_ROOT/scripts/ss33" fingerprint`.
