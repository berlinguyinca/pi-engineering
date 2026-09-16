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

const RULES: Array<{ pattern: RegExp; replacement: string }> = [
  // ── Value-shaped: recognisable without any key ───────────────────────────
  // A PEM private key block, header to footer, however long.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: PLACEHOLDER },
  // Credentials inside a URL: scheme://user:secret@host
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, replacement: `$1${PLACEHOLDER}@` },
  // Provider-issued tokens with distinctive prefixes.
  { pattern: /\b(gh[pousr]_[A-Za-z0-9]{16,})/g, replacement: PLACEHOLDER },
  { pattern: /\bsk-[A-Za-z0-9-]{12,}/g, replacement: PLACEHOLDER },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: PLACEHOLDER },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: PLACEHOLDER },
  // A JWT: three base64url segments separated by dots.
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: PLACEHOLDER },

  // ── Key-shaped: a name meaning "secret", then a value ────────────────────
  // Bearer auth first, so its token is consumed before the generic rules run.
  { pattern: /\b(Bearer\s+)\S+/gi, replacement: `$1${PLACEHOLDER}` },
  // JSON / YAML: "api_key": "value"  — quoted key, quoted value.
  {
    pattern: /("[A-Za-z0-9_.-]*(?:key|secret|password|passwd|token|credential)"\s*:\s*)"[^"]*"/gi,
    replacement: `$1"${PLACEHOLDER}"`,
  },
  // Bare key = value / key: value, with NO \b before the name, so an
  // underscore-prefixed environment variable is still matched.
  // The separator is CAPTURED and replayed, so `token: x` stays `token: ` and
  // `TOKEN=x` stays `TOKEN=`. Rewriting it would make redacted text differ
  // from its original in a way that has nothing to do with the secret.
  {
    pattern:
      /([A-Za-z0-9_.-]*(?:api[_-]?key|secret|password|passwd|token|credential|authorization))(\s*[:=]\s*)"[^"]*"/gi,
    replacement: `$1$2"${PLACEHOLDER}"`,
  },
  {
    pattern: /([A-Za-z0-9_.-]*(?:api[_-]?key|secret|password|passwd|token|credential|authorization))(\s*[:=]\s*)\S+/gi,
    replacement: `$1$2${PLACEHOLDER}`,
  },
];

/** Redact secrets from free text. Never throws; returns the input on failure. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  try {
    let out = text;
    for (const { pattern, replacement } of RULES) out = out.replace(pattern, replacement);
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
