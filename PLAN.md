# Claude Markdown — Development Plan

Checkpointed plan derived from `design.md`. Each numbered item is one git commit: small, meaningful, testable, building on the previous. Phases group commits into natural session boundaries.

After every commit the app should run and the new behavior should be exercisable by hand.

---

## Phase 1 — Project shell

- [x] **1. Scaffold Electron + TypeScript + Vite (electron-vite).** Main, preload, renderer entry points; `pnpm dev` opens a blank window. Strict TS, ESLint.
- [x] **2. Lock down renderer security.** `contextIsolation: true`, `nodeIntegration: false`, sandboxed preload exposing a typed `window.api` stub via `contextBridge`. Verify devtools shows no `require`.
- [x] **3. Three-pane layout shell.** Empty `Response` (top-left), `Prompt` (bottom-left), `Status` (right). Draggable dividers. CSS only — no logic.
- [x] **4. macOS theme follow.** Subscribe to `nativeTheme`; CSS variables flip on system light/dark. No picker.
- [x] **5. Layout persistence.** Save/restore divider positions to `~/.claude-markdown/layout.json`. Debounced writes.

## Phase 2 — Window-keyed session plumbing

- [x] **6. Per-window `SessionState` map in main.** `Map<windowId, SessionState>` keyed by `event.sender.id`. Every IPC handler reads/writes through it. Even with one window today, this is the design's load-bearing decision — bake it in.
- [x] **7. Typed IPC contract.** Define `RendererToMain` / `MainToRenderer` channel types in a shared module; preload exposes only those. Adds a hello-world `ping` round-trip to prove it works.

## Phase 3 — First SDK exchange

- [x] **8. Add `@anthropic-ai/claude-agent-sdk`; one-shot non-streaming query.** Hardcoded prompt, log result to console. Pure smoke test of SDK + auth in main.
- [x] **9. Streaming-input mode wired to UI.** `query()` with async-generator prompt; renderer sends a string, main pushes deltas back over IPC; response pane appends raw text. Single turn only, no markdown yet.
- [x] **10. Persistent multi-turn.** Generator stays open; second prompt continues the same session. Verify via "remember the number 7" → "what number?" round-trip.

## Phase 4 — Prompt editor

- [x] **11. CodeMirror 6 + `@codemirror/lang-markdown` in the prompt pane.** Plain editor, no decorations yet.
- [x] **12. Inline source-with-decorations.** Bold/italic/code render styled with delimiters dimmed; headings sized; fenced blocks monospace + highlighted.
- [x] **13. Send keybindings.** `Cmd+Enter` sends + clears; `Enter` newline; `Esc` calls `query.interrupt()` (only enabled while agent active). Truncated turn marked `[interrupted]`.

## Phase 5 — Markdown transcript

