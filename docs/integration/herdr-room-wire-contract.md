# `/room` wire contract, observed against a real Herdr control plane (2026-10-29)

Verified by `test/integration/room-live.test.ts`, which boots a real `ControlPlaneServer` + `CollabService`
(Herdr `origin/main` 0391a6bb, loopback, in-memory repo, random token in a 0600 file) via
`test/fixtures/herdr-live-room-server.py`. Enable it with a gitignored local file
`test/fixtures/room-live.local.yaml` (no environment variables):

```yaml
herdr_src: /abs/path/to/a/herdr-engineering/checkout
python: /abs/path/to/python   # optional, default python3; needs Herdr's dependencies
```

If the file is absent, or Herdr cannot be imported, the test skips cleanly. All paths are under `/api/v1/collab` on the public listener.

| Pi command | Request | Observed response |
|---|---|---|
| auth (all) | `Authorization: Bearer <user token>` | 200. Missing, wrong, or `X-API-Key: <token>` header: 401 `{"error":"unauthorized"}` |
| `rooms` | `GET /rooms` | 200 `{"rooms":[{"room_id","name","role","project_id"}]}` (the field is `room_id`, not `id`) |
| `status` | `GET /rooms/{id}/state?since=-1&cursor=0&wait=0` | 200 `{seq, changed, events[], next_cursor, agents[], people[], tasks[], flow, links, missions, requests}`. `agents[]`: `agent_id,name,harness_type,owner_user_id,actions,address,aliases,online`. `tasks[]`: `task_id,target_agent_id,target_name,status,text,parent_task_id,untrusted`. Unknown room: 404 `{"error":"not found"}` |
| `status` | `GET /rooms/{id}/attention` | 200 `{items[],counts{open,...}}`; an item has `key,category,severity,subject,since,for_you,detail` and NO `title`; `subject` is an object `{node_id,node_type,label}`. 403 `{"code":"insights_disabled"}` when the operator has not enabled insights (Pi shows "Attention: unavailable") |
| `status` | `GET /rooms/{id}/agents` (used by `assign` to resolve a name) | 200 `{"agents":[...]}` same row shape as `state.agents` |
| `say` | `POST /rooms/{id}/messages {text, idempotency_key}` | first: 201 `{"event":{sequence,event_type:"message",sender,text,trust:"untrusted",...}}`; same key and text again: 200 `{"event":{...,"replayed":true},"replayed":true}`; same key, other text: 409; missing key: 400 `idempotency_key required (1-128 of A-Za-z0-9._:-)` |
| `assign` | `POST /rooms/{id}/tasks {target_agent_id, text, idempotency_key}` | first: 201 `{task_id,status:"pending",event}`; replay: 201 `{task_id,status:"pending",replayed:true}`; agent not in the room: 404 `no such agent in this room`. The task shows up in `state.tasks` and in `state.flow` (edge person -> agent) |
| graph link | n/a | The standalone page is `GET /` and routes `#/room/<room_id>`. `#/collab?room=` (what Pi used to print) is the embedded dashboard form and does not select a room |

Every refusal is `{"error": "<reason>"[, "code": ...]}`; Pi now appends the sanitized reason to its message.

## Credential

The Bearer value must be a collaboration USER token (Cognito id/access token in production; a static token in the
pilot authenticator used by the fixture). Herdr's own tests (`test_unauthenticated_and_legacy_keys_denied`) state
that legacy API keys (operator/viewer/ingest) are denied on the collab routes, so `herdr.api_key_file` for `/room`
must hold a user token, not the ingest key used for lineage. Not verified here: Cognito token verification and
expiry (the fixture uses the static authenticator); how a long-running Pi obtains or refreshes such a token.
