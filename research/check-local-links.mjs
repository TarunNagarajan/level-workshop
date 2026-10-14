import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const files = ['research/counterfactual-handoff-contracts.md', 'research/sandbox-integration.md'];
let checked = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    assert(existsSync(resolve(dirname(file), decodeURIComponent(target))), `${file}: missing ${target}`);
    checked++;
  }
}
console.log(JSON.stringify({ files: files.length, localLinksChecked: checked }));
