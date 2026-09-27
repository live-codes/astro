/**
 * Browser-side module graph for Astro projects.
 *
 * Astro's compiler leaves the user's `import`s untouched, and this package loads
 * the compiled page from a `data:` URL, where a bare `./Counter.jsx` specifier
 * cannot be resolved. This module compiles the project's files and rewrites each
 * relative import to a `data:` URL of the compiled dependency — the bundler-free
 * equivalent of what Vite does, so multi-file projects and framework islands work
 * without a dev server.
 *
 * - `.astro` files are compiled here, with Astro's own `transform` and a
 *   `resolvePath` bound to the file, so island metadata carries canonical paths.
 * - every other language is compiled by the injected {@link CompileModule}
 *   (JS/JSX/TS/TSX via sucrase by default). LiveCodes can inject a compiler that
 *   delegates to its own language compilers.
 * - bare (npm) specifiers are left alone: they are resolved by the host's import
 *   map, or remapped through `imports`.
 */
import { transform } from '@astrojs/compiler';
import type { HydratedComponent } from '@astrojs/compiler/types';
import * as sucrase from 'sucrase';

export type ModuleLanguage = 'astro' | 'javascript' | 'jsx' | 'typescript' | 'tsx' | 'css';

export interface CompileContext {
  /** Canonical project path, e.g. `src/components/Counter.jsx`. */
  filename: string;
  language: ModuleLanguage;
  /** Import source for the JSX runtime, e.g. `react`. */
  jsxImportSource?: string;
}

export interface CompiledModule {
  code: string;
  css?: string[];
}

export type CompileModule = (
  source: string,
  context: CompileContext,
) => CompiledModule | Promise<CompiledModule>;

export interface ModuleGraphOptions {
  /** Project files by canonical path, e.g. `{ 'src/components/Counter.jsx': '…' }`. */
  files?: Record<string, string>;
  /** Used as the compiler's `internalURL`; must be importable from the host. */
  runtimeURL: string;
  /** Compiles non-`.astro` files. Defaults to sucrase for JS/JSX/TS/TSX. */
  compileModule?: CompileModule;
  /** Bare-specifier overrides, e.g. `{ react: 'https://esm.sh/react@19' }`. */
  imports?: Record<string, string>;
  /** JSX runtime import source per extension, e.g. `{ '.jsx': 'react' }`. */
  jsxImportSource?: Record<string, string>;
}

export interface ModuleGraphResult {
  /** Canonical path of the entry module. */
  entry: string;
  /** Compiled module as a `data:` URL, by canonical path. */
  urls: Map<string, string>;
  /** CSS collected from every compiled `.astro` module, in document order. */
  css: string[];
  /** Hoisted inline scripts from every `.astro` module, by script id. */
  scripts: Map<string, string>;
  /** Component metadata used for head rendering, by canonical path. */
  metadata: Map<string, { containsHead: boolean; propagation: boolean }>;
  /** Every hydrated / client-only / server component found across the project. */
  components: HydratedComponent[];
}

const EXTENSIONS = ['.js', '.mjs', '.jsx', '.ts', '.mts', '.tsx', '.astro', '.css'];

const LANGUAGE_BY_EXTENSION: Record<string, ModuleLanguage> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.tsx': 'tsx',
  '.astro': 'astro',
  '.css': 'css',
};

// Virtual style imports emitted by the Astro compiler; the CSS is returned
// separately in `result.css`.
export const STYLE_IMPORT =
  /^import\s+["'](?:[^"'\\]|\\.)*\?astro&type=style&(?:[^"'\\]|\\.)*["'];?\s*$/gm;
// Hoisted `<script>` becomes `$$renderScript($$result, "<id>")` in the output.
const SCRIPT_ID = /\$\$renderScript\(\$\$result,\s*("(?:\\.|[^"\\])*")\s*\)/g;

// Import/export specifier scanning. Same shapes LiveCodes uses for its import map.
const STATIC_FROM = /((?:import|export)\s+?(?:(?:(?:[\w*\s{},$]*)\s+from\s+?)|))((?:".*?")|(?:'.*?'))/g;
const DYNAMIC_IMPORT = /(import\s*?\(\s*?)((?:".*?")|(?:'.*?'))(\s*?\))/g;

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export const extensionOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
};

