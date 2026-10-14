import { cpSync, mkdirSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
// Vercel serves public assets directly; Express handles the API and SPA routes.
const workspace = resolve('.'), output = resolve(workspace, 'public');
if (dirname(output) !== workspace || (existsSync(output) && lstatSync(output).isSymbolicLink())) throw new Error('Unsafe public output path.');
if (existsSync(output)) rmSync(output, { recursive: true });
mkdirSync(output, { recursive: true });
cpSync('dist/client', output, { recursive: true });
