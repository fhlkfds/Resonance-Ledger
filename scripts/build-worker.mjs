/**
 * Bundles the synchronization worker and its health probe.
 *
 * The output is ESM so the worker can use top-level await. Dependencies are
 * bundled in rather than left external, because the Next.js standalone tree
 * the runtime image ships only traces what the web app imports.
 *
 * Prisma stays external: it loads a platform-specific native query engine that
 * cannot be bundled, and the standalone tree already provides it.
 */
import { build } from 'esbuild';

// Several bundled dependencies (pino among them) are CommonJS and call
// require() at load time. In an ESM bundle esbuild's shim would throw, so a
// real require is reconstructed from the module URL.
const banner = [
  "import { createRequire as __createRequire } from 'node:module';",
  'const require = __createRequire(import.meta.url);',
].join('');

await build({
  entryPoints: [
    'src/worker/index.ts',
    'src/worker/healthcheck.ts',
    // Operator-run, one-shot; see docs/runbooks/token-key-rotation.md.
    'src/worker/rotate-keys.ts',
  ],
  outdir: 'dist/worker',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: { js: banner },
  external: ['@prisma/client', '.prisma', '.prisma/client'],
  logLevel: 'info',
});
