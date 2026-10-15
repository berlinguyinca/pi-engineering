import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubTranscript } from "../../src/workers/transcriptStore.ts";

const cases: Array<[string, unknown, string]> = [
  ["json password value", '{"password":"hunter2x"}', "hunter2x"],
  ["escaped json password", '{\\"password\\":\\"hunter2x\\"}', "hunter2x"],
  ["basic auth header", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
  ["url query key", "GET https://api.example.com/v1?key=AbCdEf123456&q=1", "AbCdEf123456"],
  ["url userinfo", "postgres://admin:s3cretpw@db.example.com/app", "s3cretpw"],
  ["prose password", "my password is correcthorse", "correcthorse"],
  ["short api key", 'api_key: "abc"', '"abc"'],
  ["github token", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnop"],
  ["github pat", "github_pat_11ABCDEFG0abcdefghijklmnop_xyz", "github_pat_11ABC"],
  ["slack token", "xoxb-1234567890-abcdefghij", "xoxb-1234567890"],
  ["sk key", "sk-proj-abcdefghijklmnop1234", "sk-proj-abcdef"],
  ["aws key", "AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
  ["env dump", "HOME=/root\nDB_PASSWORD=pw12345\nAWS_SECRET_ACCESS_KEY=zzzzzzzz\nPATH=/bin", "pw12345"],
  ["env dump secret", "AWS_SECRET_ACCESS_KEY=zzzzzzzz", "zzzzzzzz"],
  ["cookie header", "Cookie: session=abcdef123456", "abcdef123456"],
  ["pem", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----", "MIIEvQIBADANBg"],
  ["object key", { password: "hunter2x", nested: { apiKey: "k1" } }, "hunter2x"],
  ["object nested key", { nested: { apiKey: "k1value" } }, "k1value"],
  ["bare _KEY env", "OPENAI_KEY=abc123xyz", "abc123xyz"],
  ["password space value", "mysql --password hunter2x -h db", "hunter2x"],
  ["password word value", "password hunter2x", "hunter2x"],
  ["curl -u", "curl -u admin:pw12345 https://x.example.com", "pw12345"],
  ["array leaf", ["Bearer abcdefghijklmnopqrstuvwxyz123456"], "abcdefghijklmnopqrstuvwxyz"],
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
