/**
 * Typed surface of the opt-in OMP (oh-my-pi) adapter spike.
 *
 * Nothing here is wired into mission/worker code. Callers receive either an
 * `available` capability report or an explicit `unavailable` result and fall
 * back to the legacy path.
 */

export type RpcProtocolVersion = 1 | 2;

export const UnavailableReason = {
  Disabled: "disabled",
  BinaryAbsent: "binary_absent",
  Timeout: "timeout",
  VersionUnreadable: "version_unreadable",
  VersionMismatch: "version_mismatch",
  ProtocolMismatch: "protocol_mismatch",
  MalformedFrame: "malformed_frame",
  Crashed: "crashed",
} as const;
export type UnavailableReason = (typeof UnavailableReason)[keyof typeof UnavailableReason];

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Pinned compatibility manifest: the only OMP builds the adapter will talk to. */
export interface OmpPinManifest {
  /** Inclusive lower bound. */
  readonly minVersion: SemVer;
  /** Exclusive upper bound. */
  readonly maxVersionExclusive: SemVer;
  /** Protocol versions the adapter understands, any order. */
  readonly acceptedProtocolVersions: readonly RpcProtocolVersion[];
  /** Upstream commit the manifest was validated against (documentation only). */
  readonly validatedAgainstCommit: string;
}

/** Decoded `ready` frame (first frame OMP emits in `--mode rpc`). */
export interface OmpReadyFrame {
  readonly protocolVersion: number;
  readonly supportedProtocolVersions: readonly number[];
  readonly maxFrameBytes: number;
  readonly maxReassembledFrameBytes: number | null;
  readonly supportsBashExcludeFromContext: boolean;
}

/** Decoded `negotiate_protocol` response. */
export type NegotiateResponse =
  | { readonly kind: "accepted"; readonly protocolVersion: number }
  | { readonly kind: "rejected"; readonly error: string };

export interface CapabilityReport {
  readonly ompVersion: string;
  readonly negotiatedProtocol: RpcProtocolVersion;
  readonly supportedProtocolVersions: readonly number[];
  readonly maxFrameBytes: number;
  readonly maxReassembledFrameBytes: number | null;
  readonly chunkedFrames: boolean;
  readonly bashExcludeFromContext: boolean;
}

export type OmpNegotiationResult =
  | { readonly kind: "available"; readonly report: CapabilityReport }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason; readonly detail: string };

export interface OmpLaunchSpec {
  /** Executable, e.g. `omp` or a runtime such as `bun`. */
  readonly command: string;
  /** Arguments placed before the adapter's own flags (e.g. a script path). */
  readonly args: readonly string[];
}

export interface OmpAdapterConfig {
  readonly enabled: boolean;
  readonly launch: OmpLaunchSpec;
  readonly timeoutMs: number;
}
