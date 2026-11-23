---
name: ss33-list
description: List the Skill Store skills installed in this project and check that their files still match ss33.lock. Only when the user invokes it.
disable-model-invocation: true
---

Run the ss33 CLI with `sh "$DSH_SS33_PLUGIN_ROOT/scripts/ss33" <command>`. It is not on PATH. DSH sets `DSH_SS33_PLUGIN_ROOT` in every shell command; if it is empty, use the absolute path of the folder two levels above this skill's folder, which is `<plugin root>/skills/ss33-list/`. Run it from the user's workspace, never after `cd`-ing into the plugin folder. If the output mentions `ss33 <command>`, it means the same command.

On Windows, if you only have PowerShell, check once that `sh` is found (`Get-Command sh`): Git for Windows often doesn't put it on PATH. If it isn't found, use Git for Windows' `sh.exe` by its full path: usually `C:\Program Files\Git\bin\sh.exe`, otherwise `bin\sh.exe` in the folder above the one holding `git.exe`. In PowerShell, run `& "<path to sh.exe>" "$env:DSH_SS33_PLUGIN_ROOT/scripts/ss33" <command>`. If Git for Windows isn't installed, tell the user ss33 needs it.

The CLI needs network access to `mcp.ss33.ai`. If a command fails with a network or permission error (DSH's sandbox can block either), tell the user and offer to run it again with the permission it needs. Don't try to work around it another way.

Run:

```
sh "$DSH_SS33_PLUGIN_ROOT/scripts/ss33" list
```

Show the user the result.
- `✎ modified` means someone edited the installed file. `✗ missing` means the file was deleted. In both cases, `/ss33-update` with `--force`, or reinstalling with `/ss33-add`, restores the pinned version.
- To remove a skill, run `sh "$DSH_SS33_PLUGIN_ROOT/scripts/ss33" remove <name>`, but only if the user asks.
