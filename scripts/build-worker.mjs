import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';

// Bundled CommonJS dependencies still load Node built-ins in the ESM Worker.
await build({ entryPoints: ['server/worker.mjs'], outfile: 'dist/server/index.js', bundle: true, format: 'esm', platform: 'node', target: 'es2022', external: ['cloudflare:*', 'node:*'], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/index.js');" }, minify: true });
mkdirSync('dist/.openai', { recursive: true });
copyFileSync('.openai/hosting.json', 'dist/.openai/hosting.json');
writeFileSync('dist/server/wrangler.json', JSON.stringify({
  name: 'level-workshop', main: 'index.js', compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'],
  assets: { directory: '../client', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true },
  d1_databases: [{ binding: 'DB', database_name: 'workshop', database_id: 'local-workshop' }],
}, null, 2));
