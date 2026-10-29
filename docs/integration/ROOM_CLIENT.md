# Native Pi room client (herdr-unified-workspace P04, Pi side)

Status: partial. Evidence notes for `evidence/P04-RESULT.md` (that file lives in the Herdr repo, not here).

## What it is
A terminal client for Herdr Collaboration Network (HCN) rooms, built on the existing external-agent plumbing
(`src/runtime/herdr/externalAgent.ts`). No second chat service, credential store or UI stack.

| File | Role |
|---|---|
| `src/runtime/herdr/roomFeed.ts` | cursor + dedup, SSE parser, terminal sanitising, three verbosities |
| `src/runtime/herdr/roomClient.ts` | pages, `follow` (reconnect), post, local 0600 position file |
| `src/runtime/herdr/roomCli.ts` | `pi-engineering room ...` and the slash handlers (one module) |
| `src/runtime/herdr/roomCommands.ts` | registers `/rooms` and `/room` (called from `extensions/index.ts`) |
| `src/runtime/herdr/externalAgent.ts` | gained `raw()` and `roomId`; `herdr join/leave` unchanged |

## Commands
`pi-engineering room list | join --code-file <path|-> | attach | history | catchup | tasks | artifacts | say | leave`
(`join`/`leave` ARE `herdr join`/`herdr leave`.) JSON on stdout; exit 0 ok, 1 refused or failed, 2 usage / not joined /
no `herdr.url`, 3 HCN offline.

- `attach [--room id] [--activity|--expert|--verbosity v] [--slow] [--json] [--from-start|--cursor n]`: follow the room
  until Ctrl-C. Resumes from the saved position. Notices go to stderr, one per transition.
- `history [--cursor n] [--limit 1..200] [--tail n] [--text]`: server-side forward pagination
  (`GET rooms/{id}/events?cursor&limit`, `next_cursor`, `has_more`); stable while new events append. `--tail` reads to the end
  (at most 100 pages) and keeps the last n.
- `catchup`: everything since the saved position, then advances it.
- `tasks`: read-only. `artifacts`: artifact ids referenced by room messages. `say --text t | --text-file -`: post a line.
- Pi: `/rooms`, `/room join --code-file <path>`, `/room catchup`, `/room tasks`, `/room artifacts`. A join code is never accepted inline
  (it would land in the session transcript). The default verbosity of the slash commands is simple; `--activity`, `--expert`.

## Reconnect, dedup, gaps
`follow` = read pages after the cursor until `has_more` is false, then hold `events/stream?cursor=`. Every drop, including the
server's 1 h stream limit, re-enters that loop from the unchanged cursor. Events are accepted once by `sequence` and `event_id`.
HCN sequences are global across rooms, so a room's own sequences are not contiguous: gap recovery is re-reading from the cursor,
never counting. If a server ever answers with a cursor behind ours, the client adopts it and says so (`cursor_reset`).
Status output is exactly: connected, offline, reconnected (with how many events were caught up), cursor reset, revoked.
Retries are silent. Backoff 1 s doubling to 30 s (slow mode: 5 s to 60 s). `--slow` skips the stream and polls 20-event pages.

## Verbosity
simple: chat, plus a task only when finished or needing input. activity: + all task changes and room activity one-liners.
expert: + sequence and event id, every event type. All message text is untrusted: escape sequences, control and
direction-override characters are stripped before display.

## Standalone (INV-013, A15)
Nothing on Pi's start path imports or calls this client; registering the slash commands opens no connection. With no
`herdr.url`, no credential, or the credential file not private, every room command says so and exits 2 without a network call.
With HCN unreachable, commands print `HCN offline` and exit 3; `list` still answers from the saved credential. Detaching
(`attach` ends) only closes this client's read stream and never signals an agent process.
Test: `test/unit/room-client.test.ts` ("INV-013").

## Limits of an external Pi credential (decided by Herdr, observed from `collab.py` on origin/main)
Bound to ONE room; reads/posts chat only (`events` shows `message` events); `GET /rooms`, `/tasks`, `/state` answer 403 for it.
So: `list` shows the credential's room (not a server room index); `tasks` returns `forbidden`; `artifacts` is derived from
message `artifact_ids`; there is no state long-poll use; the credential is `terminal: false`.

## Partial / not done
- Attach authorization: `attach` follows chat only. Attaching to an agent's terminal needs Herdr's `authorize_workspace` and
  independent terminal authorization; external credentials cannot have it. Left to P05/P06.
- Credential storage is the existing 0600 file (`herdr-external.json`); OS keychain is not done. Revocation works server-side
  (next request 401, `follow` ends with a `revoked` notice).
- Multi-room per Pi: one credential = one room. Pi-side per-mission room binding exists (`ingest.scopes`, PR for P02) but nothing
  calls it for a room yet.
- No interactive composer or `@agent` completion in `attach` (use `say`); no Markdown rendering beyond sanitised plain text;
  screen-reader labels and stable scroll are inherent to line-oriented output, not separately implemented.
- Not verified against a live HCN (only injected-fetch tests, shaped from `herdr_engineering/control_plane/collab.py`).
- `/room tasks` submission is P05; not implemented.
