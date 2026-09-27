/**
 * Browser-side Astro runtime.
 *
 * This module is the pieces of Astro needed to render a compiled `.astro`
 * component to HTML:
 *
 * - the SSR runtime, which the *compiled* component imports its helpers from
 * - the container API, used to drive a render
 * - `createMetadata`, which `@astrojs/compiler` emits but which is not part of
 *   the SSR runtime (see below)
 *
 * Everything lives in one module on purpose: the compiled component and the
 * container must share the same module instance, or type checks like
 * `isAstroComponentFactory` fail across the two.
 *
 * It is consumed two ways:
 * - as the `internalURL` given to the compiler, so compiled output imports from it
 * - dynamically imported by the compiler glue to obtain `experimental_AstroContainer`
 */

export * from 'astro/runtime/server/index.js';
export { experimental_AstroContainer } from 'astro/container';

/**
 * `@astrojs/compiler` emits `$$metadata = createMetadata(moduleId, {...})` and
 * imports `createMetadata` from `internalURL`. No Astro runtime (2.x–7.x)
 * exports it: it is a build-time helper that Astro's own pipeline consumes from
 * the `$$metadata` export, not something SSR needs. Providing it here keeps the
 * compiler output importable without affecting rendering.
 */
export function createMetadata(
  moduleId: string,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return { moduleId, ...metadata };
}
