// Controlled application boundary for the smoke CLI. Actual Tauri/WebView
// startup and package metadata are exercised separately in packaged CI.
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const [mode, evidence, planJson] = process.argv.slice(2);
// Names are written only by the two-pass CLI inside its own disposable root.
const SECOND_PASS_MARKER = '.legacy-api-absence-pass2';
const PRESERVATION_SENTINEL_FILE = '.preservation-sentinel';
const ALTERNATE_PROFILE_SENTINEL_BODY = 'telegram-drive-alternate-profile-sentinel\n';
function descendantReady() {
  try { const pid = Number(fs.readFileSync(`${evidence}.child`, 'utf8')); return Number.isSafeInteger(pid) && pid > 1; }
  catch { return false; }
}
function publishRecord(root, record) {
  fs.writeFileSync(path.join(root, 'startup-ready.partial'), JSON.stringify(record));
  fs.renameSync(path.join(root, 'startup-ready.partial'), path.join(root, 'startup-ready.json'));
}
// Second pass of a legacy REST absence journey: a controlled stand-in for an
// application that either retired REST (the default) or, as a counterfactual,
// still served it. It records the seeded profile before it initializes so a
// journey can prove the CLI seeded before this launch began.
function upgradeSecondPass(variant, evidence, root, identifier, planJson) {
  const profile = path.join(root, identifier);
  const settingsPath = path.join(profile, 'api_settings.json');
  const sentinelPath = path.join(profile, PRESERVATION_SENTINEL_FILE);
  const seeded = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : null;
  const sentinel = fs.existsSync(sentinelPath) ? fs.readFileSync(sentinelPath, 'utf8') : null;
  fs.writeFileSync(`${evidence}.pass2`, JSON.stringify({ profile, seeded, sentinel }));
  if (variant === 'exit') { console.error('upgrade fixture exited before readiness'); process.exit(9); }
  if (variant === 'swap') {
    // A second launch that reports alternative profile paths with the SAME
    // identifier basename. Both live outside the CLI root in an E2E-owned temp
    // folder; a sentinel in the rejected alternate profile detects any cleanup
    // that follows the untrusted second record instead of the first authority.
    const plan = JSON.parse(planJson);
    const first = path.join(plan.first_base, identifier);
    const second = path.join(plan.second_base, identifier);
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(path.join(second, PRESERVATION_SENTINEL_FILE), ALTERNATE_PROFILE_SENTINEL_BODY);
    const record = { process_id: process.pid, run_token: process.env.TELEGRAM_DRIVE_STARTUP_SMOKE_TOKEN, profile_identifier: identifier, version: '4.0.0',
      database_ready: true, app_data_ready: true, streaming_runtime_ready: true, bundle_type: 'nsis' };
    for (const name of ['app_data_dir', 'app_cache_dir', 'app_config_dir', 'app_local_data_dir']) record[name] = first;
    record[plan.swap] = second;
    publishRecord(root, record);
    setInterval(() => {}, 100);
    return;
  }
  fs.mkdirSync(profile, { recursive: true });
  const record = { process_id: process.pid, run_token: process.env.TELEGRAM_DRIVE_STARTUP_SMOKE_TOKEN, profile_identifier: identifier, version: '4.0.0',
    database_ready: true, app_data_ready: true, streaming_runtime_ready: true, bundle_type: 'nsis' };
  for (const name of ['app_data_dir', 'app_cache_dir', 'app_config_dir', 'app_local_data_dir']) record[name] = profile;
  if (variant === 'wrong-token') record.run_token = 'deadbeefdeadbeefdeadbeefdeadbeef';
  else if (variant === 'wrong-profile') record.app_data_dir = `${profile}-other`;
  if (variant === 'rest') {
    const server = require('node:net').createServer();
    const port = seeded && Number.isInteger(Number(seeded.port)) ? Number(seeded.port) : 8550;
    server.once('error', () => process.exit(3));
    server.listen(port, '127.0.0.1', () => { publishRecord(root, record); setInterval(() => {}, 100); });
  } else if (variant === 'ready-exit') {
    // A crash shortly after reporting readiness must never be mistaken for
    // absence; the CLI has to observe the authenticated process going away.
    publishRecord(root, record);
    setTimeout(() => process.exit(7), 150);
    setInterval(() => {}, 100);
  } else {
    publishRecord(root, record);
    setInterval(() => {}, 100);
  }
}
if (mode === 'descendant') {
  const lock = fs.openSync(`${evidence}.lock`, 'w');
  fs.writeFileSync(evidence, String(process.pid));
  setInterval(() => fs.fsyncSync(lock), 100);
} else {
  const root = process.env.TELEGRAM_DRIVE_STARTUP_SMOKE_ROOT;
  const token = process.env.TELEGRAM_DRIVE_STARTUP_SMOKE_TOKEN;
  const identifier = `com.cameronamer.telegramdrive.smoke.${/^\d/.test(token) ? 'r' : ''}${token}`;
  fs.writeFileSync(evidence, JSON.stringify({ root, token, identifier,
    USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }));
  const upgradeVariant = typeof mode === 'string' && mode.startsWith('upgrade-') ? mode.slice('upgrade-'.length) : null;
  if (upgradeVariant !== null && fs.existsSync(path.join(root, SECOND_PASS_MARKER))) {
    upgradeSecondPass(upgradeVariant, evidence, root, identifier, planJson);
  } else if (mode === 'orphan') {
    const child = spawn(process.execPath, [__filename, 'descendant', `${evidence}.child`], { stdio: 'ignore' });
    child.unref();
    const wait = setInterval(() => {
      if (descendantReady()) { clearInterval(wait); console.error('fixture startup failed'); process.exit(7); }
    }, 10);
  } else if (mode === 'deadline') {
    setInterval(() => {}, 100);
  } else if (upgradeVariant !== null) {
    // First pass of an upgrade journey: an ordinary ready launch that creates the
    // isolated profile the CLI later discovers, seeds and relaunches. A wrong-path
    // variant reports an isolated-looking record whose directory basename does not
    // match the nonce identity, so the CLI must refuse to seed it. A swap journey
    // places the first authenticated profile outside the CLI root in E2E temp.
    const swapPlan = upgradeVariant === 'swap' ? JSON.parse(planJson) : null;
    const directory = swapPlan ? path.join(swapPlan.first_base, identifier) : path.join(root, identifier);
    fs.mkdirSync(directory, { recursive: true });
    const record = { process_id: process.pid, run_token: token, profile_identifier: identifier, version: '4.0.0',
      database_ready: true, app_data_ready: true, streaming_runtime_ready: true, bundle_type: 'nsis' };
    for (const name of ['app_data_dir', 'app_cache_dir', 'app_config_dir', 'app_local_data_dir']) record[name] = directory;
    if (upgradeVariant === 'wrong-path') record.app_data_dir = `${directory}-other`;
    publishRecord(root, record);
    setInterval(() => {}, 100);
  } else {
    const directory = path.join(root, identifier); fs.mkdirSync(directory);
    const record = { process_id: process.pid, run_token: token, profile_identifier: identifier, version: '4.0.0',
      database_ready: true, app_data_ready: true, streaming_runtime_ready: true, bundle_type: mode === 'wrong-kind' ? 'rpm' : 'nsis' };
    for (const name of ['app_data_dir', 'app_cache_dir', 'app_config_dir', 'app_local_data_dir']) record[name] = directory;
    const publish = () => {
      publishRecord(root, record);
      if (mode === 'ready-exit') process.exit(7);
      setInterval(() => {}, 100);
    };
    if (mode === 'ready-exit') {
      const child = spawn(process.execPath, [__filename, 'descendant', `${evidence}.child`], { stdio: 'ignore' }); child.unref();
      const wait = setInterval(() => { if (descendantReady()) { clearInterval(wait); publish(); } }, 10);
    } else if (mode === 'ready-lock') {
      // The external test-owned locker must deny deletion before readiness.
      const wait = setInterval(() => {
        if (fs.existsSync(`${evidence}.acquired`)) { clearInterval(wait); publish(); }
      }, 10);
    } else publish();
  }
}
