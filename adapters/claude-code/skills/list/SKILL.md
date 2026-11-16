---
name: list
description: List the Skill Store skills installed in this project and check their files still match ss33.lock.
disable-model-invocation: true
allowed-tools: Bash(sh "${CLAUDE_PLUGIN_ROOT}/scripts/ss33":*)
---

Run the ss33 CLI as `sh "${CLAUDE_PLUGIN_ROOT}/scripts/ss33" <command>` (it is not on PATH). If its output mentions `ss33 <command>`, that means the same thing.

Run:

```
sh "${CLAUDE_PLUGIN_ROOT}/scripts/ss33" list
```

Show the result. `✎ modified` means someone edited the installed file, and `✗ missing` means the file was deleted. In both cases, `/ss33:update` with `--force`, or reinstalling with `/ss33:add`, restores the pinned version. To remove a skill: `sh "${CLAUDE_PLUGIN_ROOT}/scripts/ss33" remove <name>`, but only if the user asks.
