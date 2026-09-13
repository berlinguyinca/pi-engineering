/**
 * Blackhole package validation.
 *
 * Pins and records the Blackhole version and validates that the loaded provider
 * satisfies the pinned/allowlisted version. When the real `pi-blackhole` package
 * is not installed, we degrade to the built-in session-memory provider and
 * record that explicitly — the runtime never fails because an optional package
 * is absent (project constraint: core must not require optional adapters).
 */

export type ProviderKind = "builtin" | "pi-blackhole" | "disabled";

export interface PackageValidation {
  ok: boolean;
  provider: ProviderKind;
  requestedVersion: string;
  /** The version actually loaded, when a real package is present. */
  loadedVersion: string | null;
  reason: string;
}

export interface ValidationEvent {
  type: "blackhole.package.validated";
  ok: boolean;
  provider: ProviderKind;
  requestedVersion: string;
  loadedVersion: string | null;
  reason: string;
}

/** Attempt to load the real pi-blackhole package; returns null when absent. */
export async function tryLoadBlackholePackage(): Promise<{ version: string } | null> {
  try {
    // Dynamic import so an absent optional dependency never breaks the bundle.
    const mod = (await import("pi-blackhole")) as { version?: string; VERSION?: string; default?: unknown };
    const version = (mod.version ?? mod.VERSION) as string | undefined;
    return version ? { version } : { version: "unknown" };
  } catch {
    return null;
  }
}

/**
 * Validate the loaded provider against the pinned/allowlisted version.
 * Returns the decision + a machine-readable validation event (for the ledger).
 */
export async function validateBlackholePackage(opts: {
  enabled: boolean;
  requestedVersion: string;
}): Promise<{ validation: PackageValidation; event: ValidationEvent }> {
  if (!opts.enabled) {
    const v: PackageValidation = {
      ok: true,
      provider: "disabled",
      requestedVersion: opts.requestedVersion,
      loadedVersion: null,
      reason: "blackhole disabled; no provider loaded",
    };
    return { validation: v, event: { type: "blackhole.package.validated", ...v } };
  }
  const pkg = await tryLoadBlackholePackage();
  if (!pkg) {
    const v: PackageValidation = {
      ok: true,
      provider: "builtin",
      requestedVersion: opts.requestedVersion,
      loadedVersion: null,
      reason: `pi-blackhole package not installed; using built-in session-memory provider (pinned semantics for ${opts.requestedVersion})`,
    };
    return { validation: v, event: { type: "blackhole.package.validated", ...v } };
  }
  if (pkg.version !== opts.requestedVersion) {
    const v: PackageValidation = {
      ok: false,
      provider: "pi-blackhole",
      requestedVersion: opts.requestedVersion,
      loadedVersion: pkg.version,
      reason: `installed pi-blackhole@${pkg.version} does not match requested ${opts.requestedVersion}`,
    };
    return { validation: v, event: { type: "blackhole.package.validated", ...v } };
  }
  const v: PackageValidation = {
    ok: true,
    provider: "pi-blackhole",
    requestedVersion: opts.requestedVersion,
    loadedVersion: pkg.version,
    reason: `validated pi-blackhole@${pkg.version} matches requested version`,
  };
  return { validation: v, event: { type: "blackhole.package.validated", ...v } };
}
