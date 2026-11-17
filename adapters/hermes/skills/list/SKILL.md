---
name: list
description: List the Skill Store skills installed in this project and check that their files still match ss33.lock. Only when the user invokes /ss33:list.
metadata:
  hermes:
    # Kept out of the model's skill list while the plugin is on: only the user runs /ss33:list.
    fallback_for_toolsets: [ss33]
---

Run the ss33 CLI with the terminal tool as `sh "${HERMES_SKILL_DIR}/../../scripts/ss33" <command>`, from the project's directory. It is not on PATH. If the output mentions `ss33 <command>`, it means the same command.

Run:

```
sh "${HERMES_SKILL_DIR}/../../scripts/ss33" list
```

Show the user the result.
- `✎ modified` means someone edited the installed file. `✗ missing` means the file was deleted. In both cases, `/ss33:update` with `--force`, or reinstalling with `/ss33:add`, restores the pinned version.
- To remove a skill, run `sh "${HERMES_SKILL_DIR}/../../scripts/ss33" remove <name>`, but only if the user asks.
- If skills are listed but Hermes doesn't offer them, the repo probably isn't trusted yet: the user runs `hermes skills trust` in it once.
