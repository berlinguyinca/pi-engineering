# Viking portal, Cognito, and compatible Pi access

## Approved direction and evidence

The operator requested an OpenViking UI, shared authentication using the existing
lc-binbase-scheduler Cognito pool, and personal keys for Pi clients, with no
disruption to existing clients. This implementation is isolated from production.

Read-only AWS inspection on 2026-09-14 confirmed pool `us-west-2_GjtcM0PCp`,
region `us-west-2`, and domain
`https://us-west-2gjtcm0pcp.auth.us-west-2.amazoncognito.com`.
Scheduler client `6mcn0idau4b5uhtkd1b2g6c9qg` uses direct Amplify authentication,
not hosted login. Shared accounts do not imply shared existing browser sessions.
A separate Viking client avoids modifying scheduler callbacks or token audiences.
The pool has a PostConfirmation trigger; this portal does not implement signup.

The current service at viking.metabolomics.us is services/openviking, not the
upstream volcengine server. It uses a shared Bearer key, flat PostgreSQL records,
and `/memory` paths. Exactly one deployment-test record was found. Upstream
v0.4.20 is the pinned evaluation target, never an automatic in-place replacement.

## Architecture

Add `services/viking-portal`, a separately deployable service. Keep the existing
service, database, key, image and reverse-proxy configuration intact until a
tested cutover. The portal supports `/memory` and `/memory/search` with the same
JSON record envelope as the current Pi provider. A legacy token forwards only
those routes to the existing loopback backend. New personal keys access only
their authenticated user's upstream namespace. Never infer ownership from
request headers, record IDs, `promotedBy`, or other caller metadata.

Cognito code+PKCE login uses server-side state, browser-bound single-use login
attempts, nonce checking and validated ID tokens. Session cookies are HttpOnly,
SameSite=Lax, Secure on HTTPS. Sessions expire, logout revokes the local session,
and key-management mutations require an exact configured Origin and CSRF token.
Cognito tokens and upstream root keys never enter browser storage.

The portal stores personal key hashes and ownership in PostgreSQL. Random
256-bit secrets are displayed once. Keys have a name, scopes (`memory:read`,
`memory:write`), expiry (1–90 days, or explicitly no expiry), last-used timestamp
and revocation. The operator requested non-expiring keys during the rollout;
`expiresInDays: null` represents that choice, while omission still means 30 days.
Only browser sessions may manage keys. A device key cannot create more keys.
An owner's stable ID derives from the configured issuer and verified subject.
Revocation is checked on every request. Disabling Cognito users does not itself
revoke independent keys; document the separate revocation procedure.

The browser UI lists/searches personal memories and manages device keys with
copyable Pi environment instructions. A link to upstream Studio is only offered
when authenticated proxying/identity isolation for that entire API surface is
verified. Do not expose Studio with a shared root key or assert it is integrated
merely because its static page renders.

## Alternatives

1. Replace the live service immediately: rejected because the Pi HTTP contract,
   ownership and upstream model/storage requirements differ.
2. Keep only the small custom service: low migration effort, but loses the
   upstream capability goal.
3. Separate authenticated portal and pinned upstream, preserving a legacy lane:
   selected because it can be validated and rolled back independently.

## Verification and rollout boundaries

Tests must prove correct code flow and reject state/nonce replay, wrong token
issuer/audience/use/signature, expired keys/sessions, foreign-key revocation,
cross-user record access and caller-controlled identity headers. Run existing
Pi contract tests unchanged. Use real local PostgreSQL for persistence tests.
Upstream adapter tests must be distinguished from a real upstream smoke test.

Prepare a dedicated Cognito app-client request, separate database/environment,
loopback service, and route-by-route nginx cutover instructions. Do not change
the scheduler client, run old destructive deploy scripts, migrate unidentified
legacy records to all users, or claim Cognito browser login is proven without
an actual user login. Live activation is the final reviewable step.

## Sources

- https://github.com/volcengine/OpenViking/tree/v0.4.20
- https://github.com/volcengine/OpenViking/blob/main/web-studio/README.md
- https://docs.openviking.ai/en/guides/04-authentication
- https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html
- https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html
