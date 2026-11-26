import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('The local test harness requires Node 24 or newer.');
const root = fileURLToPath(new URL('..', import.meta.url));
const files = process.argv.slice(2);
const selected = files.length ? files : readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.ts')).map(name => `tests/${name}`);
if (!selected.length) throw new Error('No unit tests found.');
const result = spawnSync(process.execPath, ['--import', './scripts/typescript-register.mjs', '--test', '--test-isolation=none', ...selected], { cwd: root, stdio: 'inherit', timeout: 120_000 });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
