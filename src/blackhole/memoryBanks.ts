/**
 * Which `herdr-memory` banks Pi is allowed to read.
 *
 * The rule itself is copied verbatim from `hindsight.ts`, where it guards every record the provider accepts
 * (lines 224 and 276 of that file as of 2026-11-18). It lives here so the preflight (#717) can apply the same
 * rule to a bank listing without importing the provider, which would make `hindsight.ts` and
 * `memoryProvisioning.ts` import each other.
 */

/** True for banks in the engineering namespaces (never personal-assistant memory). */
export function engineeringBank(bank: unknown, scope?: string): bank is string {
  if (typeof bank !== "string" || /^(personal|rakazo|assistant)/i.test(bank)) return false;
  if (scope === "global") return bank === "herdr-global";
  if (scope === "infra") return bank === "herdr-infra";
  if (scope?.startsWith("mission:"))
    return bank.endsWith(`-mission-${scope.slice(8)}`) && /^[a-z0-9][a-z0-9_-]*-mission-[a-z0-9_-]+$/.test(bank);
  if (scope === "project") return /^[a-z0-9][a-z0-9_-]*-facts$/.test(bank);
  return (
    bank === "herdr-global" ||
    bank === "herdr-infra" ||
    /^[a-z0-9][a-z0-9_-]*-(?:facts|mission-[a-z0-9_-]+)$/.test(bank)
  );
}
