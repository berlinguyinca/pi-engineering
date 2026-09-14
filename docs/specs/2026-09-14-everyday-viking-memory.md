# Everyday Pi memory in the engineering harness

The operator requested everyday memory in the existing engineering harness:
explicit save, relevant recall in ordinary chats, and a visible connection state.
The repository is named `pi-engineering-runtime` and is already installed in the
operator's global Pi profile. Implement on a branch from current upstream main.

## Behavior

- `/remember <text>` saves only that explicitly supplied text as a user-confirmed
  private durable record. Reject empty text and text above 4,000 characters.
  No transcript upload, inferred fact promotion, model-triggered write or
  automatic save occurs. Success is reported only after a confirmed response.
- `/memory` performs an authenticated check and reports ready/empty, missing
  configuration/key, invalid/revoked key, denied access, timeout or server error.
  `/memory <query>` explicitly displays matching memories, with bounded output.
- Before an ordinary user turn, search with bounded significant tokens from
  that prompt, rank matching records locally, then inject at most five memories
  and 6,000 characters as untrusted reference data into the copied model context.
  Do not persist automatic recall as a transcript message or system prompt.
- Replace recall each turn; clear it on failure, session start/switch/fork,
  shutdown, and account/token rotation. Ignore stale asynchronous completions.
- A `Memory: ...` footer reports checking, ready/match count, off/missing key,
  or failure. Errors warn on transitions, not every prompt. Headless commands
  emit a visible custom response without starting another model turn.
- Re-read the existing environment/token-file configuration for operations so
  rotation is picked up. No new credentials, server configuration or packages.

The operator additionally requires a setup check after extension updates. On
the next interactive Pi start after install/update, offer keep/change/later,
showing the current host without credentials. Prompt for host and a masked key
when changing it, verify authentication, then persist private profile-owned
settings outside the checkout. Cancellation or failed validation preserves the
old connection. Remember the confirmed source revision; no per-prompt setup
dialog. `/memory setup` forces the check. Headless sessions do not prompt and
receive explicit terminal setup guidance. Saved choices override stale shell
defaults, but the explicit disabled environment flag still wins.

Detect profile/key/environment changes made while the setup dialog or credential
verification is awaiting completion; refuse to overwrite the newer connection.
Engineering runtime caching also keys on effective connection identity so newly
started engineering commands use a changed host or key.

## Boundaries

Ordinary recall uses the same authenticated `/memory` contract as engineering
workers. Add opt-in strict errors to OpenVikingProvider rather than changing
the existing fail-closed worker contract. Bound fetch and response-body time,
cap response size, and never include secrets/raw server bodies in errors.

Register interactive commands/hooks only from the extension entry point.
Do not add them to buildCoreTools or worker resource loaders. Worker sessions
already have an empty extension loader, preserving independent reviews and
challengers. Existing scout/planner/implementer hydration remains unchanged.

Saving a user-confirmed note is not a claim that it was machine-verified.
Records explicitly identify the `/remember` user request as their source.
Retrieved data never has system/developer authority. Current user instructions
take priority over old notes.

## Implementation and verification

1. Add strict client options/errors and targeted transport tests, preserving
   existing caller behavior.
2. Add `src/blackhole/interactiveMemory.ts` and event-handler tests for explicit
   saving, empty versus failure, limits, stale results, rotation and error recovery.
3. Register it once in `extensions/index.ts`; update command-load smoke proof
   and user documentation. Preserve the existing generation-guard hook.
4. Run typecheck, lint, tests, load/command smoke and independent review.
5. Use the real configured key for a temporary live roundtrip through command
   and hook handlers, then remove only the temporary record. No paid model call
   is needed to prove the resulting context contains the note.
6. Update the operator's clean installed local checkout to the reviewed commit
   without replacing unrelated work. Verify package loading there; existing Pi
   processes need `/reload` or restart to register the new commands/hooks.
