# Changelog

## 0.1.0 — Unreleased

- Add installable `tern-bridge-droid` commands for native Droid conversations, history and right-hand splits.
- Reuse the original omp Composer, user bubbles, tool cards, session picker, selectors, approval and AskUser components through `@oh-my-pi/pi-tui` 18.11.0; remove the custom chat view/editor/styles.
- Preserve Droid login, saved conversation identity, working directory, model selection and permission policy.
- Add searchable history, rename/fork/compact/inspected rewind, model controls, exact offered approvals, editable plans and AskUser.
- Bind the shared UI to Droid-only sessions and commands, preserve drafts across connection/send failures, follow restored working directories, and reconnect without prompt replay. Bundle Bun-compatible production dependencies and platform licenses; require Bun 1.3.14+.
- Disable ambiguous new-session Spec handoff outcomes until the public Droid protocol exposes an authoritative successor identity; never guess a child session or fabricate a reply to an old persisted request.
- Keep unavailable provider costs, message timings and session file sizes undisplayed rather than fabricating metadata. Bridge-owned labels are bilingual; stock omp component copy remains unchanged.
