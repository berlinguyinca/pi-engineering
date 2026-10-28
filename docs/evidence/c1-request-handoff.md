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

Native compaction bypasses request-time context hooks. All engineering
compaction consumers therefore prepare from a synthetic native compaction at the
real handoff marker ID, followed only by successor entries. With a short suffix,
a canonical native compaction commits the handoff summary at that marker; under
successor pressure, Pi summarizes the successor prefix and retains a native cut
from the successor suffix. This covers manual, threshold, overflow, and the
auto-tuner's turn boundary. Earlier and later before-compaction hooks share a
single event result. A failed handoff summary cancels visibly rather than
falling back to the raw hidden branch.

`test/integration/session-handoff-request.test.ts` exercises the real SDK and
OpenAI-compatible HTTP transport against a loopback server. It seeds oversized
history and a 70k-token prior assistant response, leaves automatic compaction
enabled, switches to a 16k model, and verifies the actual serialized request
including Pi's system prompt, a real read-tool schema, the latest task, and the
new user prompt. The fixture enforces a deterministic payload estimate plus
output reserve; it is not an external model tokenizer. The request excludes old
history, completes successfully, and continues after SDK reload with zero native
compactions during the initial handoff in the standalone configuration. Six
HTTP scenarios cover later manual, threshold, and overflow compaction both
standalone and with the complete production extension loaded, including larger
successor history requiring a real summary request. Every captured summary,
retry, and follow-up excludes old history. Unit tests also cover branch isolation, repeated successor messages,
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

## Actual bounded provider proof — 2026-10-27

The request evidence script ran against the configured provider using an isolated
copy of model/auth configuration (private temporary files, subsequently removed).
The selected predecessor had a 262,144-token configured window; the actual
successor `qwen3.8-flash_next-modality-text-quant-w3a8` advertises 131,072 tokens.
A synthetic 163,863-token conversation was transferred before the request. The
complete serialized request was 3,415 characters, made one actual provider call,
returned `HANDOFF_OK`, and recorded zero compaction entries during the switch.
Output was capped at 64 tokens with thinking off. No live user transcript,
credentials, settings, or session was changed.

Later native/tuned manual, threshold, and overflow compaction are additionally
covered by six actual-SDK/loopback HTTP cases, including the full extension entry.
This combines a real provider round trip with deterministic lifecycle boundaries;
it does not claim every provider/model combination has been exercised.


## Merge review follow-ups

Independent review reproduced two additional boundaries: a native context edit
appended after a handoff could replace a hidden earlier message, and a bare
continuation prompt could displace the substantive objective. The projection now
selects hidden messages by source-entry provenance from Pi's complete current
projection, including edits. The artifact builder reuses the existing continuation
classifier to retain the most recent substantive user request. Both regressions
failed before the repairs and pass afterward.

This PR repairs interactive model-switch transfer already present in main. It does
not complete the original B1 phase-boundary migration: that path remains opt-in,
and the recorded live provider evidence above exercises model selection rather
than a full mission phase boundary and fresh worker session. That separate
migration proof remains outstanding; no phase-handoff or Herdr default is enabled
by this repair.
