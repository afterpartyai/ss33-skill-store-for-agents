---
name: list
description: List the Skill Store skills installed in this project and check that their files still match ss33.lock. Only when the user invokes it.
---

Run the ss33 CLI with `sh "<plugin root>/scripts/ss33" <command>`, using the absolute path. It is not on PATH. The plugin root is two folders above this SKILL.md, which sits at `<plugin root>/skills/list/SKILL.md`. If the output mentions `ss33 <command>`, it means the same command.

The CLI needs network access to `mcp.ss33.ai`, which Codex's default sandbox blocks. So run every ss33 command with escalated permissions from the start, with a one-line reason (for example "ss33 needs to reach the Skill Store"). The user approves it, and can allow the `sh "<plugin root>/scripts/ss33"` prefix once to stop being asked again. If this session can't escalate (for example it never asks for approval), run the command normally. If it then fails with a network error, tell the user, and don't try to work around the sandbox.

Run:

```
sh "<plugin root>/scripts/ss33" list
```

Show the user the result.
- `✎ modified` means someone edited the installed file. `✗ missing` means the file was deleted. In both cases, `$ss33:update` with `--force`, or reinstalling with `$ss33:add`, restores the pinned version.
- To remove a skill, run `sh "<plugin root>/scripts/ss33" remove <name>`, but only if the user asks.
