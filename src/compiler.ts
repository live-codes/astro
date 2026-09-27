/**
 * Browser-side Astro compiler + renderer glue.
 *
 * Bundled as an IIFE exposing a `astroCompiler` global, so it can be pulled into
 * a worker with `importScripts()` (the way LiveCodes loads in-browser compilers).
 *
 * Usage:
 *   await astroCompiler.initialize({ wasmURL: '<astro.wasm url>' });
 *   const { code, info } = await astroCompiler.renderAstroToHTML(source, {
 *     runtimeURL: '<astro-runtime.js url>',
 *   });
 *
 * Rendering is fully client-side. Framework islands work when the matching
 * framework integrations are passed as `frameworks`; see {@link FrameworkConfig}.
 */

import * as compiler from '@astrojs/compiler';
import type { HydratedComponent } from '@astrojs/compiler/types';
import {
  createModuleGraph,
  findImportMapKey,
  normalizePath,
  type CompileModule,
  type ModuleGraphResult,
} from './modules.js';
import { frameworksInUse, registerRenderers, type FrameworkConfig } from './renderers.js';

const { parse, transform } = compiler;

/**
 * `initialize` only exists in the browser build — which is what this package
 * bundles for — so `@astrojs/compiler`'s Node type entry omits it.
 */
const initializeCompiler = (
  compiler as typeof compiler & { initialize: (options: { wasmURL: string }) => Promise<void> }
).initialize;

export { parse, transform };
export type { CompileModule, FrameworkConfig, HydratedComponent };

export interface InitializeOptions {
  /** URL of `astro.wasm` (shipped in this package as `astro.wasm`). */
  wasmURL: string;
}

export interface RenderOptions extends Partial<InitializeOptions> {
  /** URL of the browser runtime module (`astro-runtime.js`). Required. */
  runtimeURL: string;
  /** Source path used in diagnostics and as the component module id. */
  filename?: string;
  /** Forwarded to the container; `true` returns a fragment, `false` a whole document. */
  partial?: boolean;
  /** Other project files, by canonical path, e.g. `{ 'src/components/Counter.jsx': '…' }`. */
  files?: Record<string, string>;
  /** Framework integrations to load on demand, e.g. React for `.jsx`. */
  frameworks?: FrameworkConfig[];
  /**
   * Bare-specifier → URL map. Framework runtime imports are left to this map, so
   * the renderer, the components and the client all share one instance. It is
   * also injected into the output as the document's import map.
   */
  imports?: Record<string, string>;
  /** Compiles non-`.astro` files; defaults to sucrase for JS/JSX/TS/TSX. */
  compileModule?: CompileModule;
}

export interface RenderResult {
  /** Rendered HTML (document with scoped `<style>` and hydration scripts injected). */
  code: string;
  info: {
    errors: string[];
    css: string[];
    /** Ids of the hoisted inline scripts inlined into the render. */
    scripts: string[];
  };
}

const DEFAULT_FILENAME = 'src/pages/index.astro';

let compilerReady: Promise<void> | null = null;

/** Initializes the WASM compiler. Safe to call repeatedly. */
export function initialize(options: InitializeOptions): Promise<void> {
  if (!options?.wasmURL) {
    throw new Error('astroCompiler.initialize requires a "wasmURL" option.');
  }
  compilerReady ??= initializeCompiler({ wasmURL: options.wasmURL });
  return compilerReady;
}

/**
 * Compiles `.astro` source and renders it to HTML, entirely in the browser.
 */
