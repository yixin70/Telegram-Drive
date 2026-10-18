const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const cli = path.resolve(__dirname, '../packaged-startup-smoke.cjs');
const app = path.join(__dirname, 'fixtures/startup-smoke-app.cjs');
function journey(t, mode, extra = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-packaged-cli-e2e-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const evidence = path.join(directory, 'evidence.json');
  const result = spawnSync(process.execPath, [cli, '--disposable-user', '--executable', process.execPath,
    '--args-json', JSON.stringify([app, mode, evidence]), '--timeout-ms', process.platform === 'win32' ? '20000' : '8000', ...extra], { encoding: 'utf8', timeout: 45000 });
  assert.ifError(result.error);
  return { result, evidence, record: fs.existsSync(evidence) && JSON.parse(fs.readFileSync(evidence, 'utf8')) };
}
test('smoke CLI accepts numeric-leading nonce with a valid isolated identity and removes the private profile', t => {
  const token = '0' + randomBytes(16).toString('hex').slice(1);
  const { result, record } = journey(t, 'ready', ['--run-token', token, '--expected-bundle-type', 'nsis']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(record.token, token);
  assert.equal(record.identifier, `com.cameronamer.telegramdrive.smoke.r${token}`);
  assert.equal(fs.existsSync(record.root), false);
});
test('smoke CLI rejects incorrect runtime package metadata', t => {
  const { result, record } = journey(t, 'wrong-kind', ['--expected-bundle-type', 'nsis']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bundle type.*nsis/i);
  assert.equal(fs.existsSync(record.root), false);
});
test('early exit keeps the startup failure and reaps surviving descendants before cleanup', t => {
  const { result, evidence, record } = journey(t, 'orphan');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture startup failed/);
  const pid = Number(fs.readFileSync(`${evidence}.child`, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Descendant must report a valid PID');
  if (process.platform === 'win32') {
    const check = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr); assert.ok(!check.stdout.includes(`"${pid}"`), check.stdout);
  } else {
    // A briefly unreaped Unix zombie cannot run or retain the lock descriptor.
    const check = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    assert.ok(check.status !== 0 || /^Z/.test(check.stdout.trim()), check.stdout);
  }
  fs.rmSync(`${evidence}.child.lock`);
  assert.equal(fs.existsSync(record.root), false);
});
test('readiness deadline fails and cleans up the private launch', t => {
  const { result, record } = journey(t, 'deadline', ['--timeout-ms', process.platform === 'win32' ? '10000' : '250']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /before deadline/);
  assert.equal(fs.existsSync(record.root), false);
});
test('Windows rejects readiness followed by natural application exit while its descendants are reaped', { skip: process.platform !== 'win32' }, t => {
  const { result, record, evidence } = journey(t, 'ready-exit');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /early exit|exited naturally/);
  assert.doesNotMatch(result.stdout, /Startup readiness passed/);
  const pid = Number(fs.readFileSync(`${evidence}.child`, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Descendant must report a valid PID');
  const check = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr); assert.ok(!check.stdout.includes(`"${pid}"`), check.stdout);
  fs.rmSync(`${evidence}.child.lock`);
  assert.equal(fs.existsSync(record.root), false);
});
test('Windows smoke preserves the OS KnownFolder profile environment', { skip: process.platform !== 'win32' }, t => {
  const { result, record } = journey(t, 'ready');
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) assert.equal(record[name], process.env[name]);
});

