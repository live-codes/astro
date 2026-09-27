import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { polyfillNode } from 'esbuild-plugin-polyfill-node';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const base = {
  bundle: true,
  minify: true,
  platform: 'browser',
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'info',
  define: {
    global: 'globalThis',
    'process.env.NODE_ENV': '"production"',
    __dirname: '""',
    __filename: '""',
  },
};

const nodePolyfills = [
  polyfillNode({
    // Astro's container pulls in a few core modules (path, crypto, ...).
    polyfills: {
      fs: true,
      'fs/promises': true,
    },
  }),
];

// Framework runtimes are never bundled: the renderer, the user's components and
// the client must all import the same instance, which the import map supplies.
const frameworkExternals = ['react', 'react/*', 'react-dom', 'react-dom/*'];

/** Resolves virtual modules that Astro integrations normally get from Vite. */
const astroVirtualModules = {
  name: 'astro-virtual-modules',
  setup(build) {
    build.onResolve({ filter: /^astro:react:opts$/ }, () => ({
      path: resolve(root, 'scripts/entries/react-opts.js'),
    }));
  },
};

/**
 * Builds one framework integration into the two modules the compiler asks for:
 * the server renderer and the client entrypoint that hydrates islands.
 */
async function buildFramework(name, { server, client }) {
  const shared = {
    ...base,
    outdir: dist,
    format: 'esm',
    splitting: true,
    external: frameworkExternals,
    plugins: [astroVirtualModules],
  };

  await esbuild.build({
    ...shared,
    entryPoints: [resolve(root, server)],
    entryNames: `astro-${name}-server`,
    chunkNames: `astro-${name}-server-chunk-[hash]`,
  });

  await esbuild.build({
    ...shared,
    entryPoints: [resolve(root, client)],
    entryNames: `astro-${name}-client`,
    chunkNames: `astro-${name}-client-chunk-[hash]`,
  });
}

async function build() {
  // The runtime module. Imported by compiled components (as `internalURL`) and by
  // the compiler bundle to obtain the container, so both share one module instance.
  await esbuild.build({
    ...base,
    entryPoints: [resolve(root, 'src/runtime.ts')],
    outfile: resolve(dist, 'astro-runtime.js'),
    format: 'esm',
    plugins: nodePolyfills,
  });

  // The compiler glue, exposed as `self.astroCompiler` for `importScripts()`.
  await esbuild.build({
    ...base,
    entryPoints: [resolve(root, 'src/compiler.ts')],
    outfile: resolve(dist, 'astro-compiler.js'),
    format: 'iife',
    globalName: 'astroCompiler',
  });

  await buildFramework('react', {
    server: 'scripts/entries/react-server.js',
    client: 'scripts/entries/react-client.js',
  });

  // The compiler WASM is fetched at runtime; ship it alongside.
  copyFileSync(
    resolve(root, 'node_modules/@astrojs/compiler/dist/astro.wasm'),
    resolve(dist, 'astro.wasm'),
  );
}

build().catch(() => process.exit(1));
