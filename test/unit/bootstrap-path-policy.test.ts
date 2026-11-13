import assert from "node:assert/strict";
import test from "node:test";
import { createPathPolicy } from "../../src/bootstrap/pathPolicy.ts";

const build = (input: Parameters<typeof createPathPolicy>[0]) => {
  const { policy, errors } = createPathPolicy(input);
  assert.deepEqual(errors, []);
  assert.ok(policy);
  return policy;
};

test("allowlist grants exact paths and explicit recursion only", () => {
  const narrow = build({ allowPaths: ["src/bootstrap/taskManifest.ts", "docs/specs/**"] });
  assert.deepEqual(narrow.check("src/bootstrap/taskManifest.ts"), {
    allowed: true,
    path: "src/bootstrap/taskManifest.ts",
    reason: 'matched by "src/bootstrap/taskManifest.ts"',
  });
  assert.equal(narrow.check("docs/specs/harness/x.md").allowed, true);
  assert.equal(
    narrow.check("src/bootstrap").reason,
    "no allow pattern matches",
    "no implicit ** — a directory entry grants nothing extra",
  );
  assert.equal(build({ allowPaths: [] }).check("src/bootstrap/taskManifest.ts").allowed, false);
});

test("explicit deny always wins over allow", () => {
  const guarded = build({ allowPaths: ["**"], denyPaths: ["docs/specs/**", "src/bootstrap/pathPolicy.ts"] });
  assert.equal(guarded.check("src/bootstrap/taskManifest.ts").allowed, true);
  assert.deepEqual(guarded.check("docs/specs/x/y.md"), {
    allowed: false,
    path: "docs/specs/x/y.md",
    reason: 'denied by "docs/specs/**"',
  });
  assert.equal(guarded.check("src/bootstrap/pathPolicy.ts").reason, 'denied by "src/bootstrap/pathPolicy.ts"');
});

test("traversal, ambiguous, absolute and symlink paths are rejected before any grant", () => {
  const checked = build({ allowPaths: ["**"], symlinks: ["link", "nested/link"] });
  const rejected = [
    "../escape",
    "src/../../etc/passwd",
    "./src/x",
    "src/./x",
    "/etc/passwd",
    "C:/x",
    "~/x",
    "src//x",
    "src/x/",
    "",
    "   ",
    " src/x",
    "src/*.ts",
    "src/**",
    "a?b",
    "a\\b",
    "link",
    "nested/link/file.ts",
  ];
  for (const request of rejected) assert.equal(checked.check(request).allowed, false, request);
  assert.match(checked.check("src/**").reason, /glob metacharacters/u);
  assert.match(checked.check("src/../../etc/passwd").reason, /INVALID_WRITE_DOMAIN/u);
  assert.deepEqual(checked.check("link"), { allowed: false, path: "link", reason: 'path traverses symlink "link"' });
  assert.equal(checked.check("nested/solid/file.ts").allowed, true);
  assert.deepEqual(createPathPolicy({ allowPaths: ["../x"], denyPaths: ["/y"] }).errors.length, 2);
});
