# Viking portal verification — 2026-09-14

Implementation: branch `feat/viking-cognito-portal`, based on `afd49be` in
`/home/wohlgemuth/IdeaProjects/pi-engineering-runtime-viking-cognito`.

## Verified

- Combined `npm test`: **420 passed, zero failed, zero skipped**, with both
  database test environment variables and `VIKING_LIVE_TEST=1` enabled.
- This includes all 300 existing runtime tests and 120 new portal tests.
- Real PostgreSQL 16: hash-only key storage, restart persistence, cross-process
  revocation, owner isolation and concurrent quota enforcement.
- Real upstream OpenViking v0.4.20 with local Ollama models: exact JSON round
  trip through the unchanged `OpenVikingProvider`, overlapping record IDs for
  two private users, updates, keyword search, foreign-user denial, root/admin
  route denial, and revoked-token 401.
- Upstream OCI digest:
  `sha256:b9827753d035f4157b5b318865907fd18f738924ad6398c86feb1182f209825b`.
- Cognito unit tests validate RS256 signatures/JWKS, issuer, audience, nonce,
  token_use, expiry/issued-at, PKCE, malformed/oversized responses and timeouts.
  Login/session tests validate state/cookie binding, replay rejection, CSRF,
  Secure cookie attributes, expiry and per-client throttling.
- Browser smoke: real Chromium desktop 1440x1000 and mobile 390x844, actual portal
  HTTP, test-only Cognito and memory fixtures. Login, mint/reveal, redacted key
  lists, clipboard/manual fallback, inert XSS text, search, revoke and logout.
  Screenshots: [desktop](desktop.png), [mobile](mobile.png).
- Root and service Biome lint/format, Node syntax checks, root TypeScript check,
  command registration and package-load smoke all passed. `.mjs` service code
  is checked with Biome/syntax tests, not claimed to have full TypeScript coverage.
- Independent security review found two availability issues; fixes were tested
  and re-reviewed with **no blocking findings remaining**.
- Dedicated Cognito app-client JSON passed botocore input-shape validation.
  AWS CLI output-skeleton generation has an unrelated invalid dummy-output
  validation issue; no create/update AWS call was made.

## Host validation

On `viking.metabolomics.us`, existing Node 24.18 and Apptainer 1.5.1 were found.
The default Apptainer pull failed with `mksquashfs ... Bug in orderer`.
Building with `-processors 1 -comp gzip -Xcompression-level 1` succeeded,
producing a 323 MiB candidate SIF under the operator's cache directory.

The candidate ran briefly on **127.0.0.1:19339** with separate scratch data and
a random test-only root key. Embeddings/VLM used the local test Ollama instance
through a temporary SSH reverse tunnel, not production credentials or providers.
`/health` returned `healthy:true`, `version:v0.4.20`, `auth_mode:trusted`.
The temporary process had a 50-second termination limit; no systemd unit was
installed or replaced for this check.

The existing service on 8090 remained healthy and still reported exactly one
stored record. Nginx, scheduler authentication, the legacy token/database and
production service configuration were not changed.

## Not yet verified or activated

- No new Cognito app client has been created; no actual human Cognito sign-in
  has been performed. Unit/browser fixtures are not presented as AWS validation.
- The production portal/key database/upstream service and nginx cutover have
  not been activated. Dedicated production model configuration remains part of
  that rollout; small local models prove integration, not semantic quality.
- This is a portal-native private-memory and key UI. Official Studio adaptation,
  shared project ACLs and automatic Cognito-offboarding revocation are not in
  this slice. Scheduler accounts are shared; its direct-login browser session
  does not become a hosted-login session automatically.

## Reproduction

Use the service README commands with disposable PostgreSQL and upstream servers.
Set `TEST_DATABASE_URL` for the old memory service tests,
`VIKING_TEST_DATABASE_URL` for portal keys, and `VIKING_LIVE_TEST=1`,
`VIKING_TEST_UPSTREAM_URL`, `VIKING_TEST_UPSTREAM_KEY` for the upstream smoke.
The upstream smoke refuses non-loopback target URLs and cleans its test accounts.

CI now installs both memory services' dependencies and starts PostgreSQL 16.
The standard `npm test` includes portal tests; the actual upstream smoke stays
explicitly opt-in because CI does not provision an embedding/VLM runtime.
