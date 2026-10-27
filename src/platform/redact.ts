/**
 * Secret redaction for anything that leaves the process.
 *
 * Lifted out of `memoryOutbox.ts` because it was applied in exactly one place
 * — the outbox — while run goals, worker roles and event payloads reached the
 * store and the control-plane response untouched.
 *
 * ── Why the original pattern set missed almost everything ───────────────────
 *
 * It matched `\b(api[_-]?key|secret|password|token|...)\s*[:=]\s*\S+`. Two
 * flaws, each fatal on its own:
 *
 *   * `_` is a word character, so `\b` cannot match inside `OPENAI_API_KEY` —
 *     the single most common shape there is. `GITHUB_TOKEN=`, `PGPASSWORD=`
 *     and every other screaming-snake environment variable passed straight
 *     through.
 *   * `[:=]` cannot cross a closing quote, so the JSON form
 *     `{"api_key": "sk-live-…"}` never matched either.
 *
 * A fresh-context review demonstrated nine realistic shapes leaking against
 * three redacted. The rules below are therefore in two families: KEY-shaped
 * (a name that means "secret", followed by a value in any common syntax) and
 * VALUE-shaped (tokens recognisable on their own, which need no key at all).
 *
 * Redaction is best-effort by nature — it cannot know that `x = "hunter2"` is
 * a password. It is a safety net under a system that should not be carrying
 * secrets in free text, not a guarantee that it never does.
 */

const PLACEHOLDER = "[REDACTED]";

/** What a rule recognises, for callers that report *why* text was sanitized. */
export type SecretKind = "api_key" | "bearer" | "aws" | "private_key" | "generic";

/**
 * The one canonical redaction table. Every redactor in the runtime reads this
 * list — `src/security/SecurityPolicy.ts` delegates here rather than keeping a
 * second pattern set, because a hand-maintained duplicate drifts silently: the
 * gap matrix in `test/unit/security-redaction-regression.test.ts` recorded ten
 * shapes one implementation caught and the other leaked.
 */
export const SECRET_RULES: Array<{ kind: SecretKind; pattern: RegExp; replacement: string }> = [
  // ── Value-shaped: recognisable without any key ───────────────────────────
  // A PEM private key block, header to footer, however long.
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: PLACEHOLDER,
  },
  // Credentials inside a URL: scheme://user:secret@host
  {
    kind: "generic",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi,
    replacement: `$1${PLACEHOLDER}@`,
  },
  // Provider-issued tokens with distinctive prefixes.
  { kind: "api_key", pattern: /\b(gh[pousr]_[A-Za-z0-9]{16,})/g, replacement: PLACEHOLDER },
  // `sk-` keys carry hyphenated tiers (`sk-live-`, `sk-proj-`), so the class
  // must include the hyphen; `[A-Za-z0-9]{16,}` alone leaks `sk-live-…`.
  { kind: "api_key", pattern: /\bsk-[A-Za-z0-9-]{12,}/g, replacement: PLACEHOLDER },
  { kind: "api_key", pattern: /\bAIza[0-9A-Za-z_-]{32,}/g, replacement: PLACEHOLDER },
  { kind: "api_key", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: PLACEHOLDER },
  { kind: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: PLACEHOLDER },
  // A JWT: three base64url segments separated by dots.
  {
    kind: "generic",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: PLACEHOLDER,
  },

  // ── Key-shaped: a name meaning "secret", then a value ────────────────────
  // Bearer auth first, so its token is consumed before the generic rules run.
  { kind: "bearer", pattern: /\b(Bearer\s+)\S+/gi, replacement: `$1${PLACEHOLDER}` },
  // An auth header carries a scheme before the credential:
  //   Authorization: Basic dXNlcjpwYXNzd29yZA==
  // The generic key rules below consume one whitespace-delimited token, which
  // here is the word "Basic" — that would leave the credential standing on its
  // own, unattached to any keyword, and no later rule could find it. So the
  // whole header value is consumed here, scheme included.
  {
    kind: "bearer",
    pattern:
      /\b(proxy-authorization|authorization)(\s*[:=]\s*)(?:Basic|Bearer|Token|Digest|NTLM|Negotiate|AWS4-HMAC-SHA256)[^\n"']*/gi,
    replacement: `$1$2${PLACEHOLDER}`,
  },
  // JSON / YAML: "api_key": "value"  — quoted key, quoted value.
  {
    kind: "generic",
    pattern: /("[A-Za-z0-9_.-]*(?:key|secret|password|passwd|token|credential)"\s*:\s*)"[^"]*"/gi,
    replacement: `$1"${PLACEHOLDER}"`,
  },
  // Bare key = value / key: value, with NO \b before the name, so an
  // underscore-prefixed environment variable is still matched.
  // The separator is CAPTURED and replayed, so `token: x` stays `token: ` and
  // `TOKEN=x` stays `TOKEN=`. Rewriting it would make redacted text differ
  // from its original in a way that has nothing to do with the secret.
  {
    kind: "generic",
    pattern:
      /([A-Za-z0-9_.-]*(?:api[_-]?key|secret|password|passwd|token|credential|authorization))(\s*[:=]\s*)"[^"]*"/gi,
    replacement: `$1$2"${PLACEHOLDER}"`,
  },
  {
    kind: "generic",
    pattern: /([A-Za-z0-9_.-]*(?:api[_-]?key|secret|password|passwd|token|credential|authorization))(\s*[:=]\s*)\S+/gi,
    replacement: `$1$2${PLACEHOLDER}`,
  },
];

/** Redact secrets from free text. Never throws; returns the input on failure. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  try {
    let out = text;
    for (const { pattern, replacement } of SECRET_RULES) out = out.replace(pattern, replacement);
    return out;
  } catch {
    return text;
  }
}

/**
 * Redact every string inside a structure, in place of its values.
 *
 * Used on event payloads, which are `Record<string, unknown>` holding whatever
 * a caller supplied. Depth- and size-bounded: a payload is data from the
 * network, and walking it must not become the denial of service it protects
 * against.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(entry, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
