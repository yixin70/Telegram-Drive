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
const desktop = json('src-tauri/capabilities/default.json');
if (fs.existsSync(path.join(root, 'src-tauri/capabilities/mobile.json')) || config.bundle?.android) {
  throw new Error('Retired Android build configuration must stay absent.');
}
if (desktop.platforms?.length !== 1 || desktop.platforms[0] !== 'windows') {
  throw new Error('Application capabilities must remain Windows-only.');
}
for (const file of fs.readdirSync(path.join(root, 'src-tauri/capabilities')).filter(file => file.endsWith('.json'))) {
  const capability = json(`src-tauri/capabilities/${file}`);
  if (capability.permissions?.some(value => /^(updater|process):/.test(typeof value === 'string' ? value : value?.identifier))) {
    throw new Error(`Retired updater/process permission in ${file}.`);
  }
}
if (JSON.stringify(config.app.security.capabilities) !== JSON.stringify([desktop.identifier])) {
  throw new Error('The application must declare only its Windows capability.');
}
for (const capability of [desktop]) {
  const opener = capability.permissions.find(value => value?.identifier === 'opener:allow-open-url');
  const schemes = (opener?.allow || []).map(value => value.url).sort();
  if (JSON.stringify(schemes) !== JSON.stringify(['http://*', 'https://*', 'mailto:*'])
      || capability.permissions.some(value => ['opener:default', 'opener:allow-default-urls', 'opener:allow-open-path'].includes(value))) {
    throw new Error('Opener URLs must have explicit HTTP/HTTPS/mailto scopes without generic path permission.');
  }
}
if (!desktop.permissions.includes('opener:allow-reveal-item-in-dir')) throw new Error('Download reveal permission is required.');
// Tauri CLI 2.10.1 still reads plugins.updater.pubkey to sign bundle sidecars.
// Keep that public signing metadata, but no runtime configuration or access.
const updater = config.plugins?.updater;
if (typeof updater?.pubkey !== 'string' || !updater.pubkey || Object.keys(updater).some(key => key !== 'pubkey') || config.bundle?.createUpdaterArtifacts !== true) {
  throw new Error('Preserve signing-only updater public metadata and release artifacts, without runtime endpoints/options.');
}
for (const file of fs.readdirSync(path.join(root, 'src-tauri')).filter(file => /^tauri.*\.conf\.json$/.test(file))) {
  const overrides = json(`src-tauri/${file}`).plugins?.updater;
  if (overrides && Object.keys(overrides).some(key => key !== 'pubkey')) throw new Error(`Runtime updater configuration in ${file}.`);
}
const productionSources = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? productionSources(file) : /\.(tsx?|rs)$/.test(entry.name) ? [file] : [];
});
for (const file of [...productionSources(path.join(root, 'src')), ...productionSources(path.join(root, 'src-tauri/src'))]) {
  if (/@tauri-apps\/plugin-(updater|process)|tauri_plugin_(updater|process)|plugin:(updater|process)\|/.test(fs.readFileSync(file, 'utf8'))) {
    throw new Error(`Retired updater/process runtime reference in ${path.relative(root, file)}.`);
  }
}
const frontendDependencies = json('package.json').dependencies;
const rustManifest = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
if (frontendDependencies['@tauri-apps/plugin-updater'] || frontendDependencies['@tauri-apps/plugin-process'] || /tauri-plugin-(updater|process)\s*=/.test(rustManifest)) {
  throw new Error('Retired updater/process dependencies must stay absent.');
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
console.log('[app-security] WebView CSP, capabilities, release signing metadata and retired updater/REST surface configuration passed.');
