# CLAUDE.md

## Answer style

Keep answers **short but well explained**. Prefer clarity over grammar — if
dropping articles, using fragments, or writing informally makes the point
land faster, do it.

- Lead with the answer / the change, not with context.
- Explain the *why* in one or two lines, not a paragraph.
- No preambles ("Great question", "Let me look into...") and no recaps of
  what was just shown.
- Bullets over prose when listing more than two things.
- Code and file references speak for themselves — don't narrate them.

## Running node commands

`npm` from Windows does not work here. Run through WSL with the nvm PATH:

```
wsl.exe bash -lc "cd ~/Workspace/automations && npm run <script>"
```
