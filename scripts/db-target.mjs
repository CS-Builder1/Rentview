/** Validate before invoking a database process; never include credentials in errors.
 * @param {string | undefined} raw
 * @param {string | undefined} confirmed
 */
export function disposableDatabaseTarget(raw, confirmed) {
  if (!raw || confirmed !== '1') throw new Error('Database tests require RENTVIEW_DISPOSABLE_DATABASE=1 and RENTVIEW_TEST_DATABASE_URL for a disposable local Supabase database. No database was contacted.');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Invalid test database URL. No database was contacted.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.search || parsed.hash) throw new Error('Refusing a non-loopback database or connection overrides. No database was contacted.');
  return raw;
}
