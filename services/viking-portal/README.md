# Viking memory portal

A separately deployable Cognito login and personal-key portal for Pi. It bridges
the existing Pi `/memory` contract to upstream OpenViking **v0.4.20**, keeping an
optional legacy lane for existing clients. It does not replace the live service
merely by being installed.

**Production activated 2026-09-14:** https://viking.metabolomics.us.
See [deployment evidence](../../docs/deployments/viking-production-2026-09-14.md)
and [local Pi setup](../../docs/deployments/viking-client-setup.md).

## Current integration facts

- Existing scheduler pool: `us-west-2_GjtcM0PCp` in `us-west-2`.
- Login domain: `https://us-west-2gjtcm0pcp.auth.us-west-2.amazoncognito.com`.
- Create a separate app client using `deploy/cognito-client.json`. Do not modify
  scheduler client `6mcn0idau4b5uhtkd1b2g6c9qg` or pool-level configuration.
- Scheduler uses direct Amplify login, so existing scheduler browser sessions
  are not automatically Cognito hosted-login sessions. Accounts are shared.
- Pool self-registration is enabled and invokes a PostConfirmation Lambda.
  This portal adds no signup flow, but **the existing Cognito hosted page can
  still offer signup**. Using a separate app client does not disable pool-level
  triggers. Onboard existing users first; changing signup policy is a separate
  pool-wide decision.

## What is implemented

- `/`: private memory browser/search and personal device-key management.
- `/auth/login`, `/auth/callback`, `POST /auth/logout`: Cognito authorization
  code + PKCE, validated RS256 ID tokens, server-side sessions and CSRF checks.
- `/api/me`, `GET/POST /api/keys`, `DELETE /api/keys/{id}`: session-only key
  management. Keys expire after 1–90 days or explicitly never expire, max 20 active per user. Secrets appear
  only at creation and persist only as SHA256 hashes.
- `GET/POST /memory`, `GET /memory/search?q=`: the existing Pi envelope and
  keyword-search behavior. Device scopes are `memory:read` / `memory:write`.
- `/health`: upstream and portal database readiness, no memory contents.

Use issuer plus verified Cognito `sub` to derive a stable owner. Each owner gets
a separate upstream account AND user. Exact record JSON lives under that user's
`resources/pi-memories`; source references and evidence metadata are retained.
The upstream processed `/memories` namespace rewrites content and is deliberately
not used for the compatibility contract. Semantic search/extraction is not
enabled by this adapter.

The portal is a dedicated UI for these records and keys. Upstream Web Studio is
present in the pinned image, but **is not exposed through this portal**. Its
connection layer expects upstream keys and probes administrative APIs. Serving
it with the shared root key would violate user isolation. A separate Studio
connection-layer integration is needed before offering it to ordinary users.

## Sessions, permissions and bounds

Sessions expire with the Cognito ID token, at most one hour. Restarting the portal
signs browsers out; device keys survive because PostgreSQL owns them. Sign out
ends the portal session, not the shared Cognito login cookie. No Cognito tokens
or root API keys enter browser storage. No administrator automatically gains
access to another user's memories.

Device keys are independent of Cognito sessions. **Disabling/deleting a Cognito
user does not automatically revoke their keys.** For offboarding, revoke the
owner's keys in the portal database as well; identify the owner with
SHA256(issuer + NUL + sub). Expiry on dated keys is an additional limit, not an
offboarding mechanism. Existing in-flight requests may finish after revocation;
subsequent authentication is rejected. Non-expiring keys remain valid until
revoked; choose **Never expires** in the UI or send `expiresInDays: null` to
the key-creation API. Omitting expiry still defaults to 30 days. Existing keys'
expiry dates are not changed by the additive nullable-expiry migration.

New memory calls are limited to two per owner and eight globally. Retrieval
rejects collections above 1,000 records or 8 MiB and has an operation deadline;
it never silently truncates. A paginated API is needed before exceeding those
limits. Login attempts are limited to ten per client address per minute.
The service trusts `X-Real-IP` only from loopback in production, so nginx must
overwrite that header with `$remote_addr`, as the supplied fragment does.

## Development verification

From the repository root:

```sh
npm ci
npm ci --prefix services/viking-portal
npm run check --prefix services/viking-portal
npm test --prefix services/viking-portal
npm run typecheck
npm test
npm run lint
```

The `.mjs` service uses syntax checks and a dedicated Biome configuration; the
root TypeScript check covers the Pi runtime. Service tests are not accidentally
hidden by the root Biome `services` exclusion.

For real database tests, start a disposable PostgreSQL database and set
`VIKING_TEST_DATABASE_URL`. They use unique owner IDs and remove only their own
rows. For the real upstream/Pi test, also set `VIKING_LIVE_TEST=1`,
`VIKING_TEST_UPSTREAM_URL` and `VIKING_TEST_UPSTREAM_KEY`. The test requires
loopback endpoints and creates/deletes dedicated test accounts. Never point
it at production. Without these variables the integration tests explicitly skip.

