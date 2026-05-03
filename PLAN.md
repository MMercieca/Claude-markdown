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

## Phase 7 — Authentication modes

Adds support for **claude.ai OAuth** (Pro/Max subscription, used at home) and **Amazon Bedrock** (used at work) alongside the existing API-key path. The SDK already provides the primitives — this phase wires them into the UI and verifies each mode end-to-end.

- [x] **21. Surface current auth mode in the status bar.** After session bootstrap, call `q.accountInfo()` and emit an `auth` chip alongside the existing usage chips: `api-key`, `claude-ai · max`, `bedrock`, etc. Drives all conditional UI (e.g. cost-chip visibility from step 20). Fixes the bug noted under step 20 — cost chip currently absent because subscription detection isn't being read correctly.
  - ⚠️ The SDK's `rate_limit_event` omits `utilization` when `status` is `allowed`; we show `✓`/`!`/`✗` as a fallback. Investigate whether a separate API or a different SDK event can supply the actual percentage (e.g. only provided at `allowed_warning`/`rejected` thresholds).
- [x] **22. Bedrock provider via environment.** Honor `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, and the standard AWS credential chain (env vars / `~/.aws/credentials` / IAM role). No new UI beyond the auth chip from step 21. Smoke-test against a real Bedrock account; document any model-ID remap needed for Opus/Sonnet (Bedrock uses ARNs, not the bare model IDs from `~/.claude/settings.json`).
  - ✅ No code changes required — the SDK consumes `CLAUDE_CODE_USE_BEDROCK=1` and the AWS credential chain automatically; the Electron main process inherits env vars from the terminal.
  - ✅ Auth chip already shows "bedrock" via `accountInfo().apiProvider` (step 21).
  - ⚠️ **Smoke-test pending (user):** verify with a real Bedrock account that bare model IDs like `claude-opus-4-7` are accepted. The SDK manages an `inferenceProfileBackingModels` map internally suggesting it handles the ARN translation, but this is unconfirmed.
  - ⚠️ Step 24 (auth-mode picker) should use `q.supportedModels()` to populate the model list for Bedrock rather than the hardcoded firstParty list.
- [x] **23. claude.ai OAuth login flow.** "Sign in with Claude" affordance in config mode. On click: call `q.claudeAuthenticate(true)`, open the returned URL via `shell.openExternal`, and either await `q.claudeOAuthWaitForCompletion()` or — if the SDK requires the host to handle the redirect — register a `claude-markdown://oauth` protocol with `app.setAsDefaultProtocolClient` and forward `code`/`state` to `q.claudeOAuthCallback`. First task: confirm which path the SDK actually wants.
- [x] **24. Auth-mode picker in config mode.** Fourth field in the config status bar: `cwd | model | effort | auth`. Options: `api-key` (default when `ANTHROPIC_API_KEY` is set), `claude-ai` (subscription OAuth), `bedrock` (only selectable when its env vars are present, else grayed out with a tooltip explaining the missing vars). Mid-session changes require `/clear`.
- [x] **25. Auth error surfacing.** On `accountInfo()` failure or 401-style errors during a turn, render a blocking banner with `[Sign in]` (claude.ai), `[Set API key]` (with link to docs), or `[Check AWS credentials]` (Bedrock). Minimal placeholder banner now; folded into the general error-banner system once Phase 14 (Errors + compaction) lands.

## Phase 8 — Right-side status pane

- [x] **26. Sticky header: idle vs active.** Active: current activity string + `[Interrupt]`. Idle: last-turn tokens, model, latency.
- [x] **27. Structured event log.** Per-tool card: name, expandable input args, expandable output. `--- Turn N ---` separators.
- [x] **28. Tool chips in response pane (no inline output).** `⚙ Read foo.ts ✓` etc.; click → scroll/expand the matching right-pane card.
- [x] **29. `Structured | Raw JSON` toggle.** Raw view pretty-prints every SDK event in fenced JSON blocks.

## Phase 9 — Permissions

