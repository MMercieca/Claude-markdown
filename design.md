# Claude Markdown — Design

A desktop app that wraps the Claude Code agent loop with a Markdown-rendered prompt and response surface. Resolved through a grilling session against `claude-markdown.md`.

## Problem statement

Claude Code is the user's primary interface for working with Claude. Three gaps motivate this app:

1. **Prompt-side**: typed prompts are raw text in the terminal; the user wants them rendered as Markdown as they type.
2. **Response-side**: terminal Markdown rendering is limited (no real fonts, no proper headings, no images, no tables). Browser-quality rendering wanted.
3. **Visibility**: the user wants a side-by-side raw view of what the agent is doing, so they can interrupt and redirect.
4. **Ergonomics**: `Option+Enter` for newline is cumbersome; `Enter` should be newline, a separate action should send.

"Do work" is in scope — file edits, shell, MCP, all of Claude Code's capabilities.

---

## Refactor v2 — May 2026

After running v0 end-to-end, three gaps are large enough to drive a significant refactor. This section captures the new goals, the architectural decision they force, and how each goal lands in the design. **Sections below this point that v2 supersedes are flagged inline; treat the v2 section as authoritative where they conflict.**

### v2 goals

1. **Real session persistence.** Sessions should survive app restarts. The user can quit `claude-markdown`, reopen it, and resume a prior conversation — including resuming the most recent session in a given `cwd` (analogous to `claude --continue`) and picking a specific older session from a list (analogous to `claude --resume <id>`).
2. **Full Claude Code slash-command coverage.** All slash commands the user types in `claude` itself should work here, including ones the v0 design doesn't intercept. `/insights` is the motivating example, but the goal is parity, not a curated list.
3. **Rich live status output.** The right-side status pane should feel like the activity feed in `claude` itself: a continuously-updating stream of one-liners as the agent reads files, runs Bash, spawns Task agents, etc. The structured-card view from v0 is correct as a *detail* surface, but the headline experience the user wants is the live ticker.

The v2 phrasing also adds a meta-goal:

> *If we get this right, `claude-markdown` becomes my replacement for the `claude` CLI.*

That framing matters: it raises the bar from "good Claude UI" to "lossless superset of `claude`'s headless behavior, plus better rendering." Anything `claude` does at the terminal that we can't replicate becomes a regression, not a missing feature.

### Architectural decision: SDK vs. CLI wrapping

