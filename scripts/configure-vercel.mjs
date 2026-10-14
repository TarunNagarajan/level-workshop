import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

// Accept capability credentials through stdin, not process arguments or files.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const lines = createInterface({ input: process.stdin, terminal: false });
const input = await new Promise(resolve => lines.once('line', resolve));
lines.close();
const { ownerPath, sharePath } = JSON.parse(input);
const values = {
  WORKSHOP_OWNER_KEY: ownerPath.split('/').at(-1),
  WORKSHOP_SHARE_KEY: sharePath.split('/').at(-1),
  GROQ_API_KEY: process.env.GROQ_API_KEY,
};
for (const [name, value] of Object.entries(values)) {
  if (!value) throw new Error(`Missing ${name}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[2], 'env', 'add', name, 'production', '--sensitive', '--yes'], { stdio: ['pipe', 'pipe', 'pipe'] });
    // Do not echo CLI output that could contain a secret on an error.
    child.stdout.resume(); child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Could not configure ${name} (exit ${code})`)));
    child.stdin.end(value);
  });
  console.log(`Configured ${name}`);
}
