# Stira kiro-pack

For people who customize Kiro Crew. It adds the three-layer memory control from Stira:

| Layer | What it is | How it reaches the agent | How it changes |
|---|---|---|---|
| 1. Core | Your mission and the working rules (`steering/<lang>/00-core-principles.md`) | Steering: loaded in every session | Only when you edit it |
| 2. Narrative | A short "where this project stands" per book, distilled from chapters by Stira Stage (no model call) | The `UserPromptSubmit` hook attaches the one related book to a message | Rebuilt whenever chapters change |
| 3. Episodes | The chapters themselves | The agent opens them when needed (skill `stira-memory`) | Never rewritten automatically |

The narrative never outranks the core, and nothing here edits the core. Lessons that show up in two or more chapters are listed as *promotion candidates* (`GET /api/apps/stira-kiro/memory/promotions`, or `memory/stira/narratives/promotions.json`). You decide whether one becomes a lesson or a steering rule.

If you use Kiro Crew as it ships and do not want to touch steering or hooks, use [Stira Forest](https://github.com/Resolver-TNG/Stira-Forest-KiroCrew) instead.

## Install

Stira Stage (this app) must be installed and enabled first: it writes the chapters and the narratives.

```powershell
# Windows: Kiro Crew's bundled Python
& "$env:LOCALAPPDATA\Programs\KiroCrew\resources\backend-dist\kirocrew-backend\python.exe" -s kiro-pack/install.py --lang en --dry-run
& "$env:LOCALAPPDATA\Programs\KiroCrew\resources\backend-dist\kirocrew-backend\python.exe" -s kiro-pack/install.py --lang en
```

The installer copies:

- `steering/<lang>/*.md` to `~/.kiro/steering/`
- `skills/*` to `<KIROCREW_HOME>/skills/` (`worker-brief`: briefs for sub-agents, `spec-protocol`: Requirements → Design → Tasks → Verify)
- the hook script to `<KIROCREW_HOME>/hooks/stira/`

It never overwrites an existing file unless you pass `--force` (the old file is kept as `.bak`). It does not register the hook, because the gateway owns `hooks.json`. Register it in the dashboard under **Customize → Hooks → New hook** with the event `UserPromptSubmit`, an empty matcher, a 10-second timeout, and the command the installer prints.

Then edit the **Core** section of `00-core-principles.md` to state your own agent's mission.

## Cost

- Steering: about 3 KB in every session.
- The hook: no model call. It adds at most 900 characters, and only to a message that clearly matches one book (otherwise nothing). It skips sub-agent turns.
- Narratives and promotion candidates are built by plain rules from existing chapters. Writing chapters is what costs credits (about 1 credit a chapter, capped per day in Stira Stage).

## Limits

- Matching is by shared words and character pairs, not meaning. A message that names the project gets the right book; a vague one gets nothing.
- Conversations whose working folder is the workspace root become one book per session. Bind a project folder to group chapters by project.
- The hook is written against Kiro Crew 0.11's hook contract (JSON event on stdin, stdout added to the turn).