- [x] **14. `react-markdown` + `remark-gfm` + `rehype-highlight` in response pane.** Render completed turns as Markdown; pick a highlight theme and apply it to both the response pane (via rehype-highlight CSS) and the prompt editor (via a matching CodeMirror `HighlightStyle` color layer on top of step 12's typographic decorations).
- [x] **15. Streaming Markdown rendering.** Re-render on every delta. Inline styles snap when delimiters close.
- [x] **15a. Chat-bubble layout for user vs assistant turns.** User turns render as right-aligned Markdown bubbles (same renderer as assistant turns); assistant turns stay full-width Markdown. Bubbles persist in the transcript on Send.
- [x] **16. Fenced-code mid-stream special case.** Detect open ` ``` ` in buffer; render unclosed fence as code immediately.
- [x] **17. Code block copy button.** Top-right of every rendered block; one click → clipboard.

## Phase 6 — Status bar

- [x] **18. Status bar config mode.** Show `cwd | model | effort` with `[change]` affordances. `cwd` → native folder picker; `model` / `effort` → dropdowns. Defaults from `$PWD`/`$HOME` and `~/.claude/settings.json`.
- [x] **18a. Claude-style activity spinner in response pane.** While a query is active, show an animated spinner (matching Claude's dot/ellipsis pulse style) at the bottom of the response pane. Spinner disappears on `session:done`. Covers the gap between send and first token.
- [x] **19. Transition to monitoring mode on first send.** Pickers freeze read-only. Add `Ctx N% • 5h N% • 7d N%` from `SDKResultMessage`; threshold colors (green/amber/red).
- [x] **20. Cost estimate field.** Hardcoded per-model price table → `~$X.XX`. Hidden under Pro/Max subscription auth (detect via SDK auth mode).
  - ⚠️ Bug: cost chip is absent even on API-key sessions (`accountInfo()` may be returning a `subscriptionType` unexpectedly, or the call is failing silently). Needs investigation.

## Phase 7 — Right-side status pane

- [ ] **21. Sticky header: idle vs active.** Active: current activity string + `[Interrupt]`. Idle: last-turn tokens, model, latency.
- [ ] **22. Structured event log.** Per-tool card: name, expandable input args, expandable output. `--- Turn N ---` separators.
- [ ] **23. Tool chips in response pane (no inline output).** `⚙ Read foo.ts ✓` etc.; click → scroll/expand the matching right-pane card.
- [ ] **24. `Structured | Raw JSON` toggle.** Raw view pretty-prints every SDK event in fenced JSON blocks.

## Phase 8 — Permissions

- [ ] **25. `canUseTool` with auto-allowlist.** `Read/Glob/Grep/WebFetch/WebSearch` pass through silently; everything else denied for now (so the modal is the next commit, not a regression).
- [ ] **26. Permission modal as right-pane card.** `[Allow] [Deny]` + `y`/`n` keystrokes; auto-focus when shown; agent paused until resolved. Inherit `~/.claude/settings.json` rules — only prompt for items not pre-allowed.
- [ ] **27. Multi-option flows.** `1`/`2`/`3` for "allow once / allow session / deny" when SDK offers options.

## Phase 9 — Slash commands

- [ ] **28. App-intercepted allowlist: `/clear`, `/help`, `/cost`. `/insights`** `/clear` rebuilds session in same window (preserves `cwd`, defaults `model`/`effort`). `/help` overlay with keybindings. `/cost` scrolls right pane to usage. Everything else passes through to SDK unchanged.
- [ ] **29. `/model [name]` and `/model`.** Mid-session via `setModel()`; bare form lists models in right pane.
- [ ] **30. `/effort [level]` with lifecycle guard.** Only valid before first prompt; otherwise error message pointing to `/clear`. Verify `/effort high` → `/clear` → next `query()` carries `effort: 'high'` (one of the design's known-unknowns).

## Phase 10 - Building

- [ ] **31. Application build.** Ensure the application can be built on MacOS.
- [ ] **32. Shell shortcut.** Provide a small shell script that will launch the Electron application and set the `%CWD` variable to the directory the application was launched from.

## Phase 12 — Attachments

- [ ] **33. File drag-and-drop → Markdown link insert.** `[foo.ts](/abs/path)`.
- [ ] **34. Image paste → chip → image content block.** Placeholder chip in editor; on Send becomes an Anthropic `image` block; rendered into the transcript.
- [ ] **35. Reject oversized / over-count.** >5MB or >100 images → explicit error before Send; prompt not cleared.

## Phase 13 — Errors + compaction

- [ ] **36. Tool errors render as red chip + red right-pane card.** Permission denials show `denied` status (not error styling).
- [ ] **37. Blocking error banner with `[Retry] [Dismiss]`.** Network/4xx/5xx/rate-limit/SDK crash. Quota errors get a live countdown.
- [ ] **38. Config error banner with `[Reload settings]`.** Hook failures, malformed settings.
- [ ] **39. Compaction marker.** On `SDKCompactBoundaryMessage`: thin divider in transcript with `[show summary]` toggle; mirrored card in right pane; usage display reflects post-compact state.

## Phase 14 — Multi-window + MCP polish

- [ ] **40. `Cmd+N` new window in config mode; `Cmd+W` interrupts + cleans up.** macOS Window menu lists windows; app survives last-window-close.
- [ ] **41. MCP auth via `shell.openExternal`.** When an MCP auth tool emits a "visit this URL" message, open in user's real browser.
- [ ] **42. Optional `statusLine` shell-out.** Opt-in via app config; appended to right of status bar.

## Phase 15 — Smoke tests for the known unknowns (optional)

- [ ] **43. Verify user-level `CLAUDE.md` loads** with `settingSources: ['user','project','local']`.
- [ ] **44. Force a mid-stream compaction** to confirm divider rendering doesn't corrupt a partial assistant message; fix if needed.
---

## Ordering notes

- **Steps 6–7 come before any UI features.** The design explicitly says window-ID keying is the one architectural decision to make day one — doing it before there are handlers to retrofit costs almost nothing.
- **Step 25 intentionally denies non-allowlisted tools** so step 26 isn't fixing a regression — it's adding a missing capability.
- **Phases 5 and 7 stay decoupled.** Tool chips (step 23) need both the response transcript and the right-pane cards, so it sits in phase 7.
- **Compaction (step 37) lives with errors**, not with response rendering, because the SDK message arrives through the same event stream as errors and is easier to handle once that pipeline is mature.
