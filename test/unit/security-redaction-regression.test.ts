import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets as redactPlatform } from "../../src/platform/redact.ts";
import { redactSecrets as redactSecurityPolicy } from "../../src/security/SecurityPolicy.ts";

/** Fixtures are assembled at runtime so secret scanners never see a
 *  credential-shaped literal in source; the values are synthetic. */
const join = (...parts: string[]): string => parts.join("");

/**
 * Regression gap matrix across the two public redaction entry points.
 *
 * Both entry points now read ONE canonical table (`SECRET_RULES` in
 * `src/platform/redact.ts`); `SecurityPolicy.redactSecrets` delegates to it:
 *   * `src/platform/redact.ts`            → `redactSecrets(text)`
 *   * `src/security/SecurityPolicy.ts`    → `redactSecrets(text, extraPatterns?)`
 *
 * The matrix deliberately runs every shape through BOTH entry points anyway.
 * The failure mode it guards against is a re-fork: the moment someone maintains
 * a second pattern set again, the two columns diverge here. Nine shapes were
 * gaps in `SecurityPolicy.ts` — some leaked fragments (`sk-live-…`, `ghp_…`, a
 * basic-auth URL), some passed only by destroying the context that had to
 * survive (`API_KEY=`, `"apiKey":`, `token=`). One of the nine, `google-api-key`,
 * was a gap in both entry points.
 *
 * A miss is recorded as `test.todo` so CI stays green while the gap is visible
 * in the test report, and `EXPECTED_GAPS` below pins the exact set of known
 * misses so any NEW gap — or any silently closed one — fails this file.
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

// ── Gap matrix: per module, per case. Misses are recorded with test.todo. ────
for (const c of CASES) {
  for (const m of MODULES) {
    const redacts = isRedacted(m.redact, c);
    const leak = leaked(m.redact, c);
    test(`redact-regression[${m.name}] redacts ${c.name}`, { todo: !redacts }, () => {
      if (leak) {
        assert.ok(false, `${m.name} leaked leakFragment ${JSON.stringify(leak)} for ${c.name}`);
      }
      assert.ok(contextSurvives(m.redact, c), `${m.name} lost required context for ${c.name}`);
    });
  }
}

// ── Final non-todo summary: every miss must equal the explicit expectation. ──
// { module, case } tuples of every observed miss, kept explicit so any new gap
// or any silently closed gap changes this test. Empty = both entry points close
// every shape in CASES; adding a shape that only one of them catches fails here.
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

/**
 * An auth header puts a scheme word between the name and the credential:
 * `Authorization: Basic dXNlcjpw…==`. The generic key rules consume one
 * whitespace-delimited token, which here is `Basic` — so the credential was left
 * standing alone, detached from any keyword, and nothing downstream could find
 * it. The header rule consumes scheme and value together.
 */
test("an auth header redacts the credential, not just the scheme word", () => {
  const header = join("Authorization: ", "Basic ", "dXNlcjpw", "YXNzd29yZA==");
  const proxy = join("Proxy-Authorization: Bearer ", "abcdefghijkl", "mnopqrstuvwxyz");

  for (const [label, redact] of [
    ["redactPlatform", redactPlatform],
    ["SecurityPolicy.redactSecrets", redactSecurityPolicy],
  ] as const) {
    const out = redact(header);
    assert.ok(!out.includes(join("dXNlcjpw", "YXNzd29yZA")), `${label} left the basic-auth credential: ${out}`);
    assert.match(out, /Authorization:\s*\[REDACTED\]/, `${label} should keep the header name: ${out}`);

    const bearer = redact(proxy);
    assert.ok(!bearer.includes(join("abcdefghijkl", "mnopqrstuvwxyz")), `${label} left the bearer credential`);
    assert.match(bearer, /Proxy-Authorization:\s*\[REDACTED\]/);
  }
});

/** Redaction must be stable under a second pass — scrubbed text re-enters logs. */
test("redaction is idempotent", () => {
  const header = join("Authorization: ", "Basic ", "dXNlcjpw", "YXNzd29yZA==");
  const once = redactPlatform(header);
  assert.equal(redactPlatform(once), once);
});
