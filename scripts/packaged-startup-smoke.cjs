#!/usr/bin/env node
// Run only in a disposable OS user/VM. Installer/keyring state is not redirected
// merely by HOME; the app also uses a unique smoke-only runtime identifier.
//
// Besides the ordinary one-pass startup smoke, this CLI offers an opt-in two-pass
// legacy REST absence acceptance (--legacy-api-absence). It runs a genuine first
// launch to discover the exact unique Tauri profile, seeds a retained enabled
// api_settings.json plus a benign preservation sentinel only inside that
// validated same-nonce profile, relaunches the same isolated identity and then
// asserts the legacy REST port is genuinely absent. Real packaged acceptance uses
// the existing authenticated startup-smoke protocol (authenticated root/token, a
// unique nonce identifier and ready publication); this REST-removal change adds no
// new production REST seeding hook. The .legacy-api-absence-pass2 marker is consumed
// by the controlled fixture only, and the preservation sentinel is verified by this
// CLI only. A retained enabled api_settings.json is seeded intentionally only inside
// the validated unique disposable profile, where it is inert in the retired build;
// it is never written to a personal profile. An older build may read it and then
// fail acceptance, which is the intended result.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');

// The second-pass marker and preservation sentinel exist only inside the CLI's own
// disposable root/profile. A controlled second launch consumes the marker and this
// CLI verifies the sentinel; both are separate from the pre-existing startup-smoke
// marker and the historical legacy settings file named above.
const SECOND_PASS_MARKER = '.legacy-api-absence-pass2';
const LEGACY_SETTINGS_FILE = 'api_settings.json';
const PRESERVATION_SENTINEL = '.preservation-sentinel';
const PRESERVATION_SENTINEL_BODY = 'telegram-drive-legacy-profile-sentinel\n';
const LEGACY_DEFAULT_PORT = 8550;
const PROBE_TIMEOUT_MS = 750;
const OBSERVATION_MIN_MS = 100;
const OBSERVATION_LIMIT_MS = 15_000;

async function boundedWait(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function belongsToLaunch(pid, launched) {
  if (pid === launched) return true;
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid < 2) return false;
  for (let depth = 0; depth < 16; depth++) {
    const parent = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    if (parent.status !== 0) return false;
    pid = Number(parent.stdout.trim()); if (pid === launched) return true; if (pid < 2) return false;
  }
  return false;
}
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

// A bare TCP connection probe never writes a request, path or credential. It only
// learns whether anything accepts a loopback connection on the port: 'closed'
// (refused), 'open' (a listener accepted) or 'unknown' (filtered/timeout).
function probeTcp(port, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = result => { if (settled) return; settled = true; socket.removeAllListeners(); socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs ?? PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('unknown'));
    socket.once('error', error => finish(error && error.code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
  });
}

// Best-effort attribution of a loopback listener to a process id. Returns null
// when the host has no usable tool, so a listener is then reported as an
// unresolved prerequisite conflict rather than a confirmed application result.
function listeningOwners(port) {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 5000 });
      if (result.status !== 0 || typeof result.stdout !== 'string') return null;
      const pids = new Set();
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
        if (match && Number(match[1]) === port) pids.add(Number(match[2]));
      }
      return [...pids];
    }
    const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5000 });
    if (lsof.status === 0 && typeof lsof.stdout === 'string') {
      return [...new Set(lsof.stdout.split(/\s+/).filter(Boolean).map(Number))].filter(Number.isSafeInteger);
    }
    if (process.platform === 'linux') {
      const ss = spawnSync('ss', ['-ltnp', `sport = :${port}`], { encoding: 'utf8', timeout: 5000 });
      if (ss.status === 0 && typeof ss.stdout === 'string') {
        const pids = new Set();
        for (const match of ss.stdout.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
        return [...pids];
      }
    }
    return null;
  } catch { return null; }
}

function resolveLegacyPort(value) {
  if (value === undefined || value === 'default') return LEGACY_DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('Invalid legacy API port');
  return port;
}

