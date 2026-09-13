/**
 * Differential testing (spec §15.9, backlog B-107).
 *
 * Compares the output of two commands (e.g. reference vs candidate
 * implementation) across a set of inputs. Mismatched outputs are recorded as
 * findings. Pure and deterministic; commands are injected so tests use fakes.
 */
export interface DiffCase {
  id: string;
  input: string;
}

export interface CommandRunner {
  /** Run a command on an input and return its stdout. */
  run(input: string): Promise<{ stdout: string; error?: string }>;
}

export interface DiffFinding {
  caseId: string;
  input: string;
  refOutput: string;
  candOutput: string;
}

export interface DifferentialReport {
  cases: number;
  matched: number;
  mismatched: number;
  errors: number;
  findings: DiffFinding[];
  pass: boolean;
}

/** Run differential comparison across cases. Pass when no mismatches/errors. */
export async function differentialTest(
  cases: DiffCase[],
  reference: CommandRunner,
  candidate: CommandRunner,
): Promise<DifferentialReport> {
  const findings: DiffFinding[] = [];
  let matched = 0;
  let errors = 0;
  for (const c of cases) {
    const ref = await reference.run(c.input);
    const cand = await candidate.run(c.input);
    if (ref.error || cand.error) {
      errors++;
      continue;
    }
    if (ref.stdout === cand.stdout) {
      matched++;
    } else {
      findings.push({ caseId: c.id, input: c.input, refOutput: ref.stdout, candOutput: cand.stdout });
    }
  }
  return {
    cases: cases.length,
    matched,
    mismatched: findings.length,
    errors,
    findings,
    pass: matched === cases.length,
  };
}
