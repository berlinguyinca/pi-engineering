import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets as redactPlatform } from "../../src/platform/redact.ts";
import { redactSecrets as redactSecurityPolicy } from "../../src/security/SecurityPolicy.ts";

/**
 * Regression gap matrix between the two redaction implementations.
 *
 * Both entry points must implement the same default redaction policy:
 *   * `src/platform/redact.ts`            → `redactSecrets(text)`
 *   * `src/security/SecurityPolicy.ts`    → `redactSecrets(text, patterns?)`
 *
 * Every case is a required regression. New gaps must fail CI rather than
 * silently becoming TODOs based on the current implementation output.
 *
 * ── Strictness ─────────────────────────────────────────────────────────────
 * A case is only counted as redacted when NONE of its `leakFragments` appear in
 * the output. Every case carries at least two fragments: one from the body /
 * middle of the secret and one from its last 8+ characters. This catches
 * partial redaction (e.g. a JWT whose signature tail survives as
 * `[REDACTED].<signature>`).
 *
 * `context` lists non-secret substrings that MUST survive redaction (key names,
 * URL hosts, header labels, …). When a module redacts a case, every context
 * substring must still be present.
 *
 * Secret fixtures are built at runtime by concatenation/templating so the file
 * contains no literal secret-shaped token (GitHub push protection GH013).
 */

const b64 = (s: string): string => Buffer.from(s).toString("base64url");

// ── Runtime-built secret fixtures (no literal secret-shaped tokens) ─────────
const skLive = `sk-${"live-"}${"x".repeat(40)}`;
const ghp = `ghp_${"A".repeat(36)}`;
const awsKey = `AKIA${"I".repeat(16)}`;
const jwt = [b64('{"alg":"HS256"}'), b64('{"sub":"u"}'), `sig${"a".repeat(40)}`].join(".");
const slack = ["xoxb", "1234567890", "ABCDEFGHIJ", "abcdefghijklmnopqrstuvwx"].join("-");
const googleKey = `AIza${"Sy"}${"B".repeat(33)}`;
const hex40 = "abcdef0123456789abcdef0123456789abcdef01";

// ── Non-secret control string with look-alike non-secret tokens ─────────────
const CONTROL =
  "commit 0123456789abcdef0123456789abcdef01234567 " +
  "uuid 550e8400-e29b-41d4-a716-446655440000 " +
  "token abcdef0123456789abcdef0123456789abcdef01 " +
  "the quick brown fox jumps over the lazy dog";

interface SecretCase {
  /** Test-name fragment identifying the shape. */
  name: string;
  /** A fixed string that must be redacted. */
  secret: string;
  /** Distinctive substrings of the secret that must never survive redaction. */
  leakFragments: string[];
  /** Non-secret substrings that MUST survive redaction when the case is redacted. */
  context: string[];
}

const CASES: SecretCase[] = [
  {
    name: "openai-sk",
    secret: skLive,
    leakFragments: ["live-", "xxxxxxxx"],
    context: [],
  },
  {
    name: "github-ghp",
    secret: ghp,
    leakFragments: ["AAAA", "AAAAA"],
    context: [],
  },
  {
    name: "aws-access-key",
    secret: awsKey,
    leakFragments: ["AKIA", "IIII"],
    context: [],
  },
  {
    name: "bearer-header",
    secret: `Authorization: Bearer ${jwt}`,
    leakFragments: [jwt.slice(0, 20), jwt.slice(-8)],
    context: ["Authorization:"],
  },
  {
    name: "basic-auth-url",
    secret: "https://user:supersecretpassword@example.com/resource",
    leakFragments: ["supersecret", "password"],
    context: ["example.com", "https://"],
  },
  {
    name: "env-api-key",
    secret: `API_KEY=${skLive}`,
    leakFragments: ["live-", "xxxxxxxx"],
    context: ["API_KEY="],
  },
  {
    name: "json-apikey",
    secret: `{"service": "x", "apiKey": "${skLive}"}`,
    leakFragments: ["live-", "xxxxxxxx"],
    context: ["apiKey", "service"],
  },
  {
    name: "ssh-private-key",
    secret: `-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\n-----END OPENSSH PRIVATE KEY-----`,
    leakFragments: ["BEGIN OPENSSH", "MIIEpAIB", "END OPENSSH"],
    context: [],
  },
  {
    name: "slack-xoxb",
    secret: slack,
    leakFragments: ["1234567890", "stuvwx"],
    context: [],
  },
  {
    name: "jwt",
    secret: jwt,
    leakFragments: [jwt.slice(0, 30), jwt.slice(-8)],
    context: [],
  },
  {
    name: "google-api-key",
    secret: googleKey,
    leakFragments: ["AIzaSy", "BBBB"],
    context: [],
  },
  {
    name: "plain-40hex-token",
    secret: `token=${hex40}`,
    leakFragments: ["abcdef01", "89abcdef"],
    context: ["token="],
  },
];

