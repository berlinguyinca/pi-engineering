/**
 * Corpus for the primary-worktree guard's write-target extraction (#456).
 *
 * Every READ_ONLY entry here is a command that a real session tried and that the
 * guard blocked, harvested from session logs and from the issue's table: the
 * command touches nothing inside the repository, so blocking it is a false
 * positive that stops the model mid-task.
 *
 * Every WRITE entry is a command that MUST keep producing a target under the
 * repository. Fail-closed is the property that makes the guard worth having: a
 * fix that clears the read-only cases by widening what it ignores is worse than
 * the bug.
 */

/** Blocked in real sessions; must produce no repository-relative target. */
export const READ_ONLY_COMMANDS: readonly string[] = [
  // `>` inside a quoted string is prose, not a redirect.
  `echo "before -> after" | tee /dev/null`,
  `grep -rn "x > y" src/`,
  `grep -rn 'a > b' src/guard/primaryWorktreeGuard.ts`,
  `node -e 'if (a > b) console.log(1)' > /tmp/x 2>/dev/null`,
  `awk '{ if ($1 > 3) print }' data.csv`,
  // fd duplication is not a file write.
  `make 2>&1 | tail -20`,
  `cmd 2>&1`,
  `npm test 2>&1 | grep -c fail`,
  `git show HEAD 2>&1 | head -5`,
  // `~` is the caller's home directory, not a path under the repo.
  `cp ~/.bashrc ~/.bashrc.bak-1730000000`,
  `cp notes.json "$HOME"/notes.json`,
  // A variable the guard cannot expand is NOT a licence to skip the target —
  // see WRITE_COMMANDS for the fail-closed case. `$HOME` is knowable, so a
  // home-directory copy clears; the distinction is expandability.
  `cp notes.json "$HOME"/notes.json`,
  // Read-only git and inspection.
  `git status`,
  `git log --oneline -5`,
  `ls -la`,
  `cat file | head -5`,
  // Redirection into /tmp is outside the repository.
  `make > /tmp/build.log 2>&1`,
  `python - <<'EOF' > /tmp/out.txt 2>&1`,
];

/** Must still yield a target that resolves inside the repository. */
export const WRITE_COMMANDS: readonly string[] = [
  `echo x >> AGENTS.md`,
  `echo x > README.md`,
  `cat a | tee src/index.ts`,
  `cat a | tee -a docs/usage.md`,
  `sed -i 's/a/b/' src/guard/primaryWorktreeGuard.ts`,
  `cp old.ts new.ts`,
  `mv a.ts b.ts`,
  `echo secret > .env`,
  `printf '%s' x > src/generated.ts`,
  // Fail-closed: an unexpandable variable still names a path under the cwd.
  `echo x > "$OUT"/log.txt`,
  `echo x > $UNKNOWN_FILE`,
  `cat a | tee "$TARGET"`,
  `cp src/a.ts "$DEST"`,
  // Redirect that follows a quoted argument still writes the repo file.
  `grep -rn "x > y" src/ > hits.txt`,
  `node -e 'console.log("a > b")' > build/artifact.js`,
  // Truncating a tracked file through a redirect.
  `: > src/version.ts`,
  // Fail-closed, not a guess: `$A` is not set in this process, so the guard
  // cannot prove the destination is outside the repository. Skipping it would
  // make `> "$OUT"/log.txt` invisible, which is the hole this fix exists to
  // close. An unexpandable variable is treated as a path under the cwd.
  `cp x.json "$A"/ 2>/dev/null`,
];