- [x] **30. `canUseTool` with auto-allowlist.** `Read/Glob/Grep/WebFetch/WebSearch` pass through silently; everything else denied for now (so the modal is the next commit, not a regression).
- [x] **31. Permission modal as right-pane card.** `[Allow] [Deny]` + `y`/`n` keystrokes; auto-focus when shown; agent paused until resolved. Inherit `~/.claude/settings.json` rules — only prompt for items not pre-allowed.
- [x] **32. Multi-option flows.** `1`/`2`/`3` for "allow once / allow session / deny" when SDK offers options.

## Phase 10 — Slash commands

- [ ] **33. App-intercepted allowlist: `/clear`, `/help`, `/cost`. `/insights`** `/clear` rebuilds session in same window (preserves `cwd`, defaults `model`/`effort`). `/help` overlay with keybindings. `/cost` scrolls right pane to usage. Everything else passes through to SDK unchanged.
- [ ] **34. `/model [name]` and `/model`.** Mid-session via `setModel()`; bare form lists models in right pane.
- [ ] **35. `/effort [level]` with lifecycle guard.** Only valid before first prompt; otherwise error message pointing to `/clear`. Verify `/effort high` → `/clear` → next `query()` carries `effort: 'high'` (one of the design's known-unknowns).

## Phase 11 — Building

- [ ] **36. Application build.** Ensure the application can be built on MacOS.
- [ ] **37. Shell shortcut.** Provide a small shell script that will launch the Electron application and set the `%CWD` variable to the directory the application was launched from.

## Phase 12 — Attachments

- [ ] **38. File drag-and-drop → Markdown link insert.** `[foo.ts](/abs/path)`.
- [ ] **39. Image paste → chip → image content block.** Placeholder chip in editor; on Send becomes an Anthropic `image` block; rendered into the transcript.
- [ ] **40. Reject oversized / over-count.** >5MB or >100 images → explicit error before Send; prompt not cleared.

## Phase 13 — Errors + compaction

- [ ] **41. Tool errors render as red chip + red right-pane card.** Permission denials show `denied` status (not error styling).
- [ ] **42. Blocking error banner with `[Retry] [Dismiss]`.** Network/4xx/5xx/rate-limit/SDK crash. Quota errors get a live countdown.
- [ ] **43. Config error banner with `[Reload settings]`.** Hook failures, malformed settings.
- [ ] **44. Compaction marker.** On `SDKCompactBoundaryMessage`: thin divider in transcript with `[show summary]` toggle; mirrored card in right pane; usage display reflects post-compact state.

## Phase 14 — Multi-window + MCP polish

- [ ] **45. `Cmd+N` new window in config mode; `Cmd+W` interrupts + cleans up.** macOS Window menu lists windows; app survives last-window-close.
- [ ] **46. MCP auth via `shell.openExternal`.** When an MCP auth tool emits a "visit this URL" message, open in user's real browser.
- [ ] **47. Optional `statusLine` shell-out.** Opt-in via app config; appended to right of status bar.

## Phase 15 — Smoke tests for the known unknowns (optional)

- [ ] **48. Verify user-level `CLAUDE.md` loads** with `settingSources: ['user','project','local']`.
- [ ] **49. Force a mid-stream compaction** to confirm divider rendering doesn't corrupt a partial assistant message; fix if needed.
---

## Ordering notes

- **Steps 6–7 come before any UI features.** The design explicitly says window-ID keying is the one architectural decision to make day one — doing it before there are handlers to retrofit costs almost nothing.
- **Phase 7 (auth) sits before the right-side pane** because auth-mode is load-bearing for the cost chip (step 20) and for any per-provider behavior the right-side pane will surface (e.g. Bedrock has no rate-limit events, claude.ai has no cost). Better to expose the signal once than retrofit conditionals later.
- **Step 30 intentionally denies non-allowlisted tools** so step 31 isn't fixing a regression — it's adding a missing capability.
- **Phases 5 and 8 stay decoupled.** Tool chips (step 28) need both the response transcript and the right-pane cards, so they sit in phase 8.
- **Compaction (step 44) lives with errors**, not with response rendering, because the SDK message arrives through the same event stream as errors and is easier to handle once that pipeline is mature.
