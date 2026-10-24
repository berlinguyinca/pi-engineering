import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_ISSUE_NUMBER,
  canonicalId,
  extractGithubRefs,
  parseCanonicalId,
  parseGithubRef,
  withKind,
} from "../../src/github/refs.ts";

const cfg = { defaultRepo: "Acme/Widgets" };

function ok(input: string, c = cfg) {
  const r = parseGithubRef(input, c);
  assert.equal(r.ok, true, `${input}: ${r.ok ? "" : r.reason}`);
  return (r as Extract<typeof r, { ok: true }>).ref;
}
function bad(input: string, c: Parameters<typeof parseGithubRef>[1] = cfg) {
  const r = parseGithubRef(input, c);
  assert.equal(r.ok, false, `${JSON.stringify(input)} should be rejected`);
}

describe("github refs: parsing", () => {
  it("parses every realistic form to one repo-qualified identity", () => {
    const forms = [
      "#12",
      "acme/widgets#12",
      "Acme/Widgets#12",
      "github.com/acme/widgets#12",
      "https://github.com/acme/widgets/issues/12",
      "https://GitHub.com/Acme/Widgets/issues/12/",
      "https://github.com/acme/widgets/issues/12#issuecomment-99",
      "https://github.com/acme/widgets/issues/12?foo=bar",
    ];
    for (const f of forms) {
      const ref = ok(f);
      assert.deepEqual(
        { h: ref.host, o: ref.owner, r: ref.repo, n: ref.number },
        { h: "github.com", o: "acme", r: "widgets", n: 12 },
        f,
      );
    }
  });

  it("matches the lineage contract id exactly, and URL forms decide the kind", () => {
    assert.equal(canonicalId(ok("https://github.com/acme/widgets/issues/12")), "issue:github.com/acme/widgets#12");
    assert.equal(canonicalId(ok("https://github.com/acme/widgets/pull/7")), "pr:github.com/acme/widgets#7");
    assert.equal(ok("https://github.com/acme/widgets/pull/7").kind, "pr");
  });

  it("never defaults an ambiguous text ref to issue", () => {
    const ref = ok("acme/widgets#12");
    assert.equal(ref.kind, "unknown");
    assert.equal(canonicalId(ref), undefined);
    assert.equal(canonicalId(withKind(ref, "pr") as typeof ref), "pr:github.com/acme/widgets#12");
    assert.equal(
      withKind(ok("https://github.com/acme/widgets/pull/7"), "issue"),
      undefined,
      "conflicting kind refused",
    );
  });

  it("bare #N needs a default repo and is never guessed", () => {
    bad("#12", {});
    assert.equal(ok("#12").repo, "widgets");
  });

  it("rejects trailing junk, ambiguous and unsafe input", () => {
    for (const s of [
      "",
      "   ",
      "#",
      "#12abc",
      "#12 and more",
      "acme/widgets#12junk",
      "acme/widgets#",
      "acme/widgets",
      "acme/widgets#0",
      "acme/widgets#012",
      "acme/widgets#-1",
      "acme/widgets#1.5",
      "acme/widgets#1e3",
      "a/b/c#1",
      "http://github.com/acme/widgets/issues/12",
      "https://github.com/acme/widgets/issues/12/extra",
      "https://github.com/acme/widgets/issues/12abc",
      "https://github.com/acme/widgets/tree/main",
      "https://github.com/acme/widgets/commit/abc",
      "https://user:pw@github.com/acme/widgets/issues/1",
      "https://github.com:8443/acme/widgets/issues/1",
      "https://github.com@evil.example/acme/widgets/issues/1",
      "https://evil.example/acme/widgets/issues/1",
      "https://github.com.evil.example/acme/widgets/issues/1",
      "ftp://github.com/acme/widgets/issues/1",
      "javascript:alert(1)",
      "acme/widgets.git#1",
      "acme/../#1",
      "acme/..#1",
      "-acme/widgets#1",
      "acme-/widgets#1",
      `${"a".repeat(40)}/widgets#1`,
      `acme/${"r".repeat(101)}#1`,
      "acme/widgets#1\n#2",
      "acme/widgets#1\u0000",
      "acme/wid gets#1",
      "acme/widgets#1;rm -rf /",
      "$(id)/x#1",
    ]) {
      bad(s);
    }
  });

  it("rejects unicode lookalikes and invisible characters instead of normalising them", () => {
    for (const s of [
      "acme/widgets＃12", // fullwidth number sign
      "acme/widgets#１２", // fullwidth digits
      "acme/widgets#١٢", // arabic-indic digits
      "аcme/widgets#12", // cyrillic a
      "acme/widgеts#12", // cyrillic e
      `acme/widgets${String.fromCharCode(0x200b)}#12`,
      `${String.fromCharCode(0x202e)}acme/widgets#12`,
      "https://gіthub.com/acme/widgets/issues/12", // cyrillic i
      `https://github.com/acme/widgets/issues/1${String.fromCharCode(0x200b)}2`,
      "ⅩⅡ",
    ]) {
      bad(s);
    }
  });

  it("bounds numbers", () => {
    assert.equal(ok(`acme/widgets#${MAX_ISSUE_NUMBER}`).number, MAX_ISSUE_NUMBER);
    bad(`acme/widgets#${MAX_ISSUE_NUMBER + 1}`);
    bad(`acme/widgets#${"9".repeat(400)}`);
    bad(`${"x".repeat(5000)}#1`);
  });

  it("treats cross-repo refs as distinct identities and normalises case", () => {
    assert.notEqual(
      canonicalId({ ...ok("other/repo#1"), kind: "issue" }),
      canonicalId({ ...ok("acme/widgets#1"), kind: "issue" }),
    );
    assert.equal(ok("ACME/WIDGETS#1").owner, "acme");
  });

  it("only accepts configured hosts, including GHES", () => {
    const ghes = { hosts: ["github.com", "ghe.corp.example"], defaultRepo: "ghe.corp.example/team/svc" };
    const ref = ok("https://GHE.corp.example/Team/Svc/pull/5", ghes);
    assert.equal(canonicalId(ref), "pr:ghe.corp.example/team/svc#5");
    assert.equal(ok("#3", ghes).host, "ghe.corp.example");
    bad("https://ghe.corp.example/team/svc/pull/5", cfg);
    bad("https://other.example/team/svc/pull/5", ghes);
  });

  it("round-trips canonical ids and rejects malformed ones", () => {
    const id = "issue:github.com/acme/widgets#12";
    const ref = parseCanonicalId(id) as NonNullable<ReturnType<typeof parseCanonicalId>>;
    assert.equal(canonicalId(ref), id);
    for (const s of [
      "issue:acme/widgets#12",
      "task:github.com/acme/widgets#12",
      "issue:github.com/acme/widgets#x",
      "issue:evil.example/a/b#1",
    ]) {
      assert.equal(parseCanonicalId(s), undefined, s);
    }
  });
});