function capturedProcess(executable, args) {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', error;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', value => { error = value; });
  let closed = false;
  const completion = new Promise(resolve => child.once('close', status => {
    closed = true; resolve({ status, stdout, stderr, error });
  }));
  return { child, completion, get closed() { return closed; } };
}
async function boundedCompletion(process, milliseconds) {
  let timer;
  try {
    return await Promise.race([process.completion, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned fixture process exceeded its deadline')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function lockedProfileJourney(t, mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-packaged-lock-e2e-'));
  const evidence = path.join(directory, 'evidence.json');
  // This sibling is created by the test runner, never by the smoke application,
  // so the application Job cannot reap its delete-denying Windows handle.
  const locker = capturedProcess('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'fixtures/startup-profile-lock.ps1'), '-Evidence', evidence, '-Mode', mode]);
  let launch, record;
  t.after(async () => {
    const errors = [];
    const attempt = async action => { try { await action(); } catch (error) { errors.push(error); } };
    await attempt(() => fs.writeFileSync(`${evidence}.stop-locker`, 'stop'));
    // Cache valid evidence in the journey, and recover it if an earlier assertion
    // interrupted the journey while the fixture was still publishing its record.
    await attempt(async () => {
      const deadline = Date.now() + 2000;
      let readError;
      while (!record && Date.now() < deadline) {
        try {
          const value = JSON.parse(fs.readFileSync(evidence, 'utf8'));
          if (typeof value.root !== 'string' || typeof value.identifier !== 'string') throw new Error('Invalid fixture cleanup record');
          record = value;
        } catch (error) { readError = error; await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      if (!record && fs.existsSync(evidence)) throw readError;
    });
    // Request controlled Job shutdown before any last-resort CLI tree kill.
    await attempt(() => {
      if (record && fs.existsSync(record.root)) fs.writeFileSync(path.join(record.root, 'windows-launch.json.stop'), 'stop');
    });
    const reap = async (owned, timeout, tree) => {
      if (!owned) return;
      try { await boundedCompletion(owned, timeout); }
      catch {
        try {
          if (!owned.closed && owned.child.exitCode === null && owned.child.signalCode === null && owned.child.pid) {
            if (tree) {
              const killed = spawnSync('taskkill', ['/PID', String(owned.child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 10000 });
              assert.ifError(killed.error);
              assert.equal(killed.status, 0, killed.stderr);
            } else owned.child.kill();
          }
        } finally { await boundedCompletion(owned, 5000); }
      }
    };
    // A failed stop/write/kill must never prevent reaping the other owned process.
    const outcomes = await Promise.allSettled([reap(locker, 5000, false), reap(launch, 15000, true)]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(outcome.reason);
    await attempt(() => { if (record) fs.rmSync(record.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    await attempt(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    if (errors.length) throw new AggregateError(errors, 'Owned Windows lock fixture cleanup failed');
  });
  launch = capturedProcess(process.execPath, [cli, '--disposable-user', '--executable', process.execPath,
    '--args-json', JSON.stringify([app, 'ready-lock', evidence]), '--timeout-ms', '20000']);
  const result = await boundedCompletion(launch, 45000);
  assert.ifError(result.error);
  assert.ok(fs.existsSync(`${evidence}.acquired`), 'Readiness must follow acquisition of a real delete-denying handle');
  record = JSON.parse(fs.readFileSync(evidence, 'utf8'));
  const acquired = JSON.parse(fs.readFileSync(`${evidence}.acquired`, 'utf8'));
  assert.equal(acquired.profile, path.join(record.root, record.identifier));
  assert.equal(acquired.pid, locker.child.pid, 'The lock is owned outside the smoke application Job');
  if (mode === 'transient') {
    const lockResult = await boundedCompletion(locker, 10000);
    assert.ifError(lockResult.error);
    assert.equal(lockResult.status, 0, lockResult.stderr);
    const released = JSON.parse(fs.readFileSync(`${evidence}.released`, 'utf8'));
    assert.equal(released.reaped, true, 'Lock must survive confirmed application Job reaping');
    assert.ok(released.held_after_reap_ms >= 750, 'Hold the external handle for at least 750 ms after Job reaping');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Startup readiness passed/);
    assert.equal(fs.existsSync(acquired.profile), false);
    assert.equal(fs.existsSync(record.root), false);
  } else {
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /EBUSY|EPERM|ENOTEMPTY/);
    assert.doesNotMatch(result.stdout, /Startup readiness passed/);
    assert.equal(fs.existsSync(`${evidence}.released`), false, 'Persistent handle must still be held when cleanup fails');
    assert.equal(fs.existsSync(path.join(record.root, 'windows-launch.json.reaped')), true);
    assert.equal(fs.existsSync(acquired.profile), true, 'Persistent lock must remain a hard cleanup failure');
  }
}
test('Windows smoke retries a transient profile database lock after owned Job reaping',
  { skip: process.platform !== 'win32', timeout: 90000 }, t => lockedProfileJourney(t, 'transient'));
test('Windows smoke fails closed when an external profile database lock persists',
  { skip: process.platform !== 'win32', timeout: 90000 }, t => lockedProfileJourney(t, 'persistent'));

// Legacy REST absence acceptance: the CLI discovers the exact isolated profile
// with a genuine launch, seeds a retained enabled api_settings.json plus a benign
// sentinel only in that validated same-nonce profile, relaunches the same
// identity and only then asserts the legacy REST port is absent. The controlled
// second-launch fixtures stand in for a shipped application; they are evidence
// of this CLI contract, not proof about the packaged application.
const SENTINEL_BODY = 'telegram-drive-legacy-profile-sentinel\n';
const LEGACY_DEFAULT_PORT = 8550;
function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
function acceptsConnections(port, timeout = 500) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    let settled = false;
    const done = value => { if (settled) return; settled = true; socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
function holdPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.destroy());
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
async function absenceJourney(t, mode, { port, observationMs = 100, appArgs = [] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-packaged-absence-e2e-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const evidence = path.join(directory, 'evidence.json');
  const args = [cli, '--disposable-user', '--executable', process.execPath,
    '--args-json', JSON.stringify([app, mode, evidence, ...appArgs]),
    '--timeout-ms', process.platform === 'win32' ? '20000' : '8000',
    '--legacy-api-absence', '--legacy-observation-ms', String(observationMs)];
  if (port !== undefined) args.push('--legacy-api-port', String(port));
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 150000 });
  assert.ifError(result.error);
  const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  const record = read(evidence);
  return { result, record, pass2: read(`${evidence}.pass2`),
    profile: record ? path.join(record.root, record.identifier) : undefined };
}
test('legacy REST absence acceptance seeds an enabled free custom port profile before the relaunch, preserves unrelated data and removes exact paths',
  { timeout: 150000 }, async t => {
    const port = await availablePort();
    const { result, record, pass2, profile } = await absenceJourney(t, 'upgrade-retired', { port });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Legacy REST absence acceptance passed/);
    assert.ok(record && pass2, 'The controlled application must report both launches');
    // The second launch reads the profile at its own initialization, so its
    // report proves the CLI seeded before the relaunch began.
    assert.equal(pass2.profile, profile);
    assert.equal(pass2.seeded.enabled, true, 'Seeded legacy REST config must already be enabled when the second launch initializes');
    assert.equal(pass2.seeded.port, port);
    assert.equal(pass2.sentinel, SENTINEL_BODY, 'Unrelated data must already be present when the second launch initializes');
    assert.equal(fs.existsSync(profile), false, 'The exact isolated profile must be removed');
    assert.equal(fs.existsSync(record.root), false, 'The private disposable root must be removed');
  });
test('legacy REST absence acceptance covers the default legacy port, or reports an already occupied port as a prerequisite',
  { timeout: 150000 }, async t => {
    const occupied = await acceptsConnections(LEGACY_DEFAULT_PORT);
    const { result, pass2 } = await absenceJourney(t, 'upgrade-retired', { port: 'default' });
    if (occupied) {
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /already accepts connections|could not be confirmed free/i);
      assert.doesNotMatch(result.stdout, /acceptance passed/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Legacy REST absence acceptance passed/);
      assert.equal(pass2.seeded.enabled, true);
      assert.equal(pass2.seeded.port, LEGACY_DEFAULT_PORT);
    }
  });
test('legacy REST absence acceptance fails when the second launch actually serves the seeded legacy port',
  { timeout: 150000 }, async t => {
    const port = await availablePort();
    const { result } = await absenceJourney(t, 'upgrade-rest', { port });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /not retired|owner is not the launched application/i);
    assert.doesNotMatch(result.stdout, /acceptance passed/);
  });
test('legacy REST absence acceptance reports an unrelated listener as a prerequisite instead of counting it as absence',
  { timeout: 150000 }, async t => {
    const port = await availablePort();
    const held = await holdPort(port);
    t.after(() => new Promise(resolve => held.close(() => resolve())));
    const { result, record } = await absenceJourney(t, 'upgrade-retired', { port });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /already accepts connections|prerequisite/i);
    assert.doesNotMatch(result.stdout, /acceptance passed/);
    assert.equal(record, undefined, 'A prerequisite conflict must not launch the controlled application');
  });
test('legacy REST absence acceptance fails a second launch that reports the wrong nonce and still cleans up exact paths',
  { timeout: 150000 }, async t => {
    const port = await availablePort();
    const { result, record, profile } = await absenceJourney(t, 'upgrade-wrong-token', { port });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /stale application readiness marker/i);
    assert.doesNotMatch(result.stdout, /acceptance passed/);
    assert.equal(fs.existsSync(profile), false);
    assert.equal(fs.existsSync(record.root), false);
  });
test('legacy REST absence acceptance fails a second launch that reports a profile outside the isolated identity',
  { timeout: 150000 }, async t => {
    const port = await availablePort();
    const { result } = await absenceJourney(t, 'upgrade-wrong-profile', { port });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /not the isolated Tauri profile/i);
    assert.doesNotMatch(result.stdout, /acceptance passed/);
  });
test('legacy REST absence acceptance refuses a first launch whose readiness names a path outside the isolated profile before seeding',
  { timeout: 150000 }, async t => {
    const port = await availablePort();
    const { result, pass2, record } = await absenceJourney(t, 'upgrade-wrong-path', { port });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /not the isolated Tauri profile/i);
    assert.doesNotMatch(result.stdout, /acceptance passed/);
    assert.equal(pass2, undefined, 'A rejected first pass must never relaunch');
    assert.equal(fs.existsSync(record.root), false);
  });
