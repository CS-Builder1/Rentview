import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWebBuildConfig } from '../scripts/build-config.mjs';

const publicConfig = {
  EXPO_PUBLIC_SUPABASE_URL: 'https://fixture.supabase.co',
  EXPO_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_fixture',
  EXPO_PUBLIC_APP_URL: 'https://rentview.example',
};
test('deployable web builds fail before export when target configuration is missing', () => {
  for (const name of Object.keys(publicConfig)) {
    assert.throws(() => validateWebBuildConfig({ ...publicConfig, [name]: '' }), new RegExp(name));
  }
  assert.doesNotThrow(() => validateWebBuildConfig(publicConfig));
  assert.doesNotThrow(() => validateWebBuildConfig({ ...publicConfig, EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', EXPO_PUBLIC_APP_URL: 'http://localhost:8081' }));
});
test('build settings reject invalid origins and secret keys without echoing values', () => {
  for (const url of ['http://fixture.example', 'https://user:secret@fixture.example', 'https://fixture.example/path', 'https://fixture.example?secret=value']) {
    assert.throws(() => validateWebBuildConfig({ ...publicConfig, EXPO_PUBLIC_SUPABASE_URL: url }), /must be an HTTPS origin/);
  }
  const jwt = (role: string) => `fixture.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.fixture`;
  assert.doesNotThrow(() => validateWebBuildConfig({ ...publicConfig, EXPO_PUBLIC_SUPABASE_ANON_KEY: jwt('anon') }));
  for (const key of ['sb_secret_fixture', jwt('service_role'), 'placeholder']) {
    assert.throws(() => validateWebBuildConfig({ ...publicConfig, EXPO_PUBLIC_SUPABASE_ANON_KEY: key }), error => error instanceof Error && !error.message.includes(key));
  }
});