```sh
VIKING_PLAYWRIGHT_MODULE=/path/to/existing/@playwright/test \
  node services/viking-portal/test/browser-smoke.mjs
```

The browser script uses actual portal HTTP, Chromium, a memory fixture and a
test-only Cognito redirect fixture. It does not prove real Cognito sign-in.

## Production activation and rollback

The initial implementation was staged without changing production. The operator
subsequently approved activation, and confirmed real Cognito sign-in. The steps
below document the rollout/rollback process; do not repeat resource creation
against an already deployed installation.

1. Back up the existing nginx vhost, `/opt/viking/openviking.sif`, secrets and
   `openviking` PostgreSQL database. Record current authenticated `/memory`
   contents/count. Keep the old service on 8090 and old DB intact. Do not run
   `deploy/apptainer/deploy-whiteale.sh`, which restarts the existing service.
2. Create a dedicated PostgreSQL database and restricted role for portal keys.
   Store its connection string in a 0600 secret file readable only by the portal
   service account. Never reuse the old memory database for schema experiments.
3. Create `viking-memory-portal` with the supplied client request. First list
   clients to prevent duplicate creation. Capture the returned client secret
   into a private file rather than stdout/logs:
   ```sh
   umask 077
   aws cognito-idp create-user-pool-client --region us-west-2 \
     --cli-input-json file://deploy/cognito-client.json > /secure/path/new-client.json
   ```
   Transfer the client ID/secret to portal config; keep the returned document
   private. This operation creates one new client and does not update scheduler.
4. Install upstream separately under `/opt/viking-upstream`, with its own
   account, `/var/lib/viking-upstream` data directory and private configuration.
   Pinned image successfully tested:
   `ghcr.io/volcengine/openviking@sha256:b9827753d035f4157b5b318865907fd18f738924ad6398c86feb1182f209825b`.
   Use the provided `viking-upstream.service`. The host's default image pull
   failed with squashfs "Bug in orderer"; this tested build command avoids it:
   ```sh
   apptainer build --disable-cache \
     --mksquashfs-args '-processors 1 -comp gzip -Xcompression-level 1' \
     /opt/viking-upstream/openviking.sif \
     docker://ghcr.io/volcengine/openviking@sha256:b9827753d035f4157b5b318865907fd18f738924ad6398c86feb1182f209825b
   ```
   Both Docker integration and host Apptainer loopback startup were tested.
   Confirm the installed service account's directory permissions before cutover.
5. Configure a working embedding provider before starting upstream. The included
   `upstream.conf.example` was tested locally with Ollama `nomic-embed-text`
   (768 dimensions) and `qwen2.5:0.5b`, with `api_key: "ollama"` required in VLM
   config. These small local models establish integration, not semantic quality.
   Start/model-provision Ollama separately or use an approved existing provider.
   Keep embeddings and upstream ports loopback-only. Load models BEFORE startup.
6. Install portal source plus production `npm ci --omit=dev` under
   `/opt/viking-portal`; Node 22+ is required (host inspection found Node 24).
   Create a separate `viking-portal` system user and 0600 files beneath
   `/etc/viking-portal`. Populate `portal.env.example`. Start the new service
   on 8091 using its dedicated systemd unit. It never starts in unauthenticated
   mode or silently falls back to volatile key storage.
7. Copy ONLY the old token value into the legacy-token secret file. Configure
   legacy forwarding to `http://127.0.0.1:8090`. Verify the old token returns
   identical JSON through 8091 before modifying nginx. New keys cannot read that
   legacy store, and the old token cannot manage new keys or read private users.
8. Validate `/health` on 8091. Merge the supplied nginx locations into the
   existing TLS vhost, retaining certificate/ACME settings. Keep `/health` and
   `/metrics` routed to the old service and add `/portal-health` separately.
   Run `nginx -t`, reload, then sign in with an existing Cognito account. Verify
   two users, key creation, Pi promotion/recall and revocation on the live path.
9. Roll back by restoring the old nginx vhost and reloading. Keep the new
   upstream data and portal database: new users' private data is not in the
   legacy backend. Restore the portal route to regain new-key access. Never
   copy everyone's private records into the old shared store.

Legacy traffic still traverses the portal after cutover, so portal availability
is an additional dependency for those clients. The vhost rollback restores the
original direct path. No automatic global migration or dual-write is attempted.

The sample upstream configuration leaves upstream encryption disabled (its
default). If encryption is enabled, explicitly place its master key in a
persistent private path and back it up with the data; do not depend on an
ephemeral container home directory.

## Remaining product work

The tested first slice is personal memory and device keys. Shared project ACLs,
automatic Cognito offboarding, seamless scheduler SSO, upstream Studio adaptation,
semantic retrieval, and unbounded-history pagination require separate designs
and tests. They are not enabled or implied by the private compatibility portal.