test('legacy REST absence acceptance fails when the second launch exits before reporting readiness',
  { timeout: 150000 }, async t => {
    const port = await availablePort();
    const { result, pass2, record, profile } = await absenceJourney(t, 'upgrade-exit', { port });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /before early exit|before deadline/i);
    assert.doesNotMatch(result.stdout, /acceptance passed/);
    assert.ok(pass2, 'The seeded profile must still be observable before the controlled exit');
    assert.equal(fs.existsSync(profile), false);
    assert.equal(fs.existsSync(record.root), false);
  });
test('legacy REST absence acceptance refuses a second launch that reports readiness and then exits during the observation window',
  { timeout: 150000 }, async t => {
    const port = await availablePort();
    const { result, pass2, record, profile } = await absenceJourney(t, 'upgrade-ready-exit', { port, observationMs: 1200 });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /exited after readiness|exited naturally|before early exit|before deadline/i);
    assert.doesNotMatch(result.stdout, /acceptance passed/);
    assert.ok(pass2, 'Readiness had to be reached before the controlled exit');
    assert.equal(fs.existsSync(profile), false);
    assert.equal(fs.existsSync(record.root), false);
  });
test('legacy REST absence acceptance requires a strictly positive observation window',
  { timeout: 150000 }, async t => {
    const port = await availablePort();
    const { result } = await absenceJourney(t, 'upgrade-retired', { port, observationMs: 0 });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /Invalid legacy API observation window/i);
    assert.doesNotMatch(result.stdout, /acceptance passed/);
  });
