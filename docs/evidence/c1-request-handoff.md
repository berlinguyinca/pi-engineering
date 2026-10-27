# C1 session handoff request transfer

The original C1 check proved that model switching wrote a handoff artifact and
transition log. It did not inspect the next provider request. A real Pi 0.87.1
SDK session reproduced the gap: after a 200k-to-16k switch, its next request
still contained approximately 282k characters of pre-switch conversation.

The handoff now appends a bounded custom entry to the current branch and uses
Pi's native `context` event to replace preceding conversation with the rendered
artifact. Pi restores its system prompt and tools after this hook. The complete
transcript remains available on disk. Each callback reads its fresh context and
current branch; no session context survives reload or replacement in a closure.
There is no `newSession` call: model selection receives an `ExtensionContext`,
which does not expose that command-only API.

Projection uses Pi's own prefix projection to identify earlier messages,
including compaction summaries, and a counted fingerprint map to retain repeated
successor messages. A later native compaction supersedes the handoff. Pi's stale
pre-switch assistant usage can trigger threshold compaction before projection;
that threshold is cancelled only until the first successor assistant response.
Manual and overflow compaction remain native, as does selective compaction when
no handoff can be built.

`test/integration/session-handoff-request.test.ts` exercises the real SDK and
OpenAI-compatible HTTP transport against a loopback server. It seeds oversized
history and a 70k-token prior assistant response, leaves automatic compaction
enabled, switches to a 16k model, and verifies the actual serialized request
including Pi's system prompt, a real read-tool schema, the latest task, and the
new user prompt. The fixture enforces a deterministic payload estimate plus
output reserve; it is not an external model tokenizer. The request excludes old
history, completes successfully, and continues after SDK reload with zero native
compactions. Unit tests also cover branch isolation, repeated successor messages,
prior summaries, and later compaction.

For an actual LLM proof, provision an isolated temporary agent directory with
models.json/auth.json and run:

```sh
node --import ./test/support/isolatedState.ts scripts/evidence/c1-request-handoff-evidence.ts <ephemeral-agentDir> <provider> <big-model-id> <small-model-id> [small-provider]
```

The optional successor provider defaults to the first provider. The request uses
a 64-token output ceiling, thinking disabled, and a 60-second abort deadline.

This creates temporary project/session state, checks the serialized provider
payload and actual successful response, prints only bounded evidence, and removes
its project directory. The supplied directory must be an ephemeral proof profile.
The script does not establish that proof until it has actually run successfully.
