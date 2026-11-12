// Builds the admin page into static/admin (what Forge uploads).
// `node scripts/build.mjs --dev` builds it with the stand-in for Jira and serves it on :4340.
import { build, context } from 'esbuild';
import { copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const outdir = resolve(root, dev ? '.dev' : 'static/admin');

const options = {
  entryPoints: { app: resolve(root, 'ui/main.jsx') },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !dev,
  jsx: 'automatic',
  outdir,
  loader: { '.css': 'css' },
  define: {
    DEV_STANDIN: String(dev),
    APP_VERSION: JSON.stringify(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version),
    'process.env.NODE_ENV': dev ? '"development"' : '"production"',
  },
  logLevel: 'info',
};

if (dev) {
  const { cpSync, mkdirSync } = await import('node:fs');
  mkdirSync(outdir, { recursive: true });
  cpSync(resolve(root, 'static/admin/samples'), resolve(outdir, 'samples'), { recursive: true });
  copyFileSync(resolve(root, 'ui/index.html'), resolve(outdir, 'index.html'));
  const ctx = await context({ ...options, entryPoints: { app: resolve(root, 'ui/main.jsx'), styles: resolve(root, 'ui/styles.css') } });
  await ctx.rebuild();
  copyFileSync(resolve(outdir, 'styles.css'), resolve(outdir, 'app.css'));
  const { port } = await ctx.serve({ servedir: outdir, port: 4340, host: '127.0.0.1' });
  console.log(`admin page with the Jira stand-in: http://127.0.0.1:${port}`);
} else {
  await build(options);
  await build({ entryPoints: [resolve(root, 'ui/styles.css')], bundle: true, minify: true, outfile: resolve(outdir, 'app.css'), logLevel: 'warning' });
  copyFileSync(resolve(root, 'ui/index.html'), resolve(outdir, 'index.html'));
}
