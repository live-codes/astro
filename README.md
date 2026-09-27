# @live-codes/astro

Astro compiler and renderer that run **entirely in the browser** — no server. Built for
[LiveCodes](https://github.com/live-codes/livecodes).

This is an experimental proof of concept. It compiles `.astro` source with Astro's WASM compiler
(`@astrojs/compiler`) and renders the result to HTML with Astro's own SSR runtime
(`astro/runtime/server` + `astro/container`), all client-side.

It supports **multi-file projects**, nested `.astro` components, and **framework islands**
(`client:load` / `client:only`), currently for React.

## Build

```sh
npm install
npm run build      # also: npm run typecheck
```

Output in `dist/`:

| File                          | Format | Purpose                                                                 |
| ----------------------------- | ------ | ----------------------------------------------------------------------- |
| `astro-compiler.js`           | IIFE   | The glue. Exposes an `astroCompiler` global (load with `importScripts`). |
| `astro-runtime.js`            | ESM    | Astro SSR runtime + container. Used as the compiler's `internalURL`.     |
| `astro-react-server.js`       | ESM    | `@astrojs/react` server renderer (+ chunks).                             |
| `astro-react-client.js`       | ESM    | `@astrojs/react` client entrypoint that hydrates islands.                |
| `astro.wasm`                  | WASM   | Astro's compiler, fetched at runtime.                                    |

## API

```js
// classic worker / script: importScripts('<url>/astro-compiler.js')
await astroCompiler.initialize({ wasmURL: '<url>/astro.wasm' });

const { code, info } = await astroCompiler.renderAstroToHTML(astroSource, {
  runtimeURL: '<url>/astro-runtime.js',
  filename: 'src/pages/index.astro', // optional
  partial: true,                     // optional; `false` returns a whole document

  // Other project files, by path. Imports of these are resolved by the compiler.
  files: {
    'src/components/Counter.jsx': '…',
    'src/components/Badge.astro': '…',
  },

  // Framework integrations, loaded on demand — only the ones a project uses.
  frameworks: [
    {
      name: '@astrojs/react',
      server: '<url>/astro-react-server.js',
      client: '<url>/astro-react-client.js',
      extensions: ['.jsx', '.tsx'],
      jsxImportSource: 'react',
    },
  ],

  // Bare specifiers → URLs. Used to resolve runtime imports and injected into the
  // output as the document's import map, so the host and the preview agree.
  imports: {
    react: 'https://esm.sh/react@19.3.0',
    'react/': 'https://esm.sh/react@19.3.0/',
    'react-dom': 'https://esm.sh/react-dom@19.3.0',
    'react-dom/': 'https://esm.sh/react-dom@19.3.0/',
  },

  // Optional: compile non-`.astro` files yourself (defaults to sucrase).
  // compileModule: (source, { filename, language, jsxImportSource }) => ({ code }),
});
// code -> HTML (document with scoped <style>, islands and hydration scripts)
// info -> { errors, css, scripts }
```

Also exported: `transform`, `parse` (re-exported from `@astrojs/compiler`), and `compile`
(alias of `renderAstroToHTML`).

### Framework runtimes are not bundled

`frameworks[].server` gets `react`, `react-dom` … as **bare imports**. They are resolved by the
host's import map (and by the `imports` map injected into the output), so the renderer, the
compiled components and the client hydration all share **one instance**. Bundling React into the
renderer instead would give you two copies — `renderer.check` mismatches and invalid hook calls.

## How it works

```
.astro source
  │  astroCompiler.initialize({ wasmURL })        ── @astrojs/compiler (Go + WASM)
  │  transform(source, { internalURL, resolvePath })  ──> { code, css[], diagnostics[], … }
  │     └─ each imported project file is compiled too and rewritten to a data: URL
  │  import(entry data URL)                       ──> AstroComponentFactory
  │  import(runtimeURL)                           ──> experimental_AstroContainer
  │  container.addServerRenderer(…) / addClientRenderer(…)
  │  container.renderToResponse(factory)          ──> HTML
  │     └─ islands resolve component-url / renderer-url through the container's `resolve`
  └─ wrap in a document (css + import map)
```

Three things worth knowing:

- **One runtime module.** `astro-runtime.js` bundles both the SSR runtime and the container, and is
  used as the compiler's `internalURL`. The compiled component and the container must share a single
  module instance, otherwise checks like `isAstroComponentFactory` fail across them.
- **`createMetadata` shim.** `@astrojs/compiler` emits `import { createMetadata } from <internalURL>`
  (for its `$$metadata` export), but no Astro runtime (2.x–7.x) exports it — it is a build-time
  helper that Astro's pipeline consumes, not something SSR needs. `astro-runtime.js` provides it so
  the compiler output is importable; it does not affect rendering.
- **Module graph, not a bundler.** Astro's compiler leaves the user's `import`s untouched, and the
  compiled page is loaded from a `data:` URL, where `./Counter.jsx` cannot resolve. So every
  relative import is compiled and rewritten to a `data:` URL of the dependency (`.astro` via
  `transform`, JS/JSX/TS/TSX via sucrase, CSS as a module). Bare specifiers are left alone and
  resolved by the import map. `imports` is applied to both, so they cannot drift apart.

### Islands

Astro's container already inlines everything a browser needs to hydrate — the `astro-island`
custom element, the `client:*` directive scripts, and the island styles. The only missing pieces are
the framework's **server renderer** (so the container will accept the component and can
`renderToStaticMarkup` it) and its **client entrypoint** (the module the island imports to hydrate).
Those are exactly `frameworks[].server` and `frameworks[].client`.