// The first authenticated readiness must stay the immutable cleanup authority even
// when the second launch reports alternative profile paths with the SAME identifier
// basename. Both profiles live outside the CLI root in an E2E-owned temp folder, so
// a cleanup that follows the rejected second record leaks the first external
// profile and deletes the alternate one. These regressions fail on that old flow.
const ALTERNATE_PROFILE_SENTINEL_BODY = 'telegram-drive-alternate-profile-sentinel\n';
async function swappedAuthorityJourney(t, swap) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'td-absence-authority-e2e-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const firstBase = path.join(sandbox, 'first'), secondBase = path.join(sandbox, 'second');
  fs.mkdirSync(firstBase); fs.mkdirSync(secondBase);
  const port = await availablePort();
  const plan = { first_base: firstBase, second_base: secondBase, swap };
  const { result, record } = await absenceJourney(t, 'upgrade-swap', { port, appArgs: [JSON.stringify(plan)] });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /different isolated profile path|refusing to switch cleanup authority/i);
  assert.doesNotMatch(result.stdout, /acceptance passed/);
  assert.ok(record, 'The first launch must have reported readiness');
  const attached = path.join(firstBase, record.identifier), rejected = path.join(secondBase, record.identifier);
  assert.equal(fs.existsSync(attached), false, 'The first authenticated external profile must still be cleaned after reaping');
  assert.equal(fs.existsSync(rejected), true, 'The rejected alternate profile must not be deleted');
  assert.equal(fs.readFileSync(path.join(rejected, '.preservation-sentinel'), 'utf8'), ALTERNATE_PROFILE_SENTINEL_BODY,
    'The rejected alternate profile sentinel must not be modified');
}
test('legacy REST absence acceptance keeps the first authenticated profile as cleanup authority when the second launch swaps app_data_dir',
  { timeout: 150000 }, t => swappedAuthorityJourney(t, 'app_data_dir'));
test('legacy REST absence acceptance keeps the first authenticated profile as cleanup authority when the second launch swaps app_cache_dir',
  { timeout: 150000 }, t => swappedAuthorityJourney(t, 'app_cache_dir'));
