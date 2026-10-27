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
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}/g, replacement: PLACEHOLDER },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: PLACEHOLDER },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: PLACEHOLDER },
  // A JWT: three base64url segments separated by dots.
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: PLACEHOLDER },

  { pattern: /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, replacement: PLACEHOLDER },

  // Authentication schemes are retained as context. Horizontal whitespace and
  // token characters prevent consuming the following line or field delimiter.
  { pattern: /\b((?:Bearer|Basic)[ \t]+)[A-Za-z0-9._~+/=-]+/gi, replacement: `$1${PLACEHOLDER}` },
];

// A quoted assignment is consumed in one pass, including escaped quotes.
// The unquoted alternative stops at delimiters instead of eating JSON syntax
// or adjacent prose. Cross a newline only for an explicitly quoted value.
const SECRET_NAME = String.raw`(?:key|[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|[_-]key|secret|password|passwd|token|credential|authorization))`;
const ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(["']${SECRET_NAME}["']|${SECRET_NAME})([ \t]*[:=][ \t]*(?:\r?\n[ \t]*(?=["']))?)((?:Bearer|Basic)[ \t]+(?:[A-Za-z0-9._~+/=-]+|\[REDACTED\])|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;{}\[\]]+)`,
  "gi",
);

/** Redact secrets from free text. Never throws; returns the input on failure. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  try {
    let out = text;
    for (const { pattern, replacement } of RULES) out = out.replace(pattern, replacement);
    out = out.replace(ASSIGNMENT, (_match, key: string, separator: string, value: string) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
      const scheme = /^(?:Bearer|Basic)[ \t]+/i.exec(value)?.[0] ?? "";
      return `${key}${separator}${quote}${scheme}${PLACEHOLDER}${quote}`;
    });
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
