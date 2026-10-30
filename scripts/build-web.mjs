import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateWebBuildConfig } from './build-config.mjs';

try { validateWebBuildConfig(process.env); }
catch (error) { console.error(error.message); process.exit(2); }
const root = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, EXPO_NO_DOTENV: '1' },
});
if (result.error) { console.error('Web export could not start.'); process.exit(1); }
process.exit(result.status ?? 1);
