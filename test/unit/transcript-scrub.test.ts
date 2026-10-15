import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubTranscript } from "../../src/workers/transcriptStore.ts";

// Fixtures are assembled at runtime so secret scanners never see a
// credential-shaped literal in source; the values are synthetic.
const join = (...parts: string[]): string => parts.join("");

const cases: Array<[string, unknown, string]> = [
  ["json password value", '{"password":"hunter2x"}', "hunter2x"],
  ["escaped json password", '{\\"password\\":\\"hunter2x\\"}', "hunter2x"],
  ["basic auth header", join("Authorization: Basic ", "dXNlcjpw", "YXNzd29yZA=="), "dXNlcjpwYXNzd29yZA"],
  ["url query key", "GET https://api.example.com/v1?key=AbCdEf123456&q=1", "AbCdEf123456"],
  ["url userinfo", join("postgres://admin:", "s3cretpw", "@db.example.com/app"), "s3cretpw"],
  ["prose password", "my password is correcthorse", "correcthorse"],
  ["short api key", 'api_key: "abc"', '"abc"'],
  ["github token", join("token ghp_", "abcdefghijklmnop", "qrstuvwxyz0123456789"), join("ghp_", "abcdefghijklmnop")],
  ["github pat", join("github_pat_", "11ABCDEFG0", "abcdefghijklmnop_xyz"), join("github_pat_", "11ABC")],
  ["slack token", join("xoxb-", "1234567890", "-abcdefghij"), join("xoxb-", "1234567890")],
  ["sk key", join("sk-proj-", "abcdefghijklmnop1234"), join("sk-proj-", "abcdef")],
  ["aws key", join("AKIA", "ABCDEFGH", "IJKLMNOP"), join("AKIA", "ABCDEFGH", "IJKLMNOP")],
  ["env dump", "HOME=/root\nDB_PASSWORD=pw12345\nAWS_SECRET_ACCESS_KEY=zzzzzzzz\nPATH=/bin", "pw12345"],
  ["env dump secret", "AWS_SECRET_ACCESS_KEY=zzzzzzzz", "zzzzzzzz"],
  ["cookie header", "Cookie: session=abcdef123456", "abcdef123456"],
  [
    "pem",
    join("-----BEGIN ", "PRIVATE KEY-----\n", "MIIEvQIBADANBg", "\n-----END ", "PRIVATE KEY-----"),
    "MIIEvQIBADANBg",
  ],
  ["object key", { password: "hunter2x", nested: { apiKey: "k1" } }, "hunter2x"],
  ["object nested key", { nested: { apiKey: "k1value" } }, "k1value"],
  ["bare _KEY env", "OPENAI_KEY=abc123xyz", "abc123xyz"],
  ["password space value", "mysql --password hunter2x -h db", "hunter2x"],
  ["password word value", "password hunter2x", "hunter2x"],
  ["curl -u", "curl -u admin:pw12345 https://x.example.com", "pw12345"],
  ["array leaf", [join("Bearer ", "abcdefghijklm", "nopqrstuvwxyz123456")], "abcdefghijklmnopqrstuvwxyz"],
];

for (const [name, input, secret] of cases) {
  test(`scrub: ${name}`, () => {
    const out = JSON.stringify(scrubTranscript(input, 4000));
    assert.ok(!out.includes(secret), out);
    assert.match(out, /REDACTED/);
  });
}

test("scrub: ordinary text is preserved", () => {
  assert.equal(scrubTranscript("read the key file at src/key.ts", 4000), "read the key file at src/key.ts");
});

test("scrub: token counts survive", () => {
  const out = scrubTranscript({ usage: { input: 5, output: 7, totalTokens: 12 }, tokens: 12, max_tokens: 99 }, 4000);
  assert.deepEqual(out, { usage: { input: 5, output: 7, totalTokens: 12 }, tokens: 12, max_tokens: 99 });
});
