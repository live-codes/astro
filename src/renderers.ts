/**
 * Framework renderer registration.
 *
 * Astro's container refuses to render framework components unless a matching
 * *server renderer* is registered, and it cannot emit a hydratable island unless
 * the renderer also has a *client entrypoint*. Both come from the framework's
 * Astro integration (`@astrojs/react` and friends), which is why each framework
 * is configured here as a pair of module URLs.
 *
 * The framework runtime (`react`, `react-dom`, …) is deliberately **not** bundled
 * into these modules: the renderer and the user's components must import the same
 * instance, so the specifiers are left bare and resolved by the host's import map.
 */
import type { HydratedComponent } from '@astrojs/compiler/types';

export interface FrameworkConfig {
  /** Renderer name, e.g. `@astrojs/react`. Must match the integration's name. */
  name: string;
  /** Module URL whose default export is the server renderer (`…/server.js`). */
  server: string;
  /** Module URL whose default export is the client entrypoint (`…/client.js`). */
  client?: string;
  /** File extensions this framework owns, used to detect usage, e.g. `['.jsx']`. */
  extensions?: string[];
  /** JSX runtime import source, e.g. `react` (for Preact: `preact`). */
  jsxImportSource?: string;
}

interface ServerRenderer {
  name?: string;
  check?: unknown;
  renderToStaticMarkup?: unknown;
}

const serverModules = new Map<string, Promise<{ default?: ServerRenderer } & ServerRenderer>>();

function loadServerModule(url: string) {
  let module = serverModules.get(url);
  if (!module) {
    module = import(/* @vite-ignore */ url);
    serverModules.set(url, module);
  }
  return module;
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

/**
 * The frameworks a project actually uses, so unused renderers are never loaded.
 * A framework is in use when a project file or a rendered component has one of
 * its extensions.
 */
export function frameworksInUse(
  frameworks: FrameworkConfig[],
  files: Record<string, string> | undefined,
  components: HydratedComponent[],
): FrameworkConfig[] {
  const extensions = new Set<string>([
    ...Object.keys(files ?? {}).map(extensionOf),
    ...components.map((component) => extensionOf(component.resolvedPath || component.specifier)),
  ]);
  const used = frameworks.filter((framework) =>
    (framework.extensions ?? []).some((extension) => extensions.has(extension)),
  );
  if (used.length > 0) return used;
  return frameworks.length === 1 ? frameworks : [];
}

/**
 * Registers a server renderer (and, when configured, a client entrypoint) for
 * each framework. Registration order matches `frameworks`; Astro picks the first
 * renderer whose `check` accepts the component.
 */
export async function registerRenderers(
  container: { addServerRenderer: (options: { renderer: unknown; name?: string }) => void; addClientRenderer: (options: { name: string; entrypoint: string }) => void },
  frameworks: FrameworkConfig[],
): Promise<void> {
  for (const framework of frameworks) {
    const module = await loadServerModule(framework.server);
    const renderer = module.default ?? (module as ServerRenderer);
    if (!renderer?.check || !renderer?.renderToStaticMarkup) {
      throw new Error(
        `The server renderer at "${framework.server}" is invalid: it must expose "check" and "renderToStaticMarkup".`,
      );
    }
    container.addServerRenderer({ renderer, name: framework.name });
    if (framework.client) {
      container.addClientRenderer({
        name: renderer.name ?? framework.name,
        entrypoint: framework.client,
      });
    }
  }
}
