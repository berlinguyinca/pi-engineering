/**
 * Install the admission-retry transport onto a provider registry.
 *
 * Works for both the worker runtime (`ModelRuntime.registerLocalProviders`) and
 * the interactive session (`ctx.modelRegistry`): each eligible registered
 * provider is re-registered with its `streamSimple` wrapped so admission
 * rejections become waits. Idempotent, and never bypasses a custom transport:
 * an existing `streamSimple` becomes the delegate for each attempt.
 */

import { type AdmissionRetryConfig, shouldWrapProvider } from "./admissionConfig.ts";
import type { AdmissionEventBus } from "./admissionEvents.ts";
import {
  type AdmissionBudgetLedger,
  type AdmissionSaturation,
  type AdmissionScope,
  type AdmissionState,
  type AdmissionStreamFunction,
  createAdmissionStreamSimple,
} from "./admissionTransport.ts";

/** Structural shape of the registries this installer can target. */
export interface AdmissionRegistry {
  registerProvider(id: string, config: unknown): void;
  getRegisteredProviderConfig(id: string): unknown;
  /** Provider ids currently registered; when absent the installer scans known ids. */
  getRegisteredProviders?(): string[] | Iterable<string>;
}

export interface AdmissionInstallOptions {
  config: AdmissionRetryConfig;
  events?: AdmissionEventBus;
  budget?: AdmissionBudgetLedger;
  scope?: AdmissionScope | (() => AdmissionScope);
  onState?: (state: AdmissionState) => void;
  onSaturation?: (ref: { provider: string; id: string }, saturation: AdmissionSaturation) => void;
  log?: (level: "debug" | "info" | "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
  /** Only wrap these provider ids; empty means every registered provider. */
  providers?: string[];
}

export interface AdmissionInstallReport {
  wrapped: string[];
  skipped: { provider: string; reason: string }[];
}

/** Marker proving a provider's `streamSimple` is the harness admission wrapper. */
export const ADMISSION_WRAPPED = Symbol("admission-wrapped");

interface ProviderConfigLike {
  streamSimple?: AdmissionStreamFunction;
}

/** True when `config.streamSimple` is the harness's own wrapper. */
export function isAdmissionWrapped(config: unknown): boolean {
  const cfg = config as ProviderConfigLike | undefined;
  if (!cfg || typeof cfg.streamSimple !== "function") return false;
  return (cfg.streamSimple as unknown as { [ADMISSION_WRAPPED]?: boolean })[ADMISSION_WRAPPED] === true;
}

function providerIds(registry: AdmissionRegistry): string[] {
  if (typeof registry.getRegisteredProviders === "function") {
    return [...registry.getRegisteredProviders()];
  }
  return [];
}

/** Wrap every eligible provider and report what happened. */
export function installAdmissionRetry(
  registry: AdmissionRegistry,
  opts: AdmissionInstallOptions,
): AdmissionInstallReport {
  const report: AdmissionInstallReport = { wrapped: [], skipped: [] };
  const ids = providerIds(registry);

  for (const id of ids) {
    const raw = registry.getRegisteredProviderConfig(id);
    if (!raw || typeof raw !== "object") {
      report.skipped.push({ provider: id, reason: "no registered config" });
      continue;
    }
    const config = raw as ProviderConfigLike;
    if (opts.providers && opts.providers.length > 0 && !opts.providers.includes(id)) {
      report.skipped.push({ provider: id, reason: "not in providers allowlist" });
      continue;
    }
    if (!shouldWrapProvider(opts.config, id)) {
      report.skipped.push({ provider: id, reason: "admission disabled for provider" });
      continue;
    }
    if (isAdmissionWrapped(config)) {
      report.skipped.push({ provider: id, reason: "already wrapped" });
      continue;
    }

    // Preserve any custom transport the provider already ships: it becomes the
    // delegate, so each attempt is still produced by the extension's own code.
    const delegate: AdmissionStreamFunction | undefined = config.streamSimple;
    const wrapped = createAdmissionStreamSimple({
      config: opts.config,
      events: opts.events,
      budget: opts.budget,
      scope: opts.scope,
      onState: opts.onState,
      onSaturation: opts.onSaturation,
      log: opts.log,
      delegate,
    });
    Object.defineProperty(wrapped, ADMISSION_WRAPPED, { value: true, enumerable: false });

    registry.registerProvider(id, { ...config, streamSimple: wrapped });
    report.wrapped.push(id);
  }
  return report;
}
