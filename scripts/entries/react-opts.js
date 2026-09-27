/**
 * Shim for the `astro:react:opts` virtual module.
 *
 * `@astrojs/react`'s server renderer imports this module, which is normally
 * provided by its Vite plugin and therefore has no runtime equivalent. The
 * options it exposes only tune the integration (filtering, children
 * serialization), so an empty object is a safe default outside a Vite build.
 */
export default {};