function parseOptions(argv) {
  const options = { timeout: 45_000, args: [], observation: 1000 };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--disposable-user') options.disposable = true;
    else if (flag === '--executable') options.executable = argv[++i];
    else if (flag === '--args-json') options.args = JSON.parse(argv[++i]);
    else if (flag === '--timeout-ms') options.timeout = Number(argv[++i]);
    else if (flag === '--run-token') options.token = argv[++i];
    else if (flag === '--expected-bundle-type') options.bundleType = argv[++i];
    else if (flag === '--legacy-api-absence') options.legacyAbsence = true;
    else if (flag === '--legacy-api-port') options.legacyPort = argv[++i];
    else if (flag === '--legacy-observation-ms') { options.observation = Number(argv[++i]); options.observationGiven = true; }
    else throw new Error(`Unknown flag ${flag}`);
  }
  return options;
}

function validateOptions(options) {
  if (!options.disposable && process.env.GITHUB_ACTIONS !== 'true') throw new Error('Packaged smoke requires a disposable OS user/VM: confirm with --disposable-user');
  if (!Array.isArray(options.args) || options.args.some(value => typeof value !== 'string') || !Number.isInteger(options.timeout) || options.timeout < 100 || options.timeout > 60_000) throw new Error('Invalid smoke arguments/deadline');
  if (options.token !== undefined && !/^[a-fA-F0-9]{32}$/.test(options.token)) throw new Error('Invalid smoke run token');
  if (options.bundleType !== undefined && !['app', 'appimage', 'deb', 'rpm', 'nsis', 'msi'].includes(options.bundleType)) throw new Error('Invalid expected bundle type');
  if (options.legacyAbsence) {
    if (!Number.isInteger(options.observation) || options.observation < OBSERVATION_MIN_MS || options.observation > OBSERVATION_LIMIT_MS) throw new Error('Invalid legacy API observation window');
    options.legacyPort = resolveLegacyPort(options.legacyPort);
  } else if (options.legacyPort !== undefined || options.observationGiven) {
    throw new Error('Legacy REST absence flags require --legacy-api-absence');
  }
}

