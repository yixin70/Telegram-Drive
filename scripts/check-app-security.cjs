// Validate actual application configuration without a unit-test framework.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'app');
// These files are part of the release input, including the untracked Cargo
// configuration that enables FTS5 and the build-time SQLite capability probe.
for (const file of ['.cargo/config.toml', 'app/src-tauri/Cargo.toml', 'app/src-tauri/Cargo.lock', 'app/src-tauri/build.rs', 'app/src-tauri/build/search-support.rs']) {
  if (!fs.statSync(path.resolve(root, '..', file)).isFile()) throw new Error(`Missing release build input: ${file}`);
}
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const config = json('src-tauri/tauri.conf.json');
if (config.plugins?.shell?.open !== '(?:https?://[^\\s]+|mailto:[^\\s]+)') throw new Error('Shell URL scope must allow only HTTP, HTTPS and mailto.');
const csp = config.app?.security?.csp;
if (typeof csp !== 'string') throw new Error('A production WebView CSP is required.');
const directives = new Map(csp.split(';').map(value => value.trim()).filter(Boolean).map(value => {
  const [name, ...sources] = value.split(/\s+/);
  return [name, sources];
}));
const scripts = directives.get('script-src') || [];
if (!scripts.includes("'self'") || scripts.some(value => ["'unsafe-inline'", "'unsafe-eval'", '*'].includes(value))) {
  throw new Error('WebView scripts must be self-hosted without inline/eval/wildcard execution.');
}
for (const [name, expected] of [['object-src', "'none'"], ['base-uri', "'self'"], ['form-action', "'self'"]]) {
  const sources = directives.get(name);
  if (sources?.length !== 1 || sources[0] !== expected) throw new Error(`Invalid ${name} restriction.`);
}
const mobile = json('src-tauri/capabilities/mobile.json');
const desktop = json('src-tauri/capabilities/default.json');
if (mobile.platforms?.length !== 1 || mobile.platforms[0] !== 'android') {
  throw new Error('Mobile capabilities must remain restricted to Android.');
}
if (desktop.platforms?.length !== 3 || !['linux', 'macOS', 'windows'].every(value => desktop.platforms.includes(value))) {
  throw new Error('Desktop capabilities must remain restricted to desktop platforms.');
}
if (!desktop.permissions?.includes('updater:default')) throw new Error('Signed desktop updater permission is required.');
if (![mobile.identifier, desktop.identifier].every(value => config.app.security.capabilities.includes(value))) {
  throw new Error('The application must declare its platform-specific capabilities.');
}
for (const capability of [mobile, desktop]) {
  const opener = capability.permissions.find(value => value?.identifier === 'opener:allow-open-url');
  const schemes = (opener?.allow || []).map(value => value.url).sort();
  if (JSON.stringify(schemes) !== JSON.stringify(['http://*', 'https://*', 'mailto:*'])
      || capability.permissions.some(value => ['opener:default', 'opener:allow-default-urls', 'opener:allow-open-path'].includes(value))) {
    throw new Error('Opener URLs must have explicit HTTP/HTTPS/mailto scopes without generic path permission.');
  }
}
if (!desktop.permissions.includes('opener:allow-reveal-item-in-dir')) throw new Error('Download reveal permission is required.');
// Updates are fetched over HTTPS only, and verified with the configured public key.
const updater = config.plugins?.updater;
if (!updater?.pubkey || !updater.endpoints?.length || !updater.endpoints.every(value => value.startsWith('https://'))) {
  throw new Error('Signed desktop updates require a public key and HTTPS endpoints.');
}
// The local REST API surface is retired: its transport module, dedicated
// settings commands, lifecycle and published OpenAPI document must stay gone.
// This is a narrow production-source guard; it supplements, and does not
// replace, the native/browser absence acceptance. It intentionally reads only
// production sources and never test/fixture literals.
for (const retired of ['src-tauri/src/api_routes.rs', 'src-tauri/src/commands/api_settings.rs', 'src-tauri/api/openapi-v1.json']) {
  if (fs.existsSync(path.join(root, retired))) throw new Error(`Retired REST API file is present: ${retired}`);
}
const retiredTokens = ['api_routes', 'ApiServerLifecycle', 'api_settings', 'cmd_get_api_settings', 'cmd_update_api_settings', 'cmd_regenerate_api_key'];
for (const file of ['src-tauri/src/lib.rs', 'src-tauri/src/commands/mod.rs']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const found = retiredTokens.filter(token => source.includes(token));
  if (found.length) throw new Error(`Retired REST API reference in ${file}: ${found.join(', ')}`);
}
console.log('[app-security] WebView CSP, capability, updater and retired REST surface configuration passed.');
