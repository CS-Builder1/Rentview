/** Validate injected public settings before producing a deployable web bundle. */
export function validateWebBuildConfig(env) {
  const names = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY', 'EXPO_PUBLIC_APP_URL'];
  const missing = names.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Web build requires deployment environment variables: ${missing.join(', ')}. Configure them for the target environment before rebuilding; values are never read from a tracked .env file.`);
  for (const name of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_APP_URL']) {
    let url;
    try { url = new URL(env[name]); } catch { throw new Error(`Invalid ${name}.`); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!['http:', 'https:'].includes(url.protocol) || (!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error(`${name} must be an HTTPS origin (HTTP is allowed for loopback tests).`);
    }
  }
  const key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY.trim();
  if (key.startsWith('sb_publishable_') && key.length > 'sb_publishable_'.length) return;
  // Legacy anon JWTs remain valid public client keys. Decode only to reject
  // accidental service-role exposure; the backend still verifies signatures.
  try {
    const parts = key.split('.');
    if (parts.length !== 3 || JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role !== 'anon') throw new Error();
  } catch { throw new Error('EXPO_PUBLIC_SUPABASE_ANON_KEY must be a publishable or legacy anon key. Never expose a service-role/secret key.'); }
}
