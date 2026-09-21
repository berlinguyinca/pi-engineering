/**
 * ProviderLimitRegistry — per-provider request/context limits
 * (spec: pi-engineering-vision-payload-management, §17).
 */

export interface ProviderLimits {
  provider: string;
  maxRequestBytes?: number;
  maxContextTokens?: number;
  supportsVision?: boolean;
  preferredImageLongEdge?: number;
  maxImagesPerRequest?: number;
}

export class ProviderLimitRegistry {
  private readonly limits = new Map<string, ProviderLimits>();

  register(limits: ProviderLimits): void {
    this.limits.set(limits.provider, limits);
  }

  get(provider: string): ProviderLimits | undefined {
    return this.limits.get(provider);
  }

  /** Registered limits merged over fallback defaults; never throws. */
  resolve(provider: string, fallback: Partial<ProviderLimits> = {}): ProviderLimits {
    const registered = this.limits.get(provider);
    return {
      ...fallback,
      ...registered,
      provider,
    };
  }

  /** Registered maxRequestBytes, else fallback, else 0. */
  maxRequestBytesFor(provider: string, fallback?: number): number {
    const limits = this.limits.get(provider);
    if (limits?.maxRequestBytes !== undefined) return limits.maxRequestBytes;
    return fallback ?? 0;
  }
}
