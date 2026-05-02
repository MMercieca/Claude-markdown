# Claude Markdown — Design

A desktop app that wraps the Claude Code agent loop with a Markdown-rendered prompt and response surface. Resolved through a grilling session against `claude-markdown.md`.

## Problem statement

Claude Code is the user's primary interface for working with Claude. Three gaps motivate this app:

1. **Prompt-side**: typed prompts are raw text in the terminal; the user wants them rendered as Markdown as they type.
2. **Response-side**: terminal Markdown rendering is limited (no real fonts, no proper headings, no images, no tables). Browser-quality rendering wanted.
3. **Visibility**: the user wants a side-by-side raw view of what the agent is doing, so they can interrupt and redirect.
4. **Ergonomics**: `Option+Enter` for newline is cumbersome; `Enter` should be newline, a separate action should send.

"Do work" is in scope — file edits, shell, MCP, all of Claude Code's capabilities.

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

## Conversation model

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

- Session persistence / history sidebar / search.
- In-app theme picker.
- Settings UI for app-level config (edit JSON files).
- Embedded MCP auth webview.
- Mid-session `cwd` change.
- A full reimplementation of CLI built-ins outside the small allowlist above.
- Plugin system beyond what the SDK already supports.
- Windows / Linux builds (Mac only per spec; Electron makes cross-platform feasible later).
