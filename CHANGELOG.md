# Changelog

## 0.1.0 — Unreleased

- Add installable `tern-bridge-droid` commands for native Droid conversations, history and right-hand splits.
- Reuse the original omp Composer, assistant messages, user bubbles, tool cards, session picker, selectors, approval and AskUser components through `@oh-my-pi/pi-tui` 18.11.0; remove the custom chat view/editor/styles.
- Preserve Droid login, saved conversation identity, working directory, model selection and permission policy.
- Add searchable history, rename/fork/compact/inspected rewind, model controls, exact offered approvals, editable plans and AskUser.
- Fix duplicate modal wrapping around the original omp option picker: remove the empty horizontal sheet and extra dimming while preserving search, scrolling and exact selection. Document the normal macOS ⌘K launcher instead of a control-socket command.
- Render complete assistant content runs with the original `AssistantMessageComponent`, retaining Markdown structure, thinking sections and tool ordering. Bind streaming to real delta/block-completion events, keep restored reasoning settled and remove the extra bridge-owned Working phase line without hiding errors or recovery notices.
- Add native syntax highlighting to Droid Read source and Grep content results, including per-file language, real line numbers and context markers. Preserve partial/history rendering and original tool controls; keep notices, errors, unknown formats and command logs unchanged without reading host files or invoking omp tools.
- Present Sessions, More, interaction mode and autonomy as original omp rounded action buttons without changing their commands or permission policy.
- Open the original context report from the composer meter or `/context`, with Droid-reported category accounting, bilingual labels, immediate loading and in-place retry. Reject stale session/reload results and do not invent an auto-compaction threshold or reserve.
- Display confirmed Droid TodoWrite snapshots in the native dock checklist HUD and popover, including live progress, history restore, completion and clearing. Keep failed/unexecuted writes out of the HUD; never infer phases, persist a second task store or inject reminders.
- Bind the shared UI to Droid-only sessions and commands, preserve drafts across connection/send failures, follow restored working directories, and reconnect without prompt replay. Bundle Bun-compatible production dependencies and platform licenses; require Bun 1.3.14+.
- Disable ambiguous new-session Spec handoff outcomes until the public Droid protocol exposes an authoritative successor identity; never guess a child session or fabricate a reply to an old persisted request.
- Keep unreported per-message usage, provider costs and session file sizes undisplayed rather than fabricating metadata. Live thinking uses the stock component's observed display clock; restored thinking gets no invented duration. Bridge-owned labels are bilingual; stock omp component copy remains unchanged.