const MODULES: Array<{ name: string; redact: (text: string) => string }> = [
  { name: "platform/redact.ts", redact: redactPlatform },
  { name: "SecurityPolicy.ts", redact: redactSecurityPolicy },
];

/** True when `c` is fully redacted by `redact` (no leak fragment survives). */
function leaked(redact: (text: string) => string, c: SecretCase): string | null {
  const out = redact(c.secret);
  for (const f of c.leakFragments) {
    if (out.includes(f)) return f;
  }
  return null;
}

/** True when every context substring survives redaction. */
function contextSurvives(redact: (text: string) => string, c: SecretCase): boolean {
  const out = redact(c.secret);
  return c.context.every((x) => out.includes(x));
}

/** A case is redacted only when no leak fragment survives AND context survives. */
function isRedacted(redact: (text: string) => string, c: SecretCase): boolean {
  return leaked(redact, c) === null && contextSurvives(redact, c);
}

// ── Non-secret control string must survive untouched in both modules ─────────
test("redact-regression: both modules leave a non-secret control string unchanged (over-redaction check)", () => {
  assert.equal(redactPlatform(CONTROL), CONTROL);
  assert.equal(redactSecurityPolicy(CONTROL), CONTROL);
});

// Every matrix entry is mandatory, including any newly added cases.
for (const c of CASES) {
  for (const m of MODULES) {
    const leak = leaked(m.redact, c);
    test(`redact-regression[${m.name}] redacts ${c.name}`, () => {
      if (leak) {
        assert.ok(false, `${m.name} leaked leakFragment ${JSON.stringify(leak)} for ${c.name}`);
      }
      assert.ok(contextSurvives(m.redact, c), `${m.name} lost required context for ${c.name}`);
    });
  }
}

// ── Final non-todo summary: every miss must equal the explicit expectation. ──
const EXPECTED_GAPS: Array<[string, string]> = [];

test("redact-regression: redaction gap summary matches EXPECTED_GAPS", () => {
  const misses: Array<{ module: string; case: string; reason: string }> = [];
  for (const c of CASES) {
    for (const m of MODULES) {
      if (!isRedacted(m.redact, c)) {
        const leak = leaked(m.redact, c);
        const ctxLost = !contextSurvives(m.redact, c);
        const reason = leak ? `leaked ${JSON.stringify(leak)}` : ctxLost ? "lost context" : "unknown";
        misses.push({ module: m.name, case: c.name, reason });
      }
    }
  }

  console.log("redaction gap summary (module, case):");
  for (const miss of misses) console.log(`  - ${miss.module} :: ${miss.case} :: ${miss.reason}`);

  const actual: Array<[string, string]> = misses.map((m) => [m.module, m.case]);
  assert.deepEqual(actual, EXPECTED_GAPS);
});