export const isBareSpecifier = (specifier: string): boolean =>
  !SCHEME.test(specifier) && !specifier.startsWith('.') && !specifier.startsWith('/');

/** Finds the import-map key covering `specifier` (exact match or path prefix). */
export function findImportMapKey(
  specifier: string,
  imports: Record<string, string>,
): string | undefined {
  return Object.keys(imports).find(
    (key) => key === specifier || specifier.startsWith(`${key}/`),
  );
}

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function candidates(path: string): string[] {
  return [
    path,
    ...EXTENSIONS.map((ext) => path + ext),
    ...EXTENSIONS.map((ext) => `${path}/index${ext}`),
  ];
}

/**
 * Resolves a specifier as written to a canonical project path, applying
 * extension/index lookup against the known files. Anything that is not a
 * relative or root-relative path (URLs, bare specifiers) is returned unchanged.
 */
function resolveSpecifier(
  specifier: string,
  importer: string,
  files: Map<string, string>,
): string {
  if (SCHEME.test(specifier) || isBareSpecifier(specifier)) return specifier;
  const base = specifier.startsWith('/')
    ? specifier
    : `${importer.slice(0, importer.lastIndexOf('/') + 1)}${specifier}`;
  const normalized = normalizePath(base);
  return candidates(normalized).find((candidate) => files.has(candidate)) ?? normalized;
}