export async function renderAstroToHTML(
  code: string,
  options: RenderOptions,
): Promise<RenderResult> {
  if (!options?.runtimeURL) {
    throw new Error('renderAstroToHTML requires a "runtimeURL" option.');
  }
  if (options.wasmURL) {
    await initialize({ wasmURL: options.wasmURL });
  }
  if (!compilerReady) {
    throw new Error('renderAstroToHTML requires initialize({ wasmURL }) to be called first.');
  }
  await compilerReady;

  const filename = normalizePath(options.filename ?? DEFAULT_FILENAME);
  const frameworks = options.frameworks ?? [];
  const graph = createModuleGraph({
    files: options.files,
    runtimeURL: options.runtimeURL,
    compileModule: options.compileModule,
    imports: options.imports,
    jsxImportSource: Object.fromEntries(
      frameworks.flatMap((framework) =>
        (framework.extensions ?? []).map((extension) => [extension, framework.jsxImportSource ?? 'react']),
      ),
    ),
  });
  graph.addFile(filename, code);

  let built: ModuleGraphResult;
  let factory: any;
  try {
    built = await graph.build(filename);
    const entryUrl = built.urls.get(filename);
    if (!entryUrl) throw new Error(`The compiler produced no module for "${filename}".`);
    factory = (await importModule(entryUrl))?.default;
    if (!factory?.isAstroComponentFactory) {
      throw new Error('The compiler output did not export an Astro component factory.');
    }
  } catch (error) {
    // Covers module resolution/compilation and parse errors in the emitted
    // modules: Astro's compiler does not validate frontmatter JavaScript.
    return { code: '', info: { errors: [toMessage(error)], css: [], scripts: [] } };
  }

  const containerModule = await importModule(options.runtimeURL);
  const { experimental_AstroContainer: AstroContainer } = containerModule;

  const container = await AstroContainer.create({
    manifest: createManifest(factory, built),
    resolve: (specifier: string) => resolveRendered(specifier, built, options.imports),
  });
  await registerRenderers(
    container,
    frameworksInUse(frameworks, options.files, built.components),
  );

  const response = await container.renderToResponse(factory, {
    request: new Request('https://astro.local/'),
    partial: options.partial ?? true,
  });
  const html = await response.text();

  return {
    code: wrapDocument(html, built.css, options.imports),
    info: { errors: [], css: built.css, scripts: [...built.scripts.keys()] },
  };
}

/** Alias for {@link renderAstroToHTML}. */
export const compile = renderAstroToHTML;

/**
 * Resolves the specifiers Astro asks about while rendering an island:
 * the component's path and the `before-hydration` script. Returning `''` omits
 * the latter (this package has no such script). Anything unknown is passed
 * through, which keeps URLs and bare specifiers intact.
 */
function resolveRendered(
  specifier: string,
  built: ModuleGraphResult,
  imports: Record<string, string> | undefined,
): string {
  if (specifier === 'astro:scripts/before-hydration.js') return '';
  const compiled = built.urls.get(specifier);
  if (compiled) return compiled;
  const key = imports && findImportMapKey(specifier, imports);
  return key ? specifier.replace(key, imports![key]) : specifier;
}

function createManifest(factory: any, built: ModuleGraphResult) {
  const metadata = built.metadata.get(built.entry);
  return {
    componentMetadata: new Map([
      [
        factory.moduleId ?? built.entry,
        {
          containsHead: !!metadata?.containsHead,
          propagation: metadata?.propagation ? 'self' : 'none',
        },
      ],
    ]),
    inlinedScripts: built.scripts,
  };
}

async function importModule(url: string): Promise<any> {
  const isInlineCode = !/^(https?:|data:|blob:)/.test(url);
  if (!isInlineCode) return import(/* @vite-ignore */ url);
  const blobUrl = URL.createObjectURL(new Blob([url], { type: 'text/javascript' }));
  try {
    return await import(/* @vite-ignore */ blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function wrapDocument(
  html: string,
  css: string[],
  imports: Record<string, string> | undefined,
): string {
  const styleTag = css.length > 0 ? `<style>${css.join('\n')}</style>` : '';
  // The import map must precede any module load; islands resolve framework
  // runtimes from it in the browser.
  const importMapTag =
    imports && Object.keys(imports).length > 0
      ? `<script type="importmap">${JSON.stringify({ imports }).replace(/</g, '\\u003c')}</script>`
      : '';
  const head = importMapTag + styleTag;

  if (/<html[\s>]/i.test(html)) {
    let out = /<!doctype/i.test(html) ? html : `<!doctype html>\n${html}`;
    if (head) {
      out = /<\/head>/i.test(out)
        ? out.replace(/<\/head>/i, `${head}</head>`)
        : out.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
    }
    return out;
  }
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
