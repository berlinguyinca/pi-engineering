import type { CapabilityReport, OmpPinManifest, OmpReadyFrame, RpcProtocolVersion } from "./types.ts";

/** Highest protocol version both the manifest and the runtime support; null when disjoint. */
export function selectProtocol(ready: OmpReadyFrame, manifest: OmpPinManifest): RpcProtocolVersion | null {
  const shared = manifest.acceptedProtocolVersions.filter((v) => ready.supportedProtocolVersions.includes(v));
  return shared.length === 0 ? null : (Math.max(...shared) as RpcProtocolVersion);
}

export function buildCapabilityReport(
  ompVersion: string,
  ready: OmpReadyFrame,
  negotiatedProtocol: RpcProtocolVersion,
): CapabilityReport {
  return {
    ompVersion,
    negotiatedProtocol,
    supportedProtocolVersions: ready.supportedProtocolVersions,
    maxFrameBytes: ready.maxFrameBytes,
    maxReassembledFrameBytes: ready.maxReassembledFrameBytes,
    chunkedFrames: negotiatedProtocol === 2,
    bashExcludeFromContext: ready.supportsBashExcludeFromContext,
  };
}