function toDataUrl(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:text/javascript;base64,${btoa(binary)}`;
}

/** The quoted specifier and its offset for every import/export in `code`. */
function findSpecifiers(code: string): Array<{ value: string; start: number }> {
  const found: Array<{ value: string; start: number }> = [];
  for (const pattern of [STATIC_FROM, DYNAMIC_IMPORT]) {
    for (const match of code.matchAll(new RegExp(pattern.source, 'g'))) {
      const quoted = match[2];
      found.push({
        value: quoted.slice(1, -1),
        start: match.index + match[0].indexOf(quoted),
      });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Replaces the quoted specifier of every import/export listed in `urls`. */
function replaceSpecifiers(code: string, urls: Map<string, string>): string {
  let out = '';
  let last = 0;
  for (const { value, start } of findSpecifiers(code)) {
    const url = urls.get(value);
    if (!url || start < last) continue;
    out += code.slice(last, start) + JSON.stringify(url);
    last = start + value.length + 2;
  }
  return out + code.slice(last);
}

/** Default compiler for JS/JSX/TS/TSX/CSS. */
export const defaultCompileModule: CompileModule = (source, { language, jsxImportSource }) => {
  const importSource = jsxImportSource ?? 'react';
  switch (language) {
    case 'css':
      return { code: `export default ${JSON.stringify(source)};` };
    case 'typescript':
      return {
        code: sucrase.transform(source, {
          transforms: ['typescript'],
          production: true,
        }).code,
      };
    case 'jsx':
      return {
        code: sucrase.transform(source, {
          transforms: ['jsx'],
          jsxRuntime: 'automatic',
          jsxImportSource: importSource,
          production: true,
        }).code,
      };
    case 'tsx':
      return {
        code: sucrase.transform(source, {
          transforms: ['jsx', 'typescript'],
          jsxRuntime: 'automatic',
          jsxImportSource: importSource,
          production: true,
        }).code,
      };
    default:
      return { code: source };
  }
};

export interface ModuleGraph {
  /** Registers (or replaces) a project file. */
  addFile(path: string, source: string): void;
  /** Compiles `entry` and everything it imports. */
  build(entry: string): Promise<ModuleGraphResult>;
}

export function createModuleGraph(options: ModuleGraphOptions): ModuleGraph {
  const files = new Map<string, string>(
    Object.entries(options.files ?? {}).map(([path, source]) => [normalizePath(path), source]),
  );
  const compile = options.compileModule ?? defaultCompileModule;
  const pending = new Map<string, Promise<string>>();
  const result: ModuleGraphResult = {
    entry: '',
    urls: new Map(),
    css: [],
    scripts: new Map(),
    metadata: new Map(),
    components: [],
  };

  async function compileAstro(path: string, source: string): Promise<string> {
    const out = await transform(source, {
      filename: path,
      internalURL: options.runtimeURL,
      resolvePath: async (specifier) => resolveSpecifier(specifier, path, files),
    });

    const errors = (out.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 1);
    if (errors.length > 0) {
      const [first] = errors;
      const loc = first.location;
      throw new Error(
        loc ? `${loc.file}:${loc.line}:${loc.column} ${first.text}` : first.text,
      );
    }

    if (out.css?.length) result.css.push(...out.css);
    result.metadata.set(path, {
      containsHead: !!out.containsHead,
      propagation: !!out.propagation,
    });
    result.components.push(
      ...(out.hydratedComponents ?? []),
      ...(out.clientOnlyComponents ?? []),
      ...(out.serverComponents ?? []),
    );

    const code = out.code.replace(STYLE_IMPORT, '');
    const ids = Array.from(code.matchAll(SCRIPT_ID), (match) => JSON.parse(match[1]) as string);
    if (out.scripts?.length) {
      if (ids.length !== out.scripts.length) {
        throw new Error('The compiler emitted script metadata this build cannot handle.');
      }
      out.scripts.forEach((script, index) => {
        if (script.type !== 'inline') {
          throw new Error('External <script src> is not supported.');
        }
        result.scripts.set(ids[index], script.code ?? '');
      });
    }
    return code;
  }

  async function compileModule(path: string, source: string): Promise<string> {
    const extension = extensionOf(path);
    const language = LANGUAGE_BY_EXTENSION[extension] ?? 'javascript';
    if (language === 'astro') return compileAstro(path, source);
    const compiled = await compile(source, {
      filename: path,
      language,
      jsxImportSource: options.jsxImportSource?.[extension],
    });
    if (compiled.css?.length) result.css.push(...compiled.css);
    return compiled.code;
  }

  async function urlFor(path: string, stack: string[]): Promise<string> {
    if (stack.includes(path)) {
      throw new Error(
        `Circular dependency between modules is not supported: ${[...stack, path].join(' → ')}`,
      );
    }
    const cached = pending.get(path);
    if (cached) return cached;

    const promise = (async () => {
      const source = files.get(path);
      if (source === undefined) throw new Error(`Module not found: ${path}`);
      let code = await compileModule(path, source);
      code = await rewriteImports(code, path, [...stack, path]);
      const url = toDataUrl(code);
      result.urls.set(path, url);
      return url;
    })().catch((error) => {
      pending.delete(path);
      throw error;
    });

    pending.set(path, promise);
    return promise;
  }

  async function rewriteImports(code: string, path: string, stack: string[]): Promise<string> {
    const specifiers = new Set(
      findSpecifiers(code)
        .map(({ value }) => value)
        .filter((value) => !value.includes('?astro&type=style')),
    );

    const urls = new Map<string, string>();
    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(specifier, path, files);
      if (resolved === specifier) {
        const imports = options.imports;
        const key = imports && findImportMapKey(specifier, imports);
        if (key) urls.set(specifier, specifier.replace(key, imports[key]));
        continue;
      }
      urls.set(specifier, await urlFor(resolved, stack));
    }
    return urls.size > 0 ? replaceSpecifiers(code, urls) : code;
  }

  return {
    addFile(path, source) {
      files.set(normalizePath(path), source);
    },
    async build(entry) {
      const path = normalizePath(entry);
      result.entry = path;
      await urlFor(path, []);
      return result;
    },
  };
}
