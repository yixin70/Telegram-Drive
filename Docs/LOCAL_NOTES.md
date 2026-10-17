# Local video notes

## Using notes

In the desktop file grid or list, hover the notes icon beside a video to read its
note immediately, or focus the icon with the keyboard. Click or press Enter to
edit the multiline plain-text note. Save commits locally; Cancel never saves a
draft. Deleting a note requires confirmation. Notes do not modify Telegram
captions, filenames or uploaded video bytes, and are not synced to Telegram.

Settings → Advanced → Local notes shows the actual storage directory and provides
Open Notes Folder, Export Notes and Import Notes. Save exports outside the app's
data directory for disaster recovery. Choose a **new filename** when exporting:
existing files are never overwritten. Import first previews the record/conflict
counts; keeping existing notes is the default, and replacement requires explicit
confirmation. A verified pre-import database snapshot stays in `notes/backups/`.
Keep-both alternates and notes whose videos disappeared remain in later exports;
they are not automatically reattached by a matching filename.

Ordinary notes are readable without a vault. Protected notes require actual
successful authentication of the matching video envelope, not merely an unlocked
UI flag. For password-only files, click the generic notes icon and supply the file
passphrase; vault-backed files can use Unlock vault. No full video download is
necessary. Access expires after fifteen minutes and is revoked on lock, automatic
lock, sleep-triggered lock, sign-out or account change. Unlock again to resume.
Plaintext already seen or copied cannot be recalled or securely erased from all
browser/OS memory. Losing video/vault credentials can also lose protected notes;
exporting notes is not a substitute for the existing vault recovery backup.

The stable default storage folder is used; arbitrary live-folder relocation is
not supported. Initial identity verification needs the current Telegram file or
authenticated multipart manifest. Once preloaded, hovering never starts a network
request; a cold preload shows a loading popup immediately. External reuploads and
moves are not guessed by filename. Verified in-app moves retain notes, while
copies are separate videos. This first interface is desktop-only.

## Compatibility contract (version 1)

Notes are user content, not a cache. The stable location is
`app_data_dir()/notes/notes.db`, independent of the executable and workspace
inventory. Clearing caches, logging out, refreshing an inventory or replacing
the executable must not delete notes. Disk loss or deletion of app data still
requires a backup. Never change the application identifier incidentally.

One plain-text UTF-8 document belongs to one account and logical video. Native
code must validate its media identity; filenames alone are never identities.
Location aliases are mutable; note UUIDs and authenticated protection identities
are immutable. A verified move retains notes; copies do not inherit them.
Unmatched and deleted-video records remain recoverable through export.

The SQLite `user_version` is 1. Unknown newer versions are refused without
modifying the database. Every subsequent migration must make and verify a
SQLite-consistent backup first. Writes use transactions, FULL synchronous
durability and expected revisions. Revision conflicts never overwrite content.
Note payloads are limited to 65,536 UTF-8 bytes, excluding encryption overhead.

## Backup envelope

The published JSON envelope has exactly these fields:

```json
{
  "format": "telegram-drive-notes",
  "version": 1,
  "owner": "101",
  "exportedAt": 1792249800000,
  "records": []
}
```

Each record contains `id` (UUID), `owner` (decimal Telegram owner ID),
`identity` (bounded opaque media identity), `revision` (positive integer),
`createdAt`, `updatedAt` (Unix milliseconds), `aliases` (source folder/message
keys), and `payload`. A plain payload is `{"kind":"plain","text":"..."}`.
A protected payload is `{"kind":"encrypted","context":{...},"nonce":[...],
"ciphertext":[...]}`; its bounded, versioned authenticated context must contain
only wrapped-key/header material and opaque file identities, never secrets or
protected filenames. Protected records must never pass through a plain payload.
Protected payloads are defined by the native authorization implementation; do
not fabricate one by setting a frontend flag.

The encrypted context is versioned separately: `version: 1`, `noteId` (the
original authenticated notes UUID), `header` (bounded TDENC2 header bytes),
`fileUuid` (matching the parsed header), and `binding` (immutable opaque native
file/group identity). Import keep-both creates an unattached storage record with
a new UUID while retaining the original authenticated `noteId` and `binding`;
it cannot change ciphertext authentication or create a file association.

Backups are at most 67,108,864 bytes and 10,000 records. Reject unknown fields,
unsupported versions, invalid IDs, duplicate IDs/aliases, oversized payloads,
cross-owner records, or protection downgrades before changing storage. A backup
is not a signed document; encrypted records authenticate when opened using the
matching file credentials. Normal notes in backups are **plaintext**.
The database enforces the same account-wide limits at commit, reserving space
for the JSON envelope, so saved notes always fit a supported full-account export.

Import preview defaults to keeping existing records. Explicit replacement or
keep-both may resolve conflicts; keep-both preserves an unattached alternate.
Repeat imports are idempotent. The whole import commits transactionally after
a verified pre-import backup. Exports publish a synced private temporary file,
never an incomplete final backup. File paths are not part of the backup format.

## Protection and interface acceptance

Protected text is encrypted with XChaCha20-Poly1305 before SQLite and export.
The notes key is derived from an authenticated file DEK using a separate HKDF
domain. For multipart media, use the stable first-piece DEK after verifying the
manifest, not the manifest DEK which changes on moves. No keys/passwords cross
IPC. Per-file native authorization, account generation, capability expiry and
lock revocation are mandatory. An unlocked unrelated vault is insufficient.

The icon's hover/focus popup has no intentional timer or animation delay.
Readable notes are preloaded in bounded visible/overscan batches; a cold read
shows an immediate loading state. Never start a remote fetch just on hover.
Locked files disclose neither note existence nor text. Lock/account changes
clear previews and drafts, reject stale results, and revoke native access.

## Verification status

The implementation includes native media-bound IPC, encrypted file-scoped
capabilities, move integration, immediate hover/editor UI and Settings controls.
Browser journeys exercise the real interface through a controlled native
boundary. Native child-process journeys exercise actual SQLite, envelope/notes
cryptography, process restart, corruption rejection, account/revision boundaries,
parallel first use, move-journal recovery, bounded transactional import/export
and a frozen version-1 backup. The multipart journey uses the production manifest
and move implementation in all four protection modes with synthetic remote media.

Run the notes journeys from the repository root and `app/`, respectively:

```powershell
cargo test --locked --manifest-path app/src-tauri/Cargo.toml --features native-e2e --test native_e2e notes_ -- --test-threads=1
```

```powershell
npx playwright test tests/e2e/file-notes.spec.ts --workers=1
```

Browser fixtures do not prove persistence or cryptography. Native tests use
synthetic accounts and private files, never a personal Telegram session. Native
identity resolution uses real Telegram message/document IDs in production, but
live Telegram and installed-app acceptance are not established by controlled
transports. Packaged Windows file dialogs, replaced-EXE persistence, actual
encrypted-video acceptance and other OS/device testing remain separate checks.
No EXE is rebuilt by these tests.
