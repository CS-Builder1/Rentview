import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposableDatabaseTarget } from './db-target.mjs';

// Intentionally refuses hosted URLs. Use a disposable, migrated local Supabase DB.
let raw;
try { raw = disposableDatabaseTarget(process.env.RENTVIEW_TEST_DATABASE_URL, process.env.RENTVIEW_DISPOSABLE_DATABASE); }
catch (error) { console.error(error.message); process.exit(2); }
const version = spawnSync('psql', ['--version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) {
  console.error('PostgreSQL psql is unavailable. Database tests were not run.'); process.exit(2);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const env = { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', PGCONNECT_TIMEOUT: '5' };
for (const file of ['tests/db/trust.sql', 'tests/db/backend-services.sql', 'tests/db/numerics.sql', 'tests/db/tenant-projection.sql', 'tests/db/rls-performance.sql', 'tests/db/pg-net-boundary.sql']) {
  const result = spawnSync('psql', ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--dbname', raw, '--file', path.join(root, file)], { env, stdio: 'inherit', timeout: 60000 });
  if (result.error || result.status !== 0) {
    console.error('Local database regression failed or could not run; validation is incomplete.'); process.exit(result.status ?? 1);
  }
}
