/**
 * Mutation testing (spec §15.8, backlog B-107).
 *
 * Deterministically mutate a source module (one operator per mutant), run a
 * test harness, and measure the kill rate: the fraction of mutants whose
 * behavioral change is caught by the tests. A low kill rate marks weak tests.
 *
 * The harness is injected so tests use a fake; the production harness shells
 * out to the project's test runner. `applyMutant` is pure and exported for
 * unit testing.
 */
export type MutationOperator = "arithmetic" | "comparison" | "boolean" | "return" | "remove-statement";

export interface Mutant {
  id: string;
  file: string;
  line: number;
  operator: MutationOperator;
  /** The mutated source text (full file). */
  source: string;
}

export interface MutationHarness {
  /** Run the tests; resolve true when the tests FAIL (mutant killed). */
  runTests(source: string): Promise<{ killed: boolean; error?: string }>;
}

const OPERATORS: Array<{ id: MutationOperator; re: RegExp }> = [
  { id: "arithmetic", re: /([^=!<>])\s*([+\-*/])\s*([^+\-*/=\n])/g },
  { id: "comparison", re: /(===|!==|<=|>=|>|<)/g },
  { id: "boolean", re: /(&&|\|\|)/g },
  { id: "return", re: /return\s+true;|return\s+false;/g },
  { id: "remove-statement", re: /throw new Error\([^)]*\);/g },
];

/** Produce a single mutant for each operator application in the source. */
export function generateMutants(file: string, source: string): Mutant[] {
  const lines = source.split("\n");
  const out: Mutant[] = [];
  let id = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const op of OPERATORS) {
      if (!op.re.test(line)) continue;
      const mutated = mutateLine(line, op.id);
      if (mutated !== line) {
        const next = [...lines];
        next[i] = mutated;
        out.push({ id: `${file}#${id++}`, file, line: i + 1, operator: op.id, source: next.join("\n") });
      }
    }
  }
  return out;
}

function mutateLine(line: string, op: MutationOperator): string {
  switch (op) {
    case "arithmetic":
      return line.replace(/([^=!<>])\s*([+\-*/])\s*([^+\-*/=\n])/, (m, a, _op, b) => `${a} ${swapArith(_op)} ${b}`);
    case "comparison":
      return line.replace(/(===|!==|<=|>=|>|<)/, (m, c) => swapCmp(c));
    case "boolean":
      return line.replace(/(&&|\|\|)/, (m, b) => (b === "&&" ? "||" : "&&"));
    case "return":
      return line.replace(/return\s+true;/, "return false;").replace(/return\s+false;/, "return true;");
    case "remove-statement":
      return line.replace(/throw new Error\([^)]*\);\s*/, "");
  }
}

function swapArith(op: string): string {
  switch (op) {
    case "+":
      return "-";
    case "-":
      return "+";
    case "*":
      return "/";
    case "/":
      return "*";
    default:
      return op;
  }
}
function swapCmp(c: string): string {
  switch (c) {
    case "===":
      return "!==";
    case "!==":
      return "===";
    case "<=":
      return ">=";
    case ">=":
      return "<=";
    case "<":
      return ">";
    case ">":
      return "<";
    default:
      return c;
  }
}

export interface MutationReport {
  mutants: number;
  killed: number;
  survived: number;
  errors: number;
  killRate: number; // 0..1
  survivedMutants: Mutant[];
}

/** Run all mutants through the harness and compute the kill rate. */
export async function runMutationSuite(
  source: string,
  file: string,
  harness: MutationHarness,
): Promise<MutationReport> {
  const mutants = generateMutants(file, source);
  let killed = 0;
  let errors = 0;
  const survivedMutants: Mutant[] = [];
  for (const m of mutants) {
    const res = await harness.runTests(m.source);
    if (res.error) errors++;
    else if (res.killed) killed++;
    else survivedMutants.push(m);
  }
  const total = mutants.length;
  return {
    mutants: total,
    killed,
    survived: total - killed - errors,
    errors,
    killRate: total === 0 ? 1 : killed / total,
    survivedMutants,
  };
}
