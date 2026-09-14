# Viking production activation — 2026-09-14

The operator authorized production activation after reviewing the isolated
implementation. The public portal is **https://viking.metabolomics.us**.

## Live components

| Component | Configuration |
|---|---|
| Cognito pool | `us-west-2_GjtcM0PCp`, existing scheduler pool |
| Dedicated app client | `viking-memory-portal`, `4cve1a48rf1p827a85bu42c3ss` |
| Portal | `viking-portal.service`, loopback 8091, `/opt/viking-portal` |
| Upstream | `viking-upstream.service`, OpenViking v0.4.20, loopback 1933 |
| CPU models | `viking-ollama.service`, Ollama 0.17.7, loopback 11434 |
| Portal key database | PostgreSQL `viking_portal`, dedicated restricted role |
| Upstream data | `/var/lib/viking-upstream`, bound to `/data` |
| Model data | `/var/lib/viking-ollama/models` |
| Legacy service | `openviking.service`, 8090, retained with original database/key |
| Public health | `/health` and `/metrics` retain legacy targets; `/portal-health` checks new dependencies |

The dedicated client requires write permissions for the pool's required
`email`, `family_name` and `name` attributes. An initial request with only
`email` was rejected; no client was created by that failed request. The retry
with those three attributes succeeded. Scheduler client and pool settings were
not changed. Cognito client credentials and other service secrets are in private
files under `/etc/viking-portal`; no secrets are recorded in this document.

The upstream SIF was built from:
`ghcr.io/volcengine/openviking@sha256:b9827753d035f4157b5b318865907fd18f738924ad6398c86feb1182f209825b`.
The host's squashfs workaround is documented in the service README.

Ollama's CPU binary and CPU libraries were extracted from the official pinned
image `ollama/ollama@sha256:0ff452f6a4c3c5bb4ab063a1db190b261d5834741a519189ed5301d50e4434d1`
under `/usr/bin/ollama` and `/usr/lib/ollama`, installed preserving that layout
under `/opt/viking-ollama`. CUDA, MLX and Vulkan libraries were omitted. Native
binary compatibility and real CPU model calls were verified on the host.

Models: `nomic-embed-text` (768 dimensions) and `qwen2.5:0.5b`.
They serve exact-record compatibility processing locally; this release does
not claim semantic-search quality or automatically extract ordinary Pi chats.

## Verification

- Public UI 200 and real Cognito hosted-login form verified in Chromium.
- Operator confirmed successful account login to the new portal.
- Production HTTPS tests used temporary non-Cognito smoke identities and keys:
  two-user isolation with the same record ID, exact writes/reads, replace/search,
  denial of key-management/admin routes to device keys, immediate revocation.
  All temporary keys and upstream smoke accounts were removed afterward.
- Legacy `/memory` response through the portal matched direct 8090 byte for byte,
  with one original record. The legacy database was not migrated or rewritten.
- All four systemd services active; legacy and new dependency health endpoints 200.
- Local final regression suite: **428 passed, zero failed, one skipped**.
  The skipped test is the explicitly opt-in local upstream test; production
  HTTPS roundtrips were exercised separately as described above.
- Desktop/mobile browser regression passed using local Cognito fixtures.
  Desktop generated a non-expiring key; mobile retained a dated 7-day key.
- Independent review approved the nullable-expiry change without blocking findings.

## Non-expiring keys

The operator requested **Never expires** during activation. API representation:
`expiresInDays: null` on creation, `expiresAt: null` in metadata. Omitted expiry
still defaults to 30 days; dated values remain 1–90 days. Permanent keys count
toward the 20-active-key quota and remain individually revocable.

An idempotent migration makes `expires_at` nullable; it does not rewrite existing
dates. Real PostgreSQL tests covered an old NOT NULL schema, restart persistence,
100-year simulated elapsed time, active quotas and revocation. A temporary
production non-expiring key authenticated over HTTPS, then returned 401 after
revocation; that key/account was cleaned up. No existing production device keys
were present at migration time.

The portal restart for this update clears browser sessions; sign in again if
needed. Refresh the page to see the new option. Existing dated keys are not
converted to permanent keys.

## Backups and rollback

- Pre-portal backup: `/opt/viking/backups/pre-portal-20260914T221728Z`
  (nginx, original SIF/unit/secrets, PostgreSQL dump and memory baseline).
- Pre-expiry backup: `/opt/viking/backups/pre-nonexpiring-20260914T222935Z`
  (portal/upstream credentials, source, portal database dump and expiry snapshot).
- Secrets and dumps are protected beneath root-only backup directories.

Restore the saved pre-portal nginx vhost, run `nginx -t`, then reload nginx to
restore the original direct 8090 path. Keep the new database and upstream data;
private records are not in the legacy shared store. Rolling back traffic makes
new personal keys unavailable until the portal route is restored.

Memory/search and OAuth callback access logging are disabled so sensitive query
context and authorization codes are not retained in nginx access logs. Other
virtual hosts and scheduler authentication were not changed.

## Services status page

On 2026-09-14, the operator requested monitoring at
https://status.metabolomics.us/status/services. Uptime Kuma monitor **178**,
**OpenViking**, was added to the existing **Web vhosts** group 69. It checks
`https://viking.metabolomics.us/portal-health` every 60 seconds with TLS validation
and HTTP 200 required. A real heartbeat reported UP. Notifications are disabled;
all prior page settings and monitor memberships were preserved.

Before the supported Socket.IO API changes, a consistent SQLite backup was
saved on the monitoring host at
`/root/status-backups/before-openviking-20260914.db` with mode 600 and a successful
integrity check. A private API snapshot is inside its uptime-kuma container at
`/app/data/openviking-status-before-20260914.json`.
