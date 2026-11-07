# Update/reminder removal verification

Worktree: `remove-updates`, based on `84b08815c38bc748e21af8fe5e03812bb2f863fb`.
This records implementation evidence, not a release-acceptance certificate.

## Implementation boundaries

- Removed automatic and manual version discovery, update/install UI, downloads,
  updater-triggered restart, and the independent post-upgrade What's New dialog.
- Removed updater/process runtime plugins, dependencies, permissions and endpoints.
  `plugins.updater.pubkey` and `bundle.createUpdaterArtifacts` remain **build-time
  signing inputs**: Tauri CLI 2.10.1 reads them when signing installer sidecars.
  Release and manifest-hosting workflows remain available to older binaries.
- Preserved the bundle identifier, credential identifiers, account/profile storage,
  settings schema and encrypted-settings allowlists. Legacy `autoUpdate` is inert.
  The two former reminder-storage keys are neither read nor rewritten.
- Manual trusted signed Windows installer upgrades remain the intended upgrade
  path. Their live-profile preservation requires the isolated acceptance below.

## Browser evidence

The new `app/tests/e2e/updates-removed.spec.ts` was added before implementation.
Three targeted cases failed against the original app: updater checks were recorded
and both valid/malformed legacy metadata produced version reminders. This confirms
the absence assertions detect the retired behavior.

Journeys cover English/Spanish, authenticated/sign-in shells, legacy true/false and
default settings, reset, encrypted-settings restore, reload, unavailable reminder
storage, startup delay, multiple six-hour horizons and hidden-to-visible resume.
They require zero updater IPC, updater-related restart or release-page opening,
and preserve ordinary file navigation and unrelated settings persistence.

Tests use controlled Telegram/Tauri boundaries. They do not establish absence of
native HTTP traffic or prove a signed installer upgrade over a real profile.
Validation uses a dedicated local port with server reuse disabled: the default
Playwright port can already belong to another worktree.

Production-preview verification passed **42/42** selected journeys on 2026-11-07:
all **12/12** update-removal regressions, authentication, desktop reliability,
PDF rendering and text/protected-text editing. This also exercises the final
shared-runtime bundle layout and confirms About still reports the installed
version. The settings-reset journey handles the existing crash-consent and
onboarding prompts rather than suppressing those unrelated features.

The complete development/browser/visual suite subsequently passed **159/159**
with one worker and no retries, including all update-removal, localization,
accessibility, account-isolation, transfer, encryption/recovery and existing
visual journeys. No snapshots or regression ceilings were relaxed.

## Static checks

Passed: test-policy, application-security, Rust formatting policy, baseline expiry,
workflow pinning, frontend localization validation/UI-literal budget, Node license
policy, Rust advisory-baseline validation, `cargo fmt --check`, and
`cargo clippy --locked --features native-e2e --lib --all-targets -- -D warnings`.
These checks do not substitute for behavioral or installed acceptance.

The assurance CLI suite passed **15/15** journeys and the packaged-startup CLI
suite passed **20/20**, using portable PowerShell 7.6.9. An earlier assurance run
passed 14/15 because the unchanged child fixture missed its two-second readiness
deadline; the complete rerun passed without changing deadlines or guards. These
are controlled child-process journeys, not an installed application smoke or
signed-upgrade acceptance.

The unchanged npm dependency versions currently have audit findings:
`source-map-js@1.2.1` (GHSA-68fv-2mgg-jv7q) and `vite@7.3.6` (including high
GHSA-587h-7wmj-h5pm and the reported lower-severity advisories). The npm audit
baseline contains no approved ignores. No dependency upgrades or baseline waivers
were added. The audit wrapper also encounters Windows `spawnSync npm ENOENT`;
direct `npm.cmd audit --prefix app --json` returned the findings above.

The live Rust gate (`cargo-deny 0.18.7`) passed bans, licenses and sources, but
failed advisories against unchanged surviving dependency versions: `actix-files`,
`actix-http`, `actix-web`, `rustls-webpki`, `tokio`, `webpki-roots`, `zip`, `zstd`,
`zstd-safe` and `zstd-sys`. Findings include RUSTSEC-2026-0443, 0446–0448, 0455,
0381–0382, 0386, 0367–0369, 0429, 0391, 0395–0406 and 0410. Updating these
dependencies is a separate security migration; no advisory ignores or unrelated
upgrades were added. Passing baseline validation is not a passing live audit.

## Bundle placement

Removing the eager banner also removed its eager Framer Motion import. Rollup
then charged the existing shared motion engine to the lazy dashboard, exceeding
the unchanged route ceiling. A pristine-base build confirmed this was a chunk
placement consequence of this removal, not new dashboard functionality.
`app/vite.config.ts` now explicitly groups React and the shared motion runtime,
preserving their earlier eager loading boundary. No dependency, budget ceiling,
budget calculation or lazy feature entry point was changed to hide the issue.

