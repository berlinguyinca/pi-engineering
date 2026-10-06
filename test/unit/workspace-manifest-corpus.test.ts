/**
 * Adversarial corpus for workspace authority (PR #106 final review).
 *
 * Every prompt is resolved against real git repositories. For each prompt the
 * table states the writable roots and read-only roots (or a refusal), and an
 * invariant checks that no path written in an exclusion position ever becomes
 * writable. A second table holds plain prompts that must stay writable.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WorkspaceManifestResolver, WorkspaceScopeError } from "../../src/orchestration/workspaceManifest.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

type Name = "L" | "T" | "R" | "R2" | "S" | "F" | "Rsrc";
interface Paths {
  L: string;
  T: string;
  R: string;
  R2: string;
  S: string;
  F: string;
  D: string;
  Rsrc: string;
}

interface Row {
  prompt: (p: Paths) => string;
  /** Writable repository roots (exact), or "refuse" for a WorkspaceScopeError. */
  write: Name[] | "refuse";
  /** Read-only roots (exact) when not refused. */
  read?: Name[];
  /** Paths written in an exclusion position: never writable, whatever else happens. */
  excluded?: Name[];
  /** Expected refusal message fragment. */
  message?: RegExp;
}

function typo(path: string): string {
  return `${path.slice(0, -2)}${path.at(-1)}${path.at(-2)}`;
}

