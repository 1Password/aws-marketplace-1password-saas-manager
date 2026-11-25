/**
 * SaaS provider registry — this bundle has one provider, "1Password SaaS Manager".
 * (The full multi-provider dev repo registers others; this bundle ships only one.)
 */
import type { SaaSProvider } from "./provider.js";
import { onePasswordAdapter as providerAdapter } from "./providers/1password.js";

export const SAAS_ADAPTERS: Record<string, SaaSProvider> = { "1password": providerAdapter };
export const DEFAULT_PROVIDER = "1password";

export function activeSaaSProvider(): SaaSProvider {
  const id = process.env.SAAS_PROVIDER || DEFAULT_PROVIDER;
  const adapter = SAAS_ADAPTERS[id];
  if (!adapter) throw new Error(`Unknown SAAS_PROVIDER "${id}". This bundle ships only "1password".`);
  return adapter;
}
