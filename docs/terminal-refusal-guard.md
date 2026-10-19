# Terminal gateway refusals in interactive Pi

The gateway provider wrapper already declines an unsafe replay. Pi's outer session
retry loop can nevertheless retry its resulting assistant error because the error
contains `503`. `registerTerminalRefusalGuard` installs a public `message_end`
handler that calls `ctx.abort()` when a failed assistant message contains parsed,
explicit InferWeave terminal guidance. This marks the current run cancelled before
Pi decides whether to retry. The handler must not await abort: abort waits for the
run that is currently awaiting the handler.

The guard preserves the assistant message, original error bytes, request ID, and
error stop reason. It does not change retry settings or classify arbitrary 503s
as terminal. Safe backoff guidance and ordinary transient failures retain their
existing retry handling. Malformed or untagged text is outside this guard's scope.

The helper can be registered by itself using an extension's public `on` API. It
requires no session files, credentials, model requests, or Engineering services.
A module-level weak set deduplicates handling of the same assistant message when
multiple extensions register this helper. A later message is checked independently.

Abort ends the current operation. In interactive Pi, the existing abort handler
restores pending queued text to the editor; it does not automatically resubmit
that text. This guard does not solve the upstream failure that generated the
refusal or authorize manually replaying a request with unknown dispatch state.

The regression uses a loopback HTTP provider and real AgentSession with retries
enabled and `maxRetries: 3`. The control makes four requests. With the guard, the
same terminal payload makes one request, with zero retry events and unchanged
persisted error text. An ordinary 503 still retries and succeeds.

```sh
node --test --import ./test/support/isolatedState.ts test/integration/terminal-refusal-session.test.ts
# Validate a separately installed SDK without changing the repo dependency:
PI_TEST_SDK_ENTRY=/absolute/path/to/pi-coding-agent/dist/index.js \
  node --test --import ./test/support/isolatedState.ts test/integration/terminal-refusal-session.test.ts
```

Validated against the repository's 0.87.1 SDK and the locally installed 1.3.0 SDK.
A running process must reload its extensions to load this fix; updating files on
disk alone does not prove that an existing session has the guard installed.
