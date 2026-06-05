/**
 * Resolve user-supplied provider slugs (e.g. "openai") to registry ids
 * (e.g. "provider_openai"). R2 has no separate slug column; slugs are the
 * portion of the id after the `provider_` prefix, and any value lacking that
 * prefix gets it prepended.
 */
export function resolveProviderIds(slugs: readonly string[] | undefined): string[] | undefined {
  if (!slugs || slugs.length === 0) return undefined;
  return slugs.map((slug) => (slug.startsWith("provider_") ? slug : `provider_${slug}`));
}

export function resolveRuntimeIds(slugs: readonly string[] | undefined): string[] | undefined {
  if (!slugs || slugs.length === 0) return undefined;
  return slugs.map((slug) => (slug.startsWith("runtime_") ? slug : `runtime_${slug}`));
}
