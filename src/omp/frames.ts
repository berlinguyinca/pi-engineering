import type { NegotiateResponse, OmpReadyFrame } from "./types.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse one JSONL line. Null when it is not a JSON object. */
export function parseFrameLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** Decode a `ready` frame; null when the frame is not a well-formed ready frame. */
export function decodeReadyFrame(frame: Record<string, unknown>): OmpReadyFrame | null {
  if (frame.type !== "ready") return null;
  const { protocolVersion, supportedProtocolVersions, maxFrameBytes, maxReassembledFrameBytes } = frame;
  if (typeof protocolVersion !== "number") return null;
  if (!Array.isArray(supportedProtocolVersions) || !supportedProtocolVersions.every((v) => typeof v === "number")) {
    return null;
  }
  if (typeof maxFrameBytes !== "number") return null;
  return {
    protocolVersion,
    supportedProtocolVersions: supportedProtocolVersions as number[],
    maxFrameBytes,
    maxReassembledFrameBytes: typeof maxReassembledFrameBytes === "number" ? maxReassembledFrameBytes : null,
    // Older runtimes omit the field; upstream says to require exactly `true`.
    supportsBashExcludeFromContext: frame.supportsBashExcludeFromContext === true,
  };
}

export function encodeNegotiateRequest(id: string, protocolVersion: number): string {
  return `${JSON.stringify({ id, type: "negotiate_protocol", protocolVersion })}\n`;
}

/** Decode the response to `negotiate_protocol` with the given id; null when the frame is some other frame. */
export function decodeNegotiateResponse(frame: Record<string, unknown>, id: string): NegotiateResponse | null {
  if (frame.type !== "response" || frame.command !== "negotiate_protocol" || frame.id !== id) return null;
  if (frame.success === true) {
    const data = asRecord(frame.data);
    const version = data?.protocolVersion;
    return typeof version === "number"
      ? { kind: "accepted", protocolVersion: version }
      : { kind: "rejected", error: "negotiate_protocol success without protocolVersion" };
  }
  return { kind: "rejected", error: typeof frame.error === "string" ? frame.error : "negotiate_protocol failed" };
}