`npm run build:verify --prefix app` passed TypeScript, production bundling and all
unchanged ceilings: initial JavaScript 477,316/513,000 bytes, total JavaScript
2,392,317/3,300,000 bytes and dashboard route 282,059/302,000 bytes. Initial and
total JavaScript are smaller than the pristine-base build (485,525 and 2,405,485
bytes respectively).

## Native regression evidence

The complete native E2E run with two test threads completed **244 passed, 1
failed, 0 ignored**. The failure was
`heic_memory_threshold_terminates_a_touching_decoder_process`, which received
`HEIC_MEMORY_MONITOR_UNAVAILABLE` instead of the expected memory-control result.
The exact isolated rerun passed **1/1** with one test thread. This establishes
that the case can pass, not that the full suite had a clean run: the monitor
failure remains recorded as intermittent. No native tests, process memory
controls or timeouts were changed for this removal.

Follow-up investigation (2026-11-07, no dependency changes): the unchanged test
passed **40/40** sequential repetitions, and the complete HEIC subset passed
**19/19** with two test threads. Source inspection locates the reported error in
`process_budget.rs`: when process sampling fails and an immediate exit check
does not observe completion, the runner refuses unmonitored work, terminates the
process tree/job and reaps the child. It does not accept a successful decode.
An exit/sampling race is a hypothesis, not an established root cause; the earlier
failure did not capture per-process status, so it cannot even identify whether
the version probe or conversion produced the error. The E2E assertion now obtains
that status and the allocation-denial marker before asserting, without changing
accepted outcomes, safety controls, deadlines or production behavior. The fresh
complete native run with two test threads passed **245/245, 0 failed, 0 ignored**
in 926.49 seconds, including the previously failing case. This is a clean full
rerun, not proof that the intermittent sampling failure's cause was fixed.
Test-policy, application-security, Rust formatting policy, `cargo fmt --check`
and `git diff --check` also passed after the diagnostic-only test change.

An earlier unrestricted-parallel run passed 228/245 with 17 failures under heavy
host resource pressure; the bounded run passed all of those previously failing
journeys. The interrupted runs requested by the owner have no final result and
are not counted as passes.

## Windows build evidence

`npm run tauri --prefix app -- build --ci --no-sign` completed the optimized
Windows executable and NSIS installer. The normal wrapper revalidated the
Microsoft-signed VC runtime; no signing, installer or disposable-profile guards
were bypassed. The bundle-budget check passed again on the packaged frontend.

- Artifact: `app/src-tauri/target/release/bundle/nsis/Telegram Drive_4.1.2_x64-setup.exe`
- Size: 33,974,651 bytes
- SHA-256: `097D908575B4A140261DEA317B4D6E0E9DA541B9778ACF32CCF01867CED5839D`
- Authenticode: **NotSigned**, using `--no-sign` for local verification.
- A release-only warning reports unused `Uploaded.parts`/`Uploaded.resumed` fields
  in unchanged multipart code. The build succeeded; it is not a lint-pass claim
  for that release configuration.

This local artifact was **not installed or launched** and is not a signed release
or evidence of profile-preserving upgrade acceptance. Release publication,
production Authenticode/updater-sidecar signing and installed startup remain
unverified here.

## Remaining release acceptance

The follow-up environment check found no usable Windows Sandbox, Hyper-V VM
management, VirtualBox or VMware installation, and this session is not elevated
or running in disposable CI. A running host hypervisor alone is not an available
disposable test VM. The candidate installer is unsigned (see above). The owner
selected **Keep installed acceptance blocked** when asked to provide an isolated
Windows VM/runner and trusted signed old/new installers. No installer was run,
no personal profile was used, and no guard was bypassed. Completion requires
those prerequisites plus coordinated access to disposable test accounts/data.

Do not run the installer smoke on the owner's personal Windows profile or fake
its disposable-CI guard. In a disposable Windows CI user/VM:

1. Install the modified build and capture **native-process network traffic** over
   startup, elapsed old check horizons, resume and Settings interaction. Require
   no former manifest requests, updater artifact downloads, install or restart.
2. Seed old pending/last-seen metadata and restore legacy settings; require no
   update/reminder surfaces and continued file navigation/settings functionality.
3. Exercise sign-in/out, account switching, previews, transfers, vault/recovery,
   restart/session restore and tray behavior with controlled test data.
4. Upgrade an isolated older profile using a trusted signed installer. Verify
   credentials, accounts, databases, settings, encrypted data and transfer state
   survive, and no What's New dialog appears.

No production signing secrets, personal Telegram data or installed profiles have
been modified for this work. The owner subsequently authorized creating and merging
a pull request; this does not authorize publishing a signed release or waive the
remaining installed-acceptance and dependency-audit gates.
Implementation steps 1–5 are complete. Plan steps 6–7 remain unchecked because
live dependency audits failed and disposable installed/signed-upgrade acceptance
is still pending, despite the latest clean full native run. Follow-up project todos
record these gates; none was silently waived.
