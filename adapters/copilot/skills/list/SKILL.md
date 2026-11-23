---
name: list
description: List the Skill Store skills installed in this project and check that their files still match ss33.lock. Only when the user invokes it.
disable-model-invocation: true
---

Run the ss33 CLI with `sh "<plugin root>/scripts/ss33" <command>`, using the absolute path. It is not on PATH. The plugin root is two folders above this SKILL.md, which sits at `<plugin root>/skills/list/SKILL.md`. If the output mentions `ss33 <command>`, it means the same command.

Copilot asks the user to approve shell commands. That is expected: run the command and let the user approve it. The CLI needs network access to `mcp.ss33.ai`. If a command fails with a network error (for example because the session runs in Copilot's sandbox), tell the user, and don't try to work around it.

Run:

```
sh "<plugin root>/scripts/ss33" list
```

Show the user the result.
- `✎ modified` means someone edited the installed file. `✗ missing` means the file was deleted. In both cases, `/ss33:update` with `--force`, or reinstalling with `/ss33:add`, restores the pinned version.
- To remove a skill, run `sh "<plugin root>/scripts/ss33" remove <name>`, but only if the user asks.