for (const m of MODULES) {
  test(`redact-regression[${m.name}] preserves punctuation and adjacent fields`, () => {
    const input = `before token=${hex40}, status=ok; after`;
    assert.equal(m.redact(input), "before token=[REDACTED], status=ok; after");
    const json = `{"apiKey":"${hex40}","service":"ordinary"}`;
    assert.equal(m.redact(json), '{"apiKey":"[REDACTED]","service":"ordinary"}');
    assert.doesNotThrow(() => JSON.parse(m.redact(json)));
    assert.equal(
      m.redact('{"key":"sensitive-value","OPENAI_KEY":"other-value"}'),
      '{"key":"[REDACTED]","OPENAI_KEY":"[REDACTED]"}',
    );
  });

  test(`redact-regression[${m.name}] consumes punctuation inside unquoted secrets`, () => {
    for (const input of [
      "password=alpha{bravo}charlie",
      "password=alpha,bravo",
      "password=alpha;bravo",
      "password=alpha[bravo]charlie",
      'password=alpha"bravo"charlie',
    ])
      assert.equal(m.redact(input), "password=[REDACTED]");
    assert.equal(m.redact("password=alpha,bravo; status=ok"), "password=[REDACTED]; status=ok");
    assert.equal(m.redact("password=alpha{bravo}charlie,status=ok"), "password=[REDACTED],status=ok");
  });

  test(`redact-regression[${m.name}] handles case, quotes, multiline and repeated secrets`, () => {
    const input =
      "start\nExPoRt OPENAI_API_KEY='first secret value'\n" +
      'config: {"ApiKey": "escaped\\"secret value", "service": "safe"}\n' +
      "password=second-secret; finish";
    const out = m.redact(input);
    for (const fragment of ["first secret value", "escaped", "secret value", "second-secret"]) {
      assert.ok(!out.includes(fragment), `${m.name} leaked quoted or multiline value`);
    }
    for (const context of ["start\nExPoRt OPENAI_API_KEY=", '"service": "safe"', "; finish"]) {
      assert.ok(out.includes(context), `${m.name} lost surrounding context`);
    }
    assert.equal(m.redact(out), out, "redaction must be idempotent");
    assert.equal(m.redact("Authorization: bEaReR short123, next=ok"), "Authorization: bEaReR [REDACTED], next=ok");
  });

  test(`redact-regression[${m.name}] handles provider token boundaries and opaque authorization`, () => {
    for (const token of [`sk-${"proj-"}${"ab_CD".repeat(8)}`, `AIza${"x".repeat(34)}-`]) {
      assert.equal(m.redact(`before (${token}), after`), "before ([REDACTED]), after");
    }
    assert.equal(m.redact("Authorization=opaque-credential; done"), "Authorization=[REDACTED]; done");
    assert.equal(m.redact("Authorization: Basic dXNlcjpwYXNz; done"), "Authorization: Basic [REDACTED]; done");
    assert.equal(
      m.redact(`{
  "apiKey":
  "${hex40}",
  "service": "safe"
}`),
      '{\n  "apiKey":\n  "[REDACTED]",\n  "service": "safe"\n}',
    );
  });

  test(`redact-regression[${m.name}] preserves ordinary lookalikes and empty lines`, () => {
    for (const text of [
      CONTROL,
      '{"monkey":"banana","keyboard":"qwerty","tokenCount":42}',
      "passwordLength=12; tokenizer=fast; secretariat=meeting",
      "monkey=banana; keyboard=qwerty; donkey=ordinary",
      "token=\nordinary prose follows",
      "Bearer\nordinary prose follows",
      `commit=${hex40}`,
      `token ${hex40}`,
      "https://example.com/resource",
    ])
      assert.equal(m.redact(text), text);
  });
}

/**
 * `patterns` ADDS caller-specific shapes; it cannot replace the canonical table.
 * The old contract (`patterns === undefined` → default, otherwise patterns only)
 * meant a caller passing a short list silently narrowed coverage — the same drift
 * class this consolidation exists to prevent. No caller in this repository passes
 * one; the contract is pinned here so it cannot quietly revert.
 */
test("redact-regression: SecurityPolicy adds explicit custom patterns to the canonical table", () => {
  assert.equal(
    redactSecurityPolicy("custom value; password=hunter2", [{ kind: "generic", re: /custom value/g }]),
    "[REDACTED]; password=[REDACTED]",
    "the caller's shape AND the canonical shape are both redacted",
  );
  assert.equal(redactSecurityPolicy("ordinary text", []), "ordinary text");
  // An empty list is not an opt-out: the canonical table still runs.
  assert.equal(
    redactSecurityPolicy("password=hunter2", []),
    "password=[REDACTED]",
    "passing [] cannot disable canonical redaction",
  );
});
