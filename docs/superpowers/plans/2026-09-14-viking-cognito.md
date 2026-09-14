# Viking Cognito Implementation Plan

**Goal:** Deliver an isolated, testable portal and Pi key integration using the
existing scheduler pool while preserving the live legacy contract.

**Architecture:** Separate portal, persistent key repository, bounded Cognito
client, upstream memory adapter and explicit legacy forwarding. Production
activation follows local verification and an operator browser-login check.

**Tech stack:** Node 22 ESM, node:http/crypto, PostgreSQL (`pg`, already used by
the memory service), native browser HTML/CSS/JS, upstream OpenViking v0.4.20.

**Spec:** ../specs/2026-09-14-viking-cognito-design.md

## Constraints

- No changes to scheduler code, app client or live service during preparation.
- No client-provided identity accepted; private memories per verified subject.
- Preserve exact legacy Pi envelope, metadata and token behavior.
- No shared upstream root keys in browser or Pi settings.
- Tests first for authentication, authorization and persistence boundaries.

## Task 1: Login and sessions

Files: src/cognito.mjs, test/cognito.test.mjs under services/viking-portal.
Export `CognitoClient({issuer, domain, clientId, clientSecret?, redirectUri,
fetch?, now?})`, `.authorizationUrl({state,nonce,verifier})`, and
`.exchange({code,nonce,verifier}) -> {sub,email,expiresAt}`.
Validate RS256 JWKS signatures, issuer, audience, nonce, expiry and token_use.
Reject malformed/oversized responses and bounded timeouts. Use generated test
RSA keys; demonstrate invalid tokens are rejected before implementing success.

## Task 2: Persistent access keys

Files: src/keys.mjs, test/keys.test.mjs, test/keys-postgres.test.mjs.
Export `MemoryKeyStore` and `PostgresKeyStore` with async `init`, `create(owner,
options)`, `list(owner)`, `revoke(owner,id)`, `authenticate(secret)`, `close`.
Return raw `secret` only from create; list returns metadata. Authenticate
returns `{owner,scopes}` or null. Test owner isolation, scope/expiry validation,
restart persistence, raw secret absence in SQL and immediate revocation.

## Task 3: Portal and compatibility routes

Files: src/server.mjs, src/index.mjs, public/*, test/server.test.mjs.
Export `startPortal({host,port,origin,cognito,keys,memory,legacy?})` returning
`{url,close}`. Memory interface is `store(owner,record)`, `recallAll(owner)`,
`search(owner,query)`, `health()`. Sessions alone manage keys. Personal Bearer
keys authorize memory routes; legacy credentials only forward legacy routes.
Test via real local HTTP requests and unchanged Pi provider integration.

## Task 4: Upstream and deployment

Files: src/upstream.mjs, test/upstream.test.mjs, README.md, deploy/*.
Resolve exact pinned upstream endpoints from source before implementation.
Prepare dedicated Cognito client JSON, systemd/nginx examples, isolated compose
testing and rollback instructions. A new upstream smoke test must exercise
two users with overlapping record IDs. Record any unavailable model/runtime
prerequisites rather than claiming a fake server proves upstream compatibility.

## Task 5: Independent review and verification

Run service tests, real PostgreSQL tests, upstream smoke where feasible,
existing runtime tests/typecheck/lint and browser UI checks. Independently
review auth, namespace and legacy proxy boundaries; fix findings and rerun
affected checks. Report remaining production activation steps explicitly.