describe("github refs: extraction from free text", () => {
  it("finds refs on token boundaries, in order, deduplicated", () => {
    const refs = extractGithubRefs(
      "Fix #3 and acme/widgets#3 (see https://github.com/acme/widgets/pull/9). Also other/lib#40, #3.",
      cfg,
    );
    assert.deepEqual(
      refs.map((r) => `${r.owner}/${r.repo}#${r.number}:${r.kind}`),
      ["acme/widgets#9:pr", "acme/widgets#3:unknown", "other/lib#40:unknown"],
    );
  });

  it("ignores things that merely look like refs", () => {
    for (const s of [
      "color #123456 and abc#12 and x#12abc",
      "&#123; entity",
      "a/b/c#4",
      "see #12abc",
      "email me@acme/widgets#4",
      "v1.2#3",
      "##5",
      "acme/widgets#９９",
    ]) {
      const found = extractGithubRefs(s, cfg).map((r) => r.number);
      assert.ok(
        !found.includes(12) && !found.includes(4) && !found.includes(3) && !found.includes(5) && !found.includes(99),
        `${s} -> ${found}`,
      );
    }
  });

  it("is bounded on hostile input", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `#${i + 1}`).join(" ");
    assert.ok(extractGithubRefs(many, cfg).length <= 200);
    const started = Date.now();
    extractGithubRefs(`${"a/".repeat(30_000)}#1 ${"#".repeat(30_000)}`, cfg);
    assert.ok(Date.now() - started < 2000, "no catastrophic backtracking");
    assert.deepEqual(extractGithubRefs("", cfg), []);
  });

  it("property: random ASCII never throws and every result serialises or is unknown", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const alphabet = "ab/#-._09 \n:hpst@";
    for (let i = 0; i < 500; i++) {
      let s = "";
      for (let j = rnd() % 40; j > 0; j--) s += alphabet[rnd() % alphabet.length];
      for (const r of extractGithubRefs(s, cfg)) {
        assert.ok(r.number >= 1 && r.number <= MAX_ISSUE_NUMBER);
        assert.ok(r.kind === "unknown" || canonicalId(r)?.includes("#"));
      }
      const single = parseGithubRef(s, cfg);
      if (single.ok) assert.match(`${single.ref.owner}/${single.ref.repo}`, /^[a-z0-9-]+\/[a-z0-9._-]+$/);
    }
  });
});
