# v2 spike: headless slash-command dispatch

Run on 2026-05-04 against `claude` 2.1.126 (path `/Users/mercieca/.local/bin/claude`).

Goal: figure out which CLI-only slash commands are dispatchable through the SDK / headless `claude --print`, so we can pick A vs B vs C in `design.md` v2.

## Method

Each command was invoked two ways:

1. `claude --print --bare "<command>"` — minimal mode, no plugins/hooks/CLAUDE.md, ANTHROPIC_API_KEY only.
2. `claude --print "<command>"` — full setup, real auth (claude.ai subscription via keychain).

For stream-JSON, also ran:

```sh
printf '%s\n' '{"type":"user","message":{"role":"user","content":"hi"}}' \
  | claude --print --verbose \
      --input-format stream-json --output-format stream-json \
      --model haiku
```

`--verbose` is required by the CLI when `--print` is combined with `--output-format stream-json`.

## Per-command results

| Command | `--print` (full auth) | Notes |
| :--- | :--- | :--- |
| `/insights` | ✅ Works. Returns `Your shareable insights report is ready: file:///…/usage-data/report.html` plus a follow-up question. | Real dispatch. Generates an HTML report on disk. |
| `/cost` | ✅ Works. Returns `You are currently using your subscription to power your Claude Code usage`. | Real dispatch, matches interactive output. |
| `/export` | ❌ `"/export isn't available in this environment."` | Hard-blocked headlessly. |
| `/status` | ❌ `"/status isn't available in this environment."` | Hard-blocked. |
| `/help` | ❌ `"/help isn't available in this environment."` | Hard-blocked. (We render our own `/help` overlay anyway.) |
| `/login`, `/logout` | Not executed (mutates auth state). | Behavior assumed-interactive based on `/status`/`/export` precedent. |

`--bare` `/insights` failed with `"Not logged in · Please run /login"` because `--bare` ignores keychain/OAuth and only reads `ANTHROPIC_API_KEY`. Confirms `/insights` actually *runs* under `--bare` (not blocked as interactive-only); it just fails on auth. Same code path as full-auth mode.

## `slash_commands` list from `system/init`

From the stream-JSON init message (subscription auth, current dev cwd):

```
update-config, debug, simplify, batch, fewer-permission-prompts, loop, schedule,
claude-api, develop, setup-matt-pocock-skills, improve-codebase-architecture,
find-skills, triage, diagnose, to-issues, zoom-out, write-a-skill, commit-develop,
grill-with-docs, caveman, tdd, grill-me, to-prd, clear, compact, context, heapdump,
init, review, security-review, extra-usage, usage, insights, team-onboarding
```

Observations:

- The init list is **not** the same as "commands that dispatch via `--print`."
  - `insights` is in both → works.
  - `cost` is **not** in `slash_commands` but works via `--print "/cost"` anyway. The list under-reports what's actually callable.
  - `help`, `export`, `status`, `login`, `logout` are absent from the list and also error as interactive-only — consistent.
- Skill commands (`/develop`, `/grill-me`, etc.) appear in the list and dispatch normally — confirms our v2 §Slash-command coverage assumption.

## Implication for the v2 architecture choice

The motivating CLI-only command (`/insights`) **does dispatch headlessly**. So both Option B (full CLI wrap) and Option C (SDK + small CLI shell-out allowlist) are viable; Option A alone leaves `/insights` missing.

The commands that *don't* dispatch headlessly (`/help`, `/export`, `/status`) are about terminal display state, not functionality:

- `/help` — claude-markdown ships its own help overlay. Not needed.
- `/export` — claude-markdown's transcript is already Markdown; the export concept doesn't translate.
- `/status` — claude-markdown has its own status bar.

→ Nothing in the headless-blocked list is actually a regression for our app.

→ Option B (full CLI wrap) buys us **no additional commands beyond Option C**, while costing us the typed event stream, in-process permission callbacks, and the existing Phase-7 auth work.

**Decision: Option C (hybrid).** Keep the SDK as the agent driver. Add a small CLI shell-out allowlist for headless-dispatchable CLI-only commands. Initial entry: `/insights`. Grow as the user finds gaps.