## Dev harness

`index.html` (served statically) is a multi-file editor + iframe preview that uses the built `dist/`
directly — a page, a nested `.astro` component, and a React island.

```sh
npx serve .        # then open http://localhost:3000
```

Serve it with a plain static server. Some dev servers inject a live-reload snippet before the first
`</body>` in the response — and that string also appears inside the harness's page source, which
breaks the inline script.

## Using it in LiveCodes

The glue is shaped to drop into the existing Astro language integration:

- publish this package, then point `compiler.url` in
  `livecodes/src/livecodes/languages/astro/lang-astro.ts` at the CDN path of `astro-compiler.js`;
- call `astroCompiler.renderAstroToHTML(code, { runtimeURL, files, frameworks, imports, filename })`
  with `files` from the project, `frameworks` pointing at the vendored renderer bundles, and
  `imports` from `config.imports` / the modules service;
- add the runtime, renderer and wasm URLs to `livecodes/src/livecodes/vendors.ts`.
- pass `compileModule` to delegate JSX/TS/Vue/Svelte compilation to LiveCodes' own compilers
  (`compileInCompiler`) instead of the bundled sucrase.

Note that the host running SSR needs the same framework runtimes as the preview (an import map, or
`compileModule` rewriting specifiers), since the renderer and the components must share one instance.

This replaces the current stack (`@astrojs/compiler@0.9.2` + the vendored Astro 0.22 runtime in
`@hatemhosny/astro-internal`).

## Not yet supported

- Frameworks other than React — Vue, Svelte, Solid and Preact need the same server/client bundle pair
- npm imports without an import map
- Circular imports between modules (detected and reported, not resolved)
- External `<script src>` in components

`client:load`, `client:only`, `client:idle`, `client:visible` and `client:media` all work: Astro's
container inlines its own directive scripts and island styles, so they behave as they do in Astro.
One caveat on `client:visible`: `rootMargin` has no effect for the implicit root inside an iframe —
the browser clips the root rect to the frame's viewport — so in an iframe-hosted preview (which is
how results render) it degrades to plain `client:visible`. Verified against a bare
`IntersectionObserver`, so it is browser behaviour rather than something this package can fix.

## License

MIT. Third-party licenses belong to [Astro](https://github.com/withastro/astro) and
[`@astrojs/compiler`](https://github.com/withastro/compiler).