The user pointed at [`dodontommy/claws`](https://github.com/dodontommy/claws) (`brew install dodontommy/tap/claws`) as the prompt for this refactor. **claws is not a substrate we can build on**, but it's worth understanding why before sequencing the rest of this section — the answer rules out one option and validates two others.

#### What claws actually is

claws is a Rust **TUI** (terminal UI) for managing multiple `claude` sessions in parallel:

```
┌─────────────┐         ┌────────────┐
│  TUI client │ ──RPC──▶│  daemon    │──┬─ PTY ─▶ claude --session-id ...
└─────────────┘  unix   │            │  ├─ PTY ─▶ claude --resume ...
      ▲         socket  │  registry  │  └─ PTY ─▶ claude --resume ...
      │                 │  + sqlite  │
      │                 │  + auth    │
      └─── attached ────┘
```

- Long-lived daemon owns each `claude` subprocess inside its own **PTY**, parses the vt100 stream into an internal screen, persists per-session metadata (cwd, flags, model, name) to SQLite.
- TUI client connects over a mode-0700 Unix socket with per-startup auth token. A phone PWA does the same over Tailscale.
- Continuity within a single conversation comes from Claude's own `--session-id` / `--resume <id>` flags. claws orchestrates *between* conversations.
- Hooks emitted by Claude flow back through `claws hook-emit` into the daemon, which is how it knows a session is in `awaiting_permission`.
- Built with `ratatui`, `portable-pty`, `vt100`, `rusqlite`, `interprocess`, `axoupdater`.

#### Why it's not a substrate for claude-markdown

The two products solve *different* problems:

| Concern | claws | claude-markdown |
| :--- | :--- | :--- |
| Primary problem | Orchestrate many sessions side-by-side | Render one session beautifully (Markdown) |
| Output substrate | vt100/ANSI from interactive `claude` | Structured events (SDK or stream-JSON) |
| Renderer | Terminal screen via `vt100` crate | Browser DOM via `react-markdown` |
| Multi-session | Core feature | Cmd+N opens another window |

To build claude-markdown *on top of* claws, we'd have to take vt100-emulated screen bytes from claws's daemon and try to reverse them back to structured Markdown — strictly worse than going directly to the SDK or `claude --output-format stream-json`. claws's whole value is the terminal rendering it commits to; reversing that is fighting the design.

#### What claws does validate for us

- **PTY-wrapping `claude` works in production.** If we ever needed it, claws is the existence proof.
- **`claude --session-id ... --resume <id>` is a real, stable API**, used to "re-spawn every session you didn't explicitly close" across daemon restarts. Confirms goal #1 is achievable via either the SDK or the CLI.
- **Claude has a `hook-emit` mechanism** that pushes events out-of-band — claws uses it for `awaiting_permission`. If we go Option B/C below, we may be able to use the same mechanism to drive the right-pane live stream without parsing stdout.
- **Coexistence is fine.** claws orchestrates terminal `claude` sessions; claude-markdown is a different surface for one session. A user could run both. Out of scope for this refactor.

#### The actual choice

With claws ruled out as a substrate, the real choice is still between three architectures:

#### Option A — Stay on `@anthropic-ai/claude-agent-sdk`, add session management

Keep the existing SDK integration. Add resume/continue/fork plumbing using the SDK's built-in primitives.

The SDK already does more than v0 currently uses:

- **Disk persistence is automatic.** Every session is written to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` unless `persistSession: false` is passed. We don't need a custom store.
- **Resumption is a single option.** `resume: sessionId` returns to a specific session; `continue: true` returns to the most recent session in the current `cwd`; `forkSession: true` branches.
- **Enumeration helpers exist.** `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `renameSession()`, `tagSession()` cover everything a session-picker UI needs.
- **Session ID lifecycle.** Captured from the init `SystemMessage` (`message.session_id` direct field in TS) on the first turn; also present on every `SDKResultMessage`. Persist it per window in `~/.claude-markdown/state.json`.

Pros: smallest delta from current code; typed events stay typed; permission callbacks (`canUseTool`) keep working as-is; Phase-7 auth work doesn't need to be redone.

Cons: **CLI-exclusive slash commands stay missing.** The SDK explicitly only dispatches commands "that work without an interactive terminal." The `system/init` message lists what is available in your session via the `slash_commands` array. `/insights`, `/export`, `/login`, `/logout`, `/status`, `/upgrade`, `/release-notes`, `/vim`, and most of the CLI's UX-layer commands are outside that set. Re-implementing them ourselves is rebuilding CLI features in a wrapper, indefinitely.

#### Option B — Wrap the `claude` CLI binary as a child process

Spawn `claude` headless and talk to it over stream-JSON:

```
claude \
  --print \
  --input-format stream-json \
  --output-format stream-json \
  --session-id <our-id>          # or --resume <id> / --continue
```

Pipe NDJSON user messages into stdin, parse NDJSON events from stdout. Use CLI flags for the headless equivalents of permission prompts (`--permission-mode`, `--allowedTools`, etc.).

Pros: native parity with `claude` is automatic; new CLI features land here for free; settings/MCP/skills behave exactly as the user already configures them for `claude`; one less moving part if the user is already on the CLI elsewhere.

Cons: **CLI slash-command parity is not actually free either.** The same constraint applies — only commands that work non-interactively are dispatchable in stream-JSON mode. Need to spike `/insights` specifically before committing. Also: subprocess plumbing is brittler than an in-process SDK call; permission callbacks become async hook flags instead of typed Promise returns; we have to manage the binary's location and version; renderer-visible types come from parsed JSON, not TS interfaces; auth state is whatever `claude` has on disk, which may differ from what v0's auth picker selected.

#### Option C — Hybrid: SDK for the loop, CLI for what only the CLI does

Keep the SDK as the primary agent driver (and keep all of v0's typed events, permission callbacks, multi-window state, auth picker). For the small set of CLI-only slash commands the user actually wants, intercept them in the slash-command dispatcher and shell out to `claude <command>` as a one-shot subprocess, capturing stdout and rendering it into the response pane.

Pros: minimum disruption; no regression on Phase 7 (auth) or Phase 9 (permissions); covers `/insights` cleanly; falls back to the SDK for everything else.

Cons: two code paths for slash commands; some CLI commands (`/login`, `/logout`) mutate state the SDK then has to re-detect; the user's auth picker selection in the app may not match what `claude` uses on disk for the shell-out, which could be confusing.

#### Recommendation framing

This is your call, not mine. My read:

- **If "becomes my replacement for the `claude` CLI" is load-bearing**, Option B (or B-leaning hybrid) is the only honest answer. Anything else means re-implementing CLI features chasing a moving target.
- **If the goal is closer to "great Markdown-rendered SDK app that also does `/insights`"**, Option C gets there with the least churn and zero regression on the seven phases of work that already shipped.
- **Option A alone won't satisfy goal #2** (CLI-only commands stay missing). Document it as the cheapest option but only if `/insights`-class commands turn out to not actually matter once we look harder.

A spike worth doing before committing: run `claude --print --input-format stream-json --output-format stream-json` and try `/insights`. If it works headlessly, Option B is much more attractive. If it errors with "interactive only," the gap is real and Option C is the pragmatic middle.

### Session persistence design

Independent of the SDK-vs-CLI choice — both paths give us session IDs and resume support. What changes is how we surface them in the app.

**State to persist** (in `~/.claude-markdown/state.json`, alongside the existing `layout.json`):

```ts
type AppState = {
  windows: Array<{
    cwd: string;
    sessionId: string | null;     // null = no turns yet
    lastActiveAt: string;          // ISO timestamp
    title: string | null;          // user-set or auto-generated from first prompt
  }>;
  layoutVersion: number;           // for forward-compat
};
```

**Launch flow:**

1. On app start, read `state.json`.
2. If there are persisted windows, restore them in their previous `cwd` with their previous `sessionId`. The status bar shows `cwd | model | effort | auth | resumed: <short-id>` for resumed sessions.
3. The first `query()` for a resumed window passes `resume: sessionId`. The transcript hydrates by calling `getSessionMessages(sessionId)` *before* opening the live query — this populates the response pane with prior turns so the user lands on a populated view, not an empty one.
4. If there are no persisted windows, open one fresh in config mode (current v0 behavior).

**Session picker UI** (replaces v0's "ephemeral across restarts"):

- New `Cmd+O` ("Open session") opens an overlay listing sessions for the current `cwd`, ordered by `lastActiveAt` desc. Shows: short ID, title, first user prompt preview, turn count, last-active relative time.
- Selecting a session resumes it in the current window (interrupts any active query first, with confirm).
- Right-pane action: "Fork from here" runs the next prompt with `forkSession: true`, captures the new ID from the next init message, and updates `state.json`.

**`/clear` behavior change:** still starts a fresh session in the same window, but the *old* session stays on disk and is reachable through `Cmd+O`. The current "destroys session" wording in the v0 Conversation model is wrong for v2.

**Token-cost note (responding to the user's concern):** there is no way to "keep an agent session going without spending a lot of tokens." Both SDK resume and CLI `--resume` work the same way: the on-disk JSONL transcript is replayed into the model's context for the next turn. A 100k-token session costs 100k input tokens to resume *the first turn*, just like continuing a long live conversation does. Anthropic's prompt-cache cuts the *repeated* portion's cost dramatically (cached input is ~10% the price of fresh input), and the SDK uses caching by default. There is no hidden lever for "persistent context with no token cost" — that would require a server-side stateful session, which Claude doesn't offer in this form. The honest framing is "we get persistent context for one cache-friendly cost per resume."

### Status pane: live activity stream

The v0 right-side pane is structured cards. Keep that as the *detail* view, but add a primary live-stream view above it:

```
+------------------------------------+
|  Sticky header (current activity   |
|   + [Interrupt])                   |
+------------------------------------+
|  Live stream                        |   ← new in v2
|  ● Read foo.ts                     |
|    ⎿ 47 lines                      |
|  ● Bash: pnpm test                 |
|    ⎿ 18 passed                     |
|  ● Edit bar.ts                     |
|  ● Task: explore-agent             |
|    ⎿ ran 6 tools, 12s              |
|  ...                                |
+------------------------------------+
|  Toggle: Stream | Cards | Raw JSON |
+------------------------------------+
|  (Cards or JSON view — collapsible)|
+------------------------------------+
```

- **Stream view** is the default. Each SDK event becomes one or two lines (action + result summary). Visual style mirrors the `claude` CLI's `●` bullets and `⎿` follow-ons. Auto-scrolls unless the user has scrolled up.
- **Cards view** is the existing Phase 8 structured cards (renamed from the default).
- **Raw JSON view** is the existing Phase 8 toggle.
- Three modes, one toggle. State persists across windows (one user preference).
- Tool chips in the response pane (Phase 8 step 28) still work — clicking a chip scrolls the right pane to the matching event in whichever view is active.

The stream view is the *only* part of the right-pane plan that's genuinely new code. Cards and JSON already exist; this adds a third renderer that consumes the same event stream.

### Slash-command coverage in v2

The v0 design's "small allowlist" approach (lines 214–224) is now wrong for v2's goal #2. The v2 model:

- **Pass everything to the backend** (SDK or CLI) by default. Whatever the backend can handle, it handles.
- **Intercept only what the app must own** because the backend can't: `/clear` (because it changes which session ID we track and update in `state.json`), `/effort` (because it's a `query()` construction option, not a runtime command), `/help` (overlay listing app keybindings + a note that all backend commands work).
- **Expose `slash_commands` in the UI.** Read the `system/init` message's `slash_commands` array on session start; render it in the `/help` overlay so the user can see what's available in the current session (varies with skills, plugins, MCP).
- **Under Option C**, the dispatcher checks the command against a small "CLI-only" allowlist before passing to the SDK. If matched, shell out to `claude <command>` and stream stdout into the response pane. Initial allowlist: `/insights`. Grow it as the user finds gaps.

### What this refactor breaks

- **PLAN.md item 49** (force a mid-stream compaction) is still valid but lower priority — compaction divider rendering is unaffected by the v2 changes.
- **The Conversation model section below** ("Persistent multi-turn within a session" + "Ephemeral across restarts") becomes wrong on the second point. v2 sessions are persistent across restarts.
- **The Slash commands section below** describes a small intercept allowlist; v2 inverts the default (pass-through) and adds an optional CLI shell-out path under Option C.
- **The Right-side status pane section below** describes a structured event log as primary; v2 makes the live stream primary and demotes cards to a toggle.
- **The Out-of-scope list** ("Session persistence / history sidebar / search") loses its first item. Search is still out of scope for v2; persistence and history sidebar are now in.

### Decisions (resolved by step 50 spike, 2026-05-04)

The five questions previously open here are answered below. Spike methodology and per-command results: `notes/v2-spike.md`.

1. **Architecture: Option C (hybrid).** SDK stays as the agent driver. A small CLI shell-out allowlist handles headless-dispatchable CLI-only commands. *Why:* the spike confirmed `/insights` and `/cost` dispatch fine via `claude --print`, while the commands that *don't* dispatch headlessly (`/help`, `/export`, `/status`) are terminal-display features that don't translate to a Markdown GUI. Option B would buy us no additional commands beyond C while costing the typed event stream, in-process permission callbacks, and the existing Phase-7 auth work. Option A alone leaves `/insights` missing.

2. **Resume-on-launch: auto-resume all windows that were open at quit.** *Why:* matches the user's "replacement for the `claude` CLI" framing — `claude --continue` is the established UX for "pick up where I left off." If a session is in a weird state, `Cmd+O` swaps to a different one in O(1) and is reachable from the resumed view; the safety case doesn't justify making the common case worse.

3. **Multi-window restore: restore every window that was open at quit.** *Why:* each window owns its session; collapsing to one window on relaunch silently abandons the others and forces the user to manually re-open them via `Cmd+O`. Honoring the layout the user had at quit is least surprising. Cost is bounded — `state.json` already constrains how many windows we'll spawn.

4. **Hydration cost: render all messages on resume; measure before optimizing.** *Why:* the box already specifies this, and the spike didn't surface any reason to pre-empt it. If long-session hydration turns out slow, add a "load earlier turns" affordance behind a measured threshold (suggested initial cap if needed: last 50 turns).

5. **CLI binary discovery: `PATH` lookup with explicit error if missing.** *Why:* the box already specifies this. The spike confirmed `/Users/mercieca/.local/bin/claude` is on PATH for terminal-launched processes; Finder-launched Electron processes inherit a sparser PATH. Phase 11's shell shortcut already addresses this; the same wrapper fix applies. If users hit this in practice, add a one-line app-config override.

---

> **The sections below are the original v0 design. Where v2 (above) supersedes a section, it is flagged inline.**

## Architecture

### Tech stack

- **Electron + TypeScript** (per spec).
- **`@anthropic-ai/claude-agent-sdk`** (TypeScript) — same agent loop as Claude Code, with full settings parity. Verified at v0.2.x.
- **CodeMirror 6** with `@codemirror/lang-markdown` for the prompt editor.
- **`react-markdown`** with `remark-gfm` and `rehype-highlight` for the response transcript.
- Same syntax-highlighting theme across both for visual consistency.

### Process model

- SDK runs in **Electron's main process**.
- Renderer is pure UI; no `nodeIntegration: true`.
- Communication via typed IPC over `contextBridge`.
- **Every IPC handler must carry a window ID from day one** — `event.sender.id` keys a `Map<windowId, SessionState>` in the main process. This is the single architectural decision that must be made up front to keep multi-window cheap.

### SDK options

Pass these explicitly to `query()` for full Claude Code parity:

```ts
query({
  prompt: asyncGenerator,                    // streaming-input mode
  options: {
    settingSources: ['user', 'project', 'local'],
    skills: 'all',
    cwd: sessionCwd,
    model: sessionModel,                     // from status-bar config
    effort: sessionEffort,                   // from status-bar config
    canUseTool: permissionCallback,
    abortController,                          // exposed to UI for Esc/Interrupt
  }
})
```

`settingSources` defaults to all-loaded for `query()`, but explicit is future-proof.

## Authentication

The agent loop runs against one of three providers, selected per window before the first prompt:

- **API key** — `ANTHROPIC_API_KEY` env var. Per-token billing surfaces as a `~$X.XX` chip in the status bar (computed from `SDKResultMessage.total_cost_usd`).
- **claude.ai OAuth (Pro/Max)** — interactive browser login via `q.claudeAuthenticate(true)` + `shell.openExternal`. The SDK persists tokens to disk; subsequent sessions reuse them silently. No cost chip (subscription billing is opaque to the host). Rate-limit chips (`5h`, `7d`) only populate in this mode — they're driven by `SDKRateLimitEvent` messages, which the SDK only emits for subscription accounts.
- **Amazon Bedrock** — opt-in via `CLAUDE_CODE_USE_BEDROCK=1` plus the standard AWS credential chain (env vars, `~/.aws/credentials`, IAM role). The SDK consumes these env vars automatically; the Electron main process inherits them from the terminal that launched the app (Finder-launched instances won't have them). Model ID translation is handled internally by the SDK via `inferenceProfileBackingModels` — bare model IDs like `claude-opus-4-7` are likely accepted and remapped automatically, but this must be smoke-tested with a real Bedrock account. `q.supportedModels()` returns provider-appropriate identifiers and should be used to populate the model picker once step 24 (auth-mode picker) is implemented. No cost chip (org-level billing). No rate-limit chips (Bedrock surfaces quota as 429 errors rather than utilization events).

Auth provider is detected via `q.accountInfo()` (`apiProvider`, `subscriptionType`) and rendered as a fourth field in the config-mode status bar: `cwd | model | effort | auth`. The `auth` field doubles as the picker; the Bedrock option is grayed out unless its env vars are present, with a tooltip explaining what's missing. Mid-session changes require `/clear`.

Auth-mode selection is the load-bearing input for several conditional UI behaviors (cost chip visibility, rate-limit chip visibility, eligible model list), so it's surfaced once via `accountInfo()` rather than rederived per-feature.

## Conversation model

> **v2 supersedes the "Ephemeral across restarts" point.** See *Refactor v2 → Session persistence design* above. Sessions persist to disk via the SDK; closing a window leaves the JSONL on disk and `Cmd+O` can resume it. The other two points below are still accurate.

- **Persistent multi-turn within a session.** Single `query()` call with an async-generator prompt that yields each new user message. Agent stays alive between turns and remembers everything; SDK handles compaction.
- **Ephemeral across restarts.** No persistence layer, no session list, no archive. Closing a window destroys its session. Matches Claude Code's terminal default.
- **`/clear`** starts a fresh session in the same window (preserves `cwd`; `model` and `effort` defaults persist).

## Window & pane layout

Single window contains three panes:

```
+-----------------------------------+-----------------+
|  Status bar (cwd | model | effort | ctx% | $ | 5h | 7d)  |
+-----------------------------------+                 |
|                                   |                 |
|  Response pane                    |  Right-side     |
|  (transcript: text + tool chips)  |  status pane    |
|                                   |  (sticky header |
|                                   |   + scrolling   |
|                                   |   structured    |
|                                   |   event log)    |
+-----------------------------------+                 |
|                                   |                 |
|  Prompt pane                      |                 |
|  (CodeMirror, Markdown-rendered)  |                 |
|                                   |                 |
+-----------------------------------+-----------------+
```

- Default split: response 60% / prompt 40% (vertical, left side); left 65% / right 35% (horizontal).
- Draggable dividers. User-adjusted sizes persisted to `~/.claude-markdown/layout.json` — the only persistent state in an otherwise-ephemeral app.
- Theme: follow macOS system appearance (dark/light auto). No in-app theme picker for v0.

### Status bar (top of response pane)

Two modes for the same strip; transition is irreversible within a session.

**Configuration mode** (before first prompt sent):
- `cwd`, `model`, `effort` shown with `[change]` affordances.
- Click any to change. `cwd` opens native folder picker; `model` and `effort` open dropdowns.
- Defaults: `cwd = $PWD` if launched from terminal else `$HOME`; `model` and `effort` from `~/.claude/settings.json` if set, else SDK defaults.

**Monitoring mode** (after first prompt sent):
- `cwd`, `model`, `effort` still shown but read-only (pickers grayed/hidden).
- Adds usage fields: `Ctx N% • ~$X.XX • 5h N% • 7d N%`.
- Percentages colored: green <60%, amber 60–85%, red >85%.
- Updates after each `SDKResultMessage`. No background polling.
- `~$X.XX` only shown under API-key auth; hidden under Pro/Max subscription auth (don't show data we can't compute).
- Optional shell-out to user's `~/.claude/settings.json` `statusLine` command appended on the right; disabled by default, opt-in via app config.

## Prompt window

CodeMirror 6 with `@codemirror/lang-markdown`.

- **Inline source-with-decorations**: `**bold**` shown bold *with the asterisks visible but dimmed*; headings get larger font; fenced code blocks get monospace + syntax highlighting. Single pane, no separate preview.
- **`Enter` = newline.**
- **`Cmd+Enter` = Send.**
- **`Esc` = interrupt** (only enabled while agent is active; calls `query.interrupt()`).
- Cleared on Send.

### File attachments

- **Image paste** (`Cmd+V` of an image): placeholder chip in the editor (small thumbnail or `[image: 240×180]`). On Send, becomes an Anthropic `image` content block alongside text blocks. Rendered into the response transcript when sent.
- **File drag-and-drop**: inserts the absolute path as Markdown link text (`[foo.ts](/abs/path/to/foo.ts)`). Agent uses `Read` to access. No special content block needed.
- **Oversized images** (>5MB or >100 in one prompt): rejected with an explicit error before Send; prompt remains uncleared.

## Response pane

Scrolling transcript of the full session, rendered as Markdown.

### Turn layout

- **User turns**: right-aligned chat bubble, Markdown-rendered (so the bubble matches what was visible in the prompt editor at Send time). Same renderer as assistant turns; styling differs only via the bubble container.
- **Assistant turns**: full-width, Markdown-rendered, no bubble. The transcript reads top-to-bottom like a chat: bubble, response, bubble, response.
- Sent prompts are never cleared from the transcript on Send (the prompt pane is cleared, but the bubble persists in the response pane above).

### Streaming

- **Render partial Markdown immediately** as text streams in. Inline styles (`**`, `*`, `` ` ``) snap into place when delimiters close — fast enough not to matter.
- **One special case**: detect an opened-but-unclosed fenced code block in the streaming buffer and render it as a code block immediately, with everything from the opening ` ``` ` onward styled as code. Avoids the worst flicker case.

### Tool calls

- **Inline chips**, no inline output.
  - Format: `⚙ Read foo.ts`, `⚙ Edit bar.ts (12 lines)`, `⚙ Bash: npm test`.
  - Status icon at end: `✓` success, `✗` failure.
  - Click chip → expands the corresponding card in the right pane.
- **Tool results never appear in the response pane.** Result detail lives only in the right-pane card.
- Agent thinking blocks: rendered subtly (e.g., italicized prefix) or hidden behind a per-turn `[thinking]` toggle. Park as detail.

### Compaction marker

When the SDK emits an `SDKCompactBoundaryMessage`:

- Insert a thin horizontal divider in the response pane: `── compacted at turn N (earlier turns summarized for the model) ──`.
- Marker has `[show summary]` toggle that expands the SDK's `compact_summary` string.
- Right pane gets a mirrored divider card with the same toggle.
- Token usage display reflects post-compact reality (don't keep climbing past 100%).

### Code blocks

- **Copy button** in top-right of every rendered code block. One click, code on clipboard.
- Syntax highlighting via `rehype-highlight`, theme-matched to the prompt editor.

## Right-side status pane

> **v2 supersedes the default view.** See *Refactor v2 → Status pane: live activity stream* above. v2 makes a CLI-style live stream the primary view, with the structured cards described below demoted to a `Cards` toggle alongside `Stream` and `Raw JSON`.

Sticky header + scrolling structured event log.

### Sticky header

- While agent is **active**: current activity (`Reading foo.ts…`, `Awaiting permission for Bash…`) and `[Interrupt]` button.
- While agent is **idle**: last-turn token usage, model, latency.
- **Permission requests**: a card here with `[Allow] [Deny]` buttons (also responds to `y`/`n` keystrokes when focused, `1`/`2`/`3` for multi-option flows). The agent pauses until the user resolves.

### Event log

- **Structured cards**, accumulating across the session (visual `--- Turn N ---` separators).
- Each tool call: card with tool name, expandable input args, expandable output.
- Each assistant text block: smaller chip.
- **Toggle at top: `Structured | Raw JSON`**. Raw view pretty-prints every SDK event as ` ```json ... ``` ` blocks. Same data, different rendering.
- Tool errors render as red-tinted cards inline.

## Permissions

`canUseTool` callback handles all approvals.

### Auto-allowlist (no prompt)

- `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`.

### Always prompt (modal in right pane)

- `Edit`, `Write`, `NotebookEdit`, `Bash` — any write or shell tool.
- `Task`, `Skill` — transitive (subagent or skill can do anything).
- Anything else not explicitly allowlisted, including unknown MCP tools.

### Modal behavior

- Lives as a card in the right pane (not a separate dialog).
- Keyboard: `y` allow, `n` deny. `1`/`2`/`3` reserved for multi-option flows ("allow once / allow session / deny").
- Focus moves to the modal automatically when it appears.
- Window-local — denying in window A doesn't affect window B.
- Inherits user's `~/.claude/settings.json` permission rules; only prompts for items not pre-allowed there.

## Slash commands

> **v2 supersedes this section's intercept-allowlist model.** See *Refactor v2 → Slash-command coverage in v2* above. v2 inverts the default to pass-through, intercepts only `/clear`, `/effort`, `/help`, and (under Option C) shells out to `claude <command>` for a CLI-only allowlist starting with `/insights`. The table below documents the v0 behavior for reference.

The SDK natively processes slash commands when settings are loaded. Skill commands (`/grill-me`, `/diagnose`), user commands (`~/.claude/commands/*.md`), and plugin commands all flow through unchanged.

App intercepts a small allowlist of CLI built-ins:

| Command | Behavior |
|---|---|
| `/clear` | New ephemeral session in the same window (preserves `cwd`; default `model`, `effort` apply) |
| `/cost` | Focus right pane and scroll to current usage stats |
| `/help` | Overlay listing app keybindings + note that skill commands work normally |
| `/model [name]` | Mid-session via `setModel()`; bare `/model` lists available models in the right pane |
| `/effort [level]` | **Only valid before first prompt sent.** Sets canonical `effort: 'low'\|'medium'\|'high'\|'xhigh'\|'max'` for the new `query()` invocation. After first prompt: error "/effort is only supported at the beginning of a session. Use /clear to start a new session, then /effort <level>." |

Everything else passes through to the SDK unchanged.

## Interrupts

- `Esc` keystroke or right-pane `[Interrupt]` button → `query.interrupt()`.
- Conversation context preserved; the user can immediately type a redirect message.
- Truncated turn marked `[interrupted]` in the response pane.
- Prompt window refocuses automatically.

## Errors

Severity-routed.

- **Tool errors** (Bash exit non-zero, Read missing file, etc.): red chip in response pane + red card in right pane. Claude usually adapts on its own.
- **Permission denials**: not surfaced as errors. Right-pane card shows `denied` status; agent receives `tool_result` saying so.
- **Blocking errors** (network, API 4xx/5xx, rate limit, quota exhausted, SDK crash): prominent banner across top of response pane with `[Retry] [Dismiss]` buttons.
  - Quota errors get a live countdown: `Quota exhausted, resets in 2h 14m`.
- **Config errors** (malformed settings, hook failures between turns): blocking banner; offer `[Reload settings]`.

## Multi-window (multi-session)

- Each window owns one SDK `Query` (independent session).
- `Cmd+N` opens a new window in configuration mode.
- `Cmd+W` closes window and `query.interrupt()` + clean up that session.
- macOS Window menu lists open windows; `Cmd+`` ` cycles.
- App does not quit when last window closes (standard macOS).
- Per-window state in main process: `Map<windowId, { query, transcript, settings, layout }>`.
- Layout file shared globally (one default for new windows).
- MCP auth tokens cache on disk per the underlying MCP server, so multiple windows sharing an MCP server reuse the same auth.

## Cost estimation

- Per-window running estimate: `~$X.XX this session`.
- Computed from accumulated input/output/cache tokens × hardcoded per-model price table.
- Updates after each `SDKResultMessage`.
- `~` prefix signals it's an estimate (prices may be stale).
- **Hidden under Pro/Max subscription auth** — only meaningful for API-key auth.

## MCP servers

- Auto-loaded via `settingSources` (no special handling).
- Tools appear like any others in the permission flow (always prompt — they're not in the read-only allowlist).
- **Auth flows**: when an MCP server's auth tool emits a "visit this URL" message, open it via Electron's `shell.openExternal()`. No embedded webview. User completes auth in their real browser; MCP server completes the OAuth callback on its own.

## Keybindings

| Keystroke | Action |
|---|---|
| `Enter` | Newline in prompt |
| `Cmd+Enter` | Send prompt |
| `Esc` | Interrupt active agent |
| `Cmd+N` | New window (new session) |
| `Cmd+W` | Close window (kill session) |
| `Cmd+`` ` | Cycle windows (macOS standard) |
| `y` / `n` | Allow / deny permission modal (when focused) |
| `1` / `2` / `3` | Multi-option permission resolution |

## Defaults

- `cwd`: `$PWD` if launched from terminal, else `$HOME`.
- `model`, `effort`: from `~/.claude/settings.json` if set, else SDK defaults (Opus 4.7, `effort: 'high'`).
- Pane split: 60/40 vertical (left), 65/35 horizontal.
- Theme: follow macOS system appearance.
- Statusline shell-out: disabled.
- Cost estimate: shown if API-key auth, hidden if subscription auth.

## Known unknowns

Things to verify or revisit during implementation, not blockers:

1. **CLAUDE.md loading via `settingSources`**: the SDK typings note that `settingSources` "must include `'project'` to load CLAUDE.md files," but `query()` defaults to all sources. Smoke-test that `~/.claude/CLAUDE.md` (user-level) is actually loaded — the comment may refer to project-level CLAUDE.md only.
2. **Mid-stream compaction**: the design assumes compaction fires only between turns. If the SDK can compact mid-response, the divider rendering needs to handle a partial assistant message gracefully.
3. **Image paste edge cases**: Finder-paste of non-image files behaves OS-specifically. v0 accepts only true clipboard images; other paste shapes do nothing (use drag-and-drop instead).
4. **Setting `effort` change after `/clear`**: the canonical `effort` option is set at `query()` construction. `/effort high` followed by `/clear` should pass `effort: 'high'` to the new query — verify the value persists across the new-session flow.

## Out of scope (v0)

> **v2 brings session persistence and a history sidebar in scope.** Search across sessions remains out of scope.

- Session persistence / history sidebar / search.
- In-app theme picker.
- Settings UI for app-level config (edit JSON files).
- Embedded MCP auth webview.
- Mid-session `cwd` change.
- A full reimplementation of CLI built-ins outside the small allowlist above.
- Plugin system beyond what the SDK already supports.
- Windows / Linux builds (Mac only per spec; Electron makes cross-platform feasible later).