function createIsolatedRoot(options) {
  const executable = fs.realpathSync(options.executable);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-drive-packaged-smoke-'));
  fs.chmodSync(root, 0o700);
  // Keep the normal suffix alpha-leading (124 random bits). Explicit numeric
  // nonces are escaped for D-Bus; the authentication token itself is unchanged.
  const token = options.token ?? ('a' + randomBytes(16).toString('hex').slice(1));
  const identifier = `com.cameronamer.telegramdrive.smoke.${/^\d/.test(token) ? 'r' : ''}${token}`;
  fs.writeFileSync(path.join(root, '.packaged-startup-smoke'), `${token}\n`, { mode: 0o600 });
  const environment = { ...process.env, TELEGRAM_DRIVE_STARTUP_SMOKE_ROOT: root, TELEGRAM_DRIVE_STARTUP_SMOKE_TOKEN: token, TELEGRAM_DRIVE_SMOKE_DISPOSABLE_USER: '1',
    XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp') };
  // Windows KnownFolder resolution belongs to the disposable OS account.
  // Replacing its profile variables can make SHGetKnownFolderPath fail.
  if (process.platform !== 'win32') Object.assign(environment, {
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local') });
  for (const directory of ['home', 'roaming', 'local', 'data', 'config', 'cache', 'tmp']) fs.mkdirSync(path.join(root, directory));
  return { options, executable, root, token, identifier, environment };
}

// Launch the executable once under the private disposable environment. On
// Windows the launch runs inside a kill-on-close Job owned by smoke-windows-job.ps1
// so descendants are reaped even when the application exits early.
function startLaunch(context) {
  const { options, executable, root } = context;
  const launchRecord = path.join(root, 'windows-launch.json');
  let launchExecutable = executable, launchArgs = options.args;
  if (process.platform === 'win32') {
    const config = path.join(root, 'windows-command.json');
    fs.writeFileSync(config, JSON.stringify({ executable, args: options.args, record: launchRecord }), { mode: 0o600 });
    launchExecutable = 'pwsh.exe';
    launchArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'smoke-windows-job.ps1'), '-Configuration', config];
  }
  const child = spawn(launchExecutable, launchArgs, { cwd: path.dirname(executable), env: context.environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const state = { output: '', exited: false, failure: undefined };
  child.stdout.on('data', data => { state.output = (state.output + data).slice(-16_384); });
  child.stderr.on('data', data => { state.output = (state.output + data).slice(-16_384); });
  const completion = new Promise(resolve => { child.once('error', error => { state.failure = error; state.exited = true; resolve(); }); child.once('close', () => { state.exited = true; resolve(); }); });
  return { child, completion, state, launchRecord };
}
function launchedPid(launch) {
  if (process.platform === 'win32') return JSON.parse(fs.readFileSync(launch.launchRecord, 'utf8')).process_id;
  return launch.child.pid;
}
// A readiness marker alone is not proof of life after it. Require the exact
// launch we authenticated to still be running. A definitive answer is returned
// only when it can be confirmed; an unavailable record, an invalid PID or an
// inconclusive probe fails closed rather than implying healthy absence.
function launchIsAlive(launch) {
  if (launch.state.exited) return false;
  let pid;
  try { pid = launchedPid(launch); } catch { throw new Error('Could not confirm application liveness: the recorded launch identity is unavailable'); }
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Could not confirm application liveness: the recorded launch PID is invalid');
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error && error.code === 'ESRCH') return false;
    throw new Error(`Could not confirm application liveness: ${error && error.message ? error.message : error}`);
  }
}
async function awaitReadiness(context, launch) {
  const { options, root, token, identifier } = context;
  let ready;
  const deadline = Date.now() + options.timeout;
  while (Date.now() < deadline && !launch.state.exited) {
    const marker = path.join(root, 'startup-ready.json');
    if (fs.existsSync(marker)) {
      const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
      const launched = launchedPid(launch);
      if (!belongsToLaunch(value.process_id, launched) || value.run_token !== token || value.profile_identifier !== identifier || !value.database_ready || !value.app_data_ready || !value.streaming_runtime_ready) throw new Error('Invalid or stale application readiness marker');
      for (const name of ['app_data_dir', 'app_cache_dir', 'app_config_dir', 'app_local_data_dir']) {
        if (typeof value[name] !== 'string' || path.basename(value[name]) !== identifier) throw new Error(`Readiness ${name} is not the isolated Tauri profile`);
      }
      ready = value;
      if (options.bundleType && value.bundle_type !== options.bundleType) throw new Error(`Runtime bundle type ${value.bundle_type ?? 'unknown'} does not match ${options.bundleType}`);
      break;
    }
    await delay(50);
  }
  if (!ready || launch.state.exited) throw launch.state.failure || new Error(`Application readiness not reached${launch.state.exited ? ' before early exit' : ' before deadline'}\n${launch.state.output}`);
  return ready;
}

// Stop a launch the way the one-pass smoke always has: ask the Windows Job to
// terminate and prove it empty, or signal the Unix process group, then verify the
// process is gone. Returns the observed natural-exit flag and captured output.
async function reapLaunch(context, launch) {
  if (launch.child.pid) {
    if (process.platform === 'win32') {
      fs.writeFileSync(`${launch.launchRecord}.stop`, 'stop\n');
      await boundedWait(launch.completion, 12_000);
      if (!launch.state.exited || !fs.existsSync(`${launch.launchRecord}.reaped`)) {
        if (!launch.state.exited) spawnSync('taskkill', ['/PID', String(launch.child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 10_000 });
        throw new Error('Windows smoke job did not confirm all descendants reaped');
      }
      const outcome = JSON.parse(fs.readFileSync(`${launch.launchRecord}.reaped`, 'utf8'));
      if (typeof outcome.natural_exit !== 'boolean' || !Number.isInteger(outcome.exit_code)) throw new Error('Invalid Windows smoke job outcome');
      launch.naturalExit = outcome.natural_exit;
    } else { try { process.kill(-launch.child.pid, 'SIGTERM'); } catch {} }
  }
  await boundedWait(launch.completion, 2_000);
  if (process.platform !== 'win32' && launch.child.pid) { try { process.kill(-launch.child.pid, 'SIGKILL'); } catch {} }
  await boundedWait(launch.completion, 5_000);
  if (!launch.state.exited) throw new Error('Smoke process could not be reaped');
  return { naturalExit: launch.naturalExit, output: launch.state.output };
}

// Remove only the exact unique profile paths returned by readiness, never a
// parent directory or a similarly named path. Failures are surfaced by callers.
function cleanupProfileAndRoot(root, ready, identifier) {
  if (ready) for (const name of ['app_data_dir', 'app_cache_dir', 'app_config_dir', 'app_local_data_dir']) {
    const directory = ready[name];
    if (typeof directory === 'string' && path.basename(directory) === identifier) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function removeStaleLaunchArtifacts(root) {
  for (const name of ['startup-ready.json', 'startup-ready.partial', 'windows-launch.json', 'windows-launch.json.stop', 'windows-launch.json.reaped']) {
    try { fs.rmSync(path.join(root, name), { force: true }); } catch {}
  }
}

// Seed a realistic retained enabled REST configuration and a benign sentinel.
// This is guarded so a wrong or unvalidated path can never be written.
function seedLegacyProfile(profile, identifier, port) {
  if (typeof profile !== 'string' || path.basename(profile) !== identifier) throw new Error('Refusing to seed a profile that is not the isolated Tauri identity');
  if (!fs.existsSync(profile) || !fs.statSync(profile).isDirectory()) throw new Error('The isolated profile directory from readiness is missing');
  const settings = { enabled: true, port, key_hash: '0'.repeat(64) };
  fs.writeFileSync(path.join(profile, LEGACY_SETTINGS_FILE), JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, PRESERVATION_SENTINEL), PRESERVATION_SENTINEL_BODY, { mode: 0o600 });
}

async function runSinglePassSmoke(context) {
  const { root, identifier } = context;
  const launch = startLaunch(context);
  let ready, startupError;
  try {
    ready = await awaitReadiness(context, launch);
  } catch (error) {
    startupError = error;
    throw error;
  } finally {
    let outcome;
    try {
      outcome = await reapLaunch(context, launch);
      cleanupProfileAndRoot(root, ready, identifier);
    } catch (cleanupError) {
      if (!startupError) throw cleanupError;
      console.error(`[packaged-smoke] Cleanup also failed: ${cleanupError.message}`);
    }
    if (!startupError && outcome && outcome.naturalExit) throw new Error(`Application exited naturally before controlled smoke shutdown\n${outcome.output}`);
  }
  console.log(`[packaged-smoke] Startup readiness passed for ${path.basename(context.executable)} (${ready.version}, bundle ${ready.bundle_type ?? 'unchecked'}), isolated profile ${identifier}.`);
}

async function runLegacyApiAbsence(context) {
  const { options, root, identifier } = context;
  const port = options.legacyPort;
  let failure, profile, discoveredReady, firstLaunch, secondLaunch;
  try {
    // Prerequisite: the legacy port must be genuinely free before the upgrade.
    // A connection that was already accepted is a conflict, never "absence".
    const initial = await probeTcp(port);
    if (initial !== 'closed') throw new Error(initial === 'open'
      ? `Legacy REST port ${port} already accepts connections before the upgrade launch; prerequisite conflict, not a retirement result`
      : `Legacy REST port ${port} could not be confirmed free before the upgrade launch; prerequisite could not be established`);
    // Pass one: a genuine ready launch discovers the exact unique profile path.
    firstLaunch = startLaunch(context);
    const firstReady = await awaitReadiness(context, firstLaunch);
    // Record the authenticated profile before reaping can fail, so the finally
    // below still knows the exact unique external profile to clean.
    profile = firstReady.app_data_dir;
    if (path.basename(profile) !== identifier) throw new Error('Readiness app_data_dir is not the isolated Tauri profile');
    discoveredReady = firstReady;
    const firstOutcome = await reapLaunch(context, firstLaunch);
    firstLaunch = undefined;
    if (firstOutcome.naturalExit) throw new Error(`Application exited naturally before controlled smoke shutdown\n${firstOutcome.output}`);
    // Seed only the validated same-nonce profile, then clear stale artifacts so
    // the relaunch reports itself fresh rather than reusing pass-one readiness.
    seedLegacyProfile(profile, identifier, port);
    removeStaleLaunchArtifacts(root);
    fs.writeFileSync(path.join(root, SECOND_PASS_MARKER), '1\n', { mode: 0o600 });
    // Pass two: the same isolated identity under the retained enabled profile.
    secondLaunch = startLaunch(context);
    // The first authenticated record stays the immutable cleanup authority. The
    // second launch is untrusted: compare every resolved profile path against the
    // first and fail conservatively on any swap, never switching cleanup to it.
    const secondReady = await awaitReadiness(context, secondLaunch);
    for (const name of ['app_data_dir', 'app_cache_dir', 'app_config_dir', 'app_local_data_dir']) {
      if (secondReady[name] !== discoveredReady[name]) throw new Error(`The second launch reported a different isolated profile path for ${name}; refusing to switch cleanup authority`);
    }
    // Observe the authenticated ready process across a strictly positive bounded
    // window, probing the legacy port repeatedly rather than only once. A launch
    // that exits after readiness is a failure, not absence; an inconclusive probe
    // never counts as absence; only a port owned by the launch is a retirement
    // failure, and an unrelated listener stays an ambient prerequisite conflict.
    let appListenerDetected = false;
    const observationEnd = Date.now() + options.observation;
    for (;;) {
      if (!launchIsAlive(secondLaunch)) throw new Error(`The second launch exited after readiness before the absence observation completed\n${secondLaunch.state.output}`);
      const observed = await probeTcp(port);
      if (observed === 'open') { appListenerDetected = true; break; }
      if (observed === 'unknown') throw new Error(`Legacy REST port ${port} could not be probed during the observation window; could not establish legacy REST absence`);
      const remaining = observationEnd - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(100, remaining));
    }
    if (appListenerDetected) {
      const owners = listeningOwners(port);
      if (owners && owners.some(pid => belongsToLaunch(pid, launchedPid(secondLaunch)))) throw new Error(`Legacy REST port ${port} is owned by the launched application after readiness: the legacy REST listener was not retired`);
      throw new Error(`Legacy REST port ${port} accepts connections after readiness but the owner is not the launched application; unresolved prerequisite conflict, not a retirement result`);
    }
    if (!launchIsAlive(secondLaunch)) throw new Error(`The second launch exited after readiness before the absence observation completed\n${secondLaunch.state.output}`);
    // Preservation: unrelated data written before the upgrade must survive.
    if (fs.readFileSync(path.join(profile, PRESERVATION_SENTINEL), 'utf8') !== PRESERVATION_SENTINEL_BODY) throw new Error('Preservation sentinel content changed across the upgrade launch');
    const secondOutcome = await reapLaunch(context, secondLaunch);
    secondLaunch = undefined;
    if (secondOutcome.naturalExit) throw new Error(`Application exited naturally before controlled smoke shutdown\n${secondOutcome.output}`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    let reapingProven = true;
    for (const launch of [firstLaunch, secondLaunch]) {
      if (!launch) continue;
      try { await reapLaunch(context, launch); } catch (error) { reapingProven = false; cleanupErrors.push(error); }
    }
    if (reapingProven) {
      // Remove the exact recorded profile only after process reaping is proven; a
      // lock left by a survivor still surfaces as a cleanup error, never weakened.
      try { cleanupProfileAndRoot(root, discoveredReady, identifier); } catch (error) { cleanupErrors.push(error); }
    } else {
      console.error(`[packaged-smoke] Cleanup skipped for the isolated profile ${discoveredReady ? discoveredReady.app_data_dir : identifier}: process reaping was not proven`);
    }
    if (cleanupErrors.length) {
      if (failure) console.error(`[packaged-smoke] Cleanup also failed: ${cleanupErrors.map(error => error.message).join('; ')}`);
      else throw cleanupErrors[0];
    }
  }
  console.log(`[packaged-smoke] Legacy REST absence acceptance passed for ${path.basename(context.executable)} (${discoveredReady.version}, bundle ${discoveredReady.bundle_type ?? 'unchecked'}), isolated profile ${identifier}, legacy port ${port}, observation ${options.observation} ms.`);
}

async function main() {
  const options = parseOptions(process.argv);
  validateOptions(options);
  const context = createIsolatedRoot(options);
  if (options.legacyAbsence) await runLegacyApiAbsence(context);
  else await runSinglePassSmoke(context);
}
main().catch(error => { console.error(`[packaged-smoke] ${error.message}`); process.exitCode = 1; });