const CORPUS: Row[] = [
  // Reviewer's failing prompts.
  {
    prompt: (p) => `Fix ${p.T}. Do NOT, under any circumstances, modify ${p.R}.`,
    write: ["T"],
    read: ["R"],
    excluded: ["R"],
  },
  { prompt: (p) => `Fix ${p.T}. Please do not modify the code in ${p.R}.`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Refactor ${p.R} and ${p.T} but leave ${p.R} alone`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Update ${p.T} and ${p.R} except do not touch ${p.R}`, write: ["T"], read: [], excluded: ["R"] },
  { prompt: (p) => `Fix ${p.R} but do not touch ${p.Rsrc}`, write: "refuse", excluded: ["Rsrc", "R"] },
  { prompt: (p) => `Update ${typo(p.T)}`, write: "refuse", message: /does not exist/ },
  { prompt: (p) => `Fix ${p.T.toUpperCase()}`, write: "refuse", message: /does not exist/ },
  { prompt: () => "Fix ~/pi-eng-repo-that-does-not-exist-7f3a", write: "refuse" },
  { prompt: (p) => `Port the change from ${p.R} into ${p.T}`, write: ["T"], read: ["R"], excluded: ["R"] },
  // Earlier regressions.
  { prompt: (p) => `Do not touch ${p.L}. Build the feature.`, write: "refuse", excluded: ["L"] },
  { prompt: (p) => `Implement the feature in ${typo(p.T)}`, write: "refuse", message: /does not exist/ },
  { prompt: (p) => `Leave ${p.R} alone and fix ${p.T}`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Do not make any changes to ${p.R}; fix ${p.T}`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `${p.R} must stay unchanged. Fix ${p.T}.`, write: ["T"], read: ["R"], excluded: ["R"] },
  {
    prompt: (p) => `Copy the approach of ${p.R}, then implement it in ${p.T}`,
    write: ["T"],
    read: ["R"],
    excluded: ["R"],
  },
  { prompt: (p) => `Analyze ${p.F} and fix the bug`, write: ["L"], read: ["F"] },
  { prompt: () => "fix /etc/nginx", write: "refuse", message: /protected/ },
  { prompt: () => "Modify files in /etc", write: "refuse", message: /protected/ },
  {
    prompt: (p) => `Use ${p.R} as read-only reference and implement the feature in ${p.T}`,
    write: ["T"],
    read: ["R"],
    excluded: ["R"],
  },
  { prompt: (p) => `Do not stop until ${p.T} passes its tests`, write: ["T"] },
  { prompt: (p) => `Don't just read ${p.T}, fix the bug there`, write: ["T"] },
  { prompt: (p) => `Never leave ${p.T} broken: fix the failing build`, write: ["T"] },
  // Exclusion paraphrases, word orders, emphasis.
  { prompt: (p) => `DO NOT MODIFY ${p.R}. FIX ${p.T}.`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Never modify ${p.R}; implement the feature in ${p.T}`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Implement the feature in ${p.T} without touching ${p.R}`, write: ["T"], read: [], excluded: ["R"] },
  {
    prompt: (p) => `Implement the feature in ${p.T}, but ${p.R} is read-only`,
    write: ["T"],
    read: ["R"],
    excluded: ["R"],
  },
  { prompt: (p) => `Implement the feature in ${p.T} but not in ${p.R}`, write: ["T"], read: ["R"], excluded: ["R"] },
  {
    prompt: (p) => `Update every repo: ${p.T}, ${p.R2} except ${p.R}`,
    write: ["T", "R2"],
    read: ["R"],
    excluded: ["R"],
  },
  { prompt: (p) => `Fix ${p.T} and keep ${p.R} unchanged`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Fix ${p.T}; ${p.R} is off-limits`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Fix ${p.T}. ${p.R} should not be modified.`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Fix ${p.T}. ${p.R} is for reference only.`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Use ${p.R} for context and fix the bug in ${p.T}`, write: ["T"], read: ["R"], excluded: ["R"] },
  {
    prompt: (p) => `Fix ${p.T}. Under no circumstances should ${p.R} be modified.`,
    write: ["T"],
    read: ["R"],
    excluded: ["R"],
  },
  {
    prompt: (p) => `Fix ${p.T} \u2014 but whatever you do, never touch ${p.R}`,
    write: ["T"],
    read: [],
    excluded: ["R"],
  },
  { prompt: (p) => `Fix ${p.T} (do not modify ${p.R})`, write: ["T"], read: ["R"], excluded: ["R"] },
  {
    prompt: (p) => `Do not modify anything in ${p.R}. Implement the feature in ${p.T}.`,
    write: ["T"],
    read: ["R"],
    excluded: ["R"],
  },
  { prompt: (p) => `${p.R}: do not touch. Fix ${p.T}.`, write: ["T"], read: [], excluded: ["R"] },
  { prompt: (p) => `Refactor ${p.Rsrc}. Do not touch ${p.R}.`, write: "refuse", excluded: ["R", "Rsrc"] },
  { prompt: (p) => `Do not touch ${p.R} or ${p.R2}`, write: "refuse", excluded: ["R", "R2"] },
  {
    prompt: (p) => `Fix the bug in ${p.T}. Do not touch ${p.R}, ${p.R2}`,
    write: ["T"],
    read: [],
    excluded: ["R", "R2"],
  },
  {
    prompt: (p) => `Do not touch ${p.R} and do not modify ${p.R2}; implement the feature in ${p.T}`,
    write: ["T"],
    read: ["R2"],
    excluded: ["R", "R2"],
  },
  {
    prompt: (p) => `Do\u200B not \uFF54ouch ${p.R}. Implement the feature in ${p.T}`,
    write: ["T"],
    read: [],
    excluded: ["R"],
  },
  { prompt: (p) => `Don\u2019t modify ${p.R}; fix ${p.T}`, write: ["T"], read: ["R"], excluded: ["R"] },
  {
    prompt: (p) => `Implement the feature in ${p.T}, keeping ${p.R} read-only`,
    write: ["T"],
    read: ["R"],
    excluded: ["R"],
  },
  {
    prompt: (p) => `Use ${p.R}, which is read-only, and implement the change in ${p.T}`,
    write: ["T"],
    read: ["R"],
    excluded: ["R"],
  },
  {
    prompt: (p) => `Keep ${p.R} and ${p.R2} read-only and implement the feature in ${p.T}`,
    write: ["T"],
    read: ["R", "R2"],
    excluded: ["R", "R2"],
  },
  { prompt: (p) => `Refactor ${p.T}. Leave ${p.R} untouched.`, write: ["T"], read: ["R"], excluded: ["R"] },
  // Reference / direction.
  { prompt: (p) => `Mirror the layout of ${p.R} in ${p.T}`, write: ["T"], read: ["R"], excluded: ["R"] },
  {
    prompt: (p) => `Follow the pattern in ${p.R} and fix the bug in ${p.T}`,
    write: ["T"],
    read: ["R"],
    excluded: ["R"],
  },
  { prompt: (p) => `Based on ${p.R}, implement the importer in ${p.T}`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Fix ${p.T} using ${p.R} as a guide`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Look at ${p.R} and fix the same bug in ${p.T}`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Apply the patch from ${p.R} to ${p.T}`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Compare ${p.R} with ${p.R2}`, write: "refuse", excluded: ["R", "R2"] },
  // Markdown structure.
  {
    prompt: (p) => `DO NOT MODIFY:\n- ${p.R}\n- ${p.R2}\n\nFix the bug in ${p.T}`,
    write: ["T"],
    read: ["R", "R2"],
    excluded: ["R", "R2"],
  },
  {
    prompt: (p) => `## Read-only\n- ${p.R}\n\n## Task\nImplement the feature in ${p.T}`,
    write: ["T"],
    read: ["R"],
    excluded: ["R"],
  },
  { prompt: (p) => `- Fix the bug in ${p.T}\n- Do not touch ${p.R}`, write: ["T"], read: [], excluded: ["R"] },
  {
    prompt: (p) => `Tasks:\n1. Fix the bug in ${p.T}\n2. Never modify ${p.R}`,
    write: ["T"],
    read: ["R"],
    excluded: ["R"],
  },
  // Quoting, spaces, relative paths, punctuation, case.
  { prompt: (p) => `Implement the feature in "${p.S}"`, write: ["S"] },
  { prompt: (p) => `Fix the bug in \`${p.T}\`. Do not modify \`${p.R}\`.`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Fix the bug in '${p.T}', not in "${p.R}"`, write: ["T"], read: ["R"], excluded: ["R"] },
  { prompt: (p) => `Fix the bug in ../${basename(p.T)}`, write: ["T"] },
  {
    prompt: (p) => `Fix the bug in ../${basename(p.T)}. Do not touch ../${basename(p.R)}.`,
    write: ["T"],
    read: [],
    excluded: ["R"],
  },
  { prompt: () => "Fix the bug in ./src", write: ["L"] },
  { prompt: (p) => `FIX THE BUG IN ${p.T}!`, write: ["T"] },
  { prompt: (p) => `Fix the bug in ${p.T}?!`, write: ["T"] },
  // Non-repository targets and inputs.
  { prompt: (p) => `Write the export files under ${p.D}`, write: "refuse", message: /not inside a Git repository/ },
  { prompt: (p) => `Create the docs in ${p.T}/docs-new`, write: ["T"] },
];

const LEGIT: Array<{ prompt: (p: Paths) => string; write: Name[] }> = [
  { prompt: (p) => `Fix the bug in ${p.T}`, write: ["T"] },
  { prompt: (p) => `Fix ${p.T}`, write: ["T"] },
  { prompt: (p) => `Implement the feature in ${p.T}.`, write: ["T"] },
  { prompt: (p) => `Refactor ${p.T} and ${p.R2}`, write: ["T", "R2"] },
  { prompt: (p) => `Coordinate ${p.T} with ${p.R2}`, write: ["T", "R2"] },
  { prompt: (p) => `Review ${p.T}`, write: ["T"] },
  { prompt: (p) => `The tests in ${p.T} fail. Fix them.`, write: ["T"] },
  { prompt: (p) => `The build does not pass in ${p.T}; fix it`, write: ["T"] },
  { prompt: (p) => `Remove the dead code from ${p.T}`, write: ["T"] },
  { prompt: (p) => `Fix the flaky test in ${p.T} that no longer uses the cache`, write: ["T"] },
  { prompt: (p) => `Upgrade the dependencies in ${p.T} and make sure no test breaks`, write: ["T"] },
  { prompt: () => "Add a /health endpoint that returns build info", write: ["L"] },
  { prompt: () => "Expose GET /api/v1/users from the service", write: ["L"] },
  { prompt: () => 'Make the server mount the app at "/" and keep the existing routes', write: ["L"] },
  { prompt: () => "Implement the requested change", write: ["L"] },
];

describe("workspace authority corpus (PR #106 final review)", () => {
  let paths: Paths;
  const disposers: Array<() => Promise<void>> = [];

  before(async () => {
    const make = async () => {
      const repo = await makeFixtureRepo();
      disposers.push(repo.cleanup);
      return repo.root;
    };
    const [L, T, R, R2] = [await make(), await make(), await make(), await make()];
    const spacedParent = await mkdtemp(join(tmpdir(), "pi-eng-corpus-spaced-"));
    const S = join(spacedParent, "repo with spaces");
    await rename(await make(), S);
    const D = await mkdtemp(join(tmpdir(), "pi-eng-corpus-data-"));
    const F = join(D, "crash.log");
    await writeFile(F, "boom\n");
    await mkdir(join(R!, "src"), { recursive: true });
    disposers.push(
      () => rm(spacedParent, { recursive: true, force: true }),
      () => rm(D, { recursive: true, force: true }),
    );
    paths = { L: L!, T: T!, R: R!, R2: R2!, S, F, D, Rsrc: join(R!, "src") };
  });

  after(async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
  });

  const nameOf = (path: string): string => {
    const entry = Object.entries(paths).find(([, value]) => value === path);
    return entry ? entry[0] : path;
  };

  async function attempt(prompt: string) {
    try {
      return { resolved: await new WorkspaceManifestResolver().resolve(prompt, paths.L) };
    } catch (error) {
      return { error };
    }
  }

  CORPUS.forEach((row, index) => {
    it(`corpus #${index + 1}: ${row.prompt({ L: "L", T: "T", R: "R", R2: "R2", S: "S", F: "F", D: "D", Rsrc: "R/src" }).replace(/\n/g, "\\n")}`, async () => {
      const prompt = row.prompt(paths);
      const outcome = await attempt(prompt);
      if (outcome.resolved) {
        const writable = outcome.resolved.repositories.map((repository) => nameOf(repository.canonicalRoot));
        // Invariant: nothing in an exclusion position is writable.
        for (const name of row.excluded ?? []) {
          assert.ok(!writable.includes(name), `${name} is excluded but writable: ${prompt}`);
          assert.ok(
            !outcome.resolved.authorizedRoots.some(
              (root) =>
                root.access === "write" &&
                (root.canonicalPath === paths[name] || paths[name].startsWith(`${root.canonicalPath}/`)),
            ),
            `${name} is excluded but inside a writable root: ${prompt}`,
          );
        }
      }
      if (row.write === "refuse") {
        assert.ok(outcome.error instanceof WorkspaceScopeError, `expected a refusal for: ${prompt}`);
        if (row.message) assert.match(String(outcome.error), row.message);
        return;
      }
      assert.ok(outcome.resolved, `unexpected refusal for ${prompt}: ${String(outcome.error)}`);
      const writable = outcome.resolved.repositories.map((repository) => nameOf(repository.canonicalRoot)).sort();
      assert.deepEqual(writable, [...row.write].sort(), `writable roots for: ${prompt}`);
      if (row.read) {
        const read = outcome.resolved.authorizedRoots
          .filter((root) => root.access === "read")
          .map((root) => nameOf(root.canonicalPath))
          .sort();
        assert.deepEqual(read, [...row.read].sort(), `read-only roots for: ${prompt}`);
      }
    });
  });

  it(`the corpus is large enough (${CORPUS.length} prompts)`, () => {
    assert.ok(CORPUS.length >= 60);
  });

  LEGIT.forEach((row, index) => {
    it(`no-regression #${index + 1}: ${row.prompt({ L: "L", T: "T", R: "R", R2: "R2", S: "S", F: "F", D: "D", Rsrc: "R/src" })}`, async () => {
      const prompt = row.prompt(paths);
      const outcome = await attempt(prompt);
      assert.ok(outcome.resolved, `unexpected refusal for ${prompt}: ${String(outcome.error)}`);
      const writable = outcome.resolved.repositories.map((repository) => nameOf(repository.canonicalRoot)).sort();
      assert.deepEqual(writable, [...row.write].sort());
    });
  });
});
