# Local video notes

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

**Partial implementation; notes are not available in the app yet.** The native
storage and backup services are implemented and exercised through the isolated
child-process harness. This includes restart persistence, account/revision
boundaries, concurrent first use, durable move-journal primitives, bounded
import/export, conflict recovery and the frozen plain version-1 backup fixture.
The harness supplies synthetic identities at the controlled Telegram boundary;
it does not establish real Telegram identity verification or move integration.

Production IPC, native media binding, protected-note encryption/authorization,
lock revocation, hover/editor UI and Settings controls are **not implemented**.
Encrypted payload types currently validate structure only, not authentication;
they must not be exposed as readable notes or treated as verified file bindings.
The browser notes regression intentionally remains red until UI implementation.

Run the implemented native journeys from the repository root:

```powershell
cargo test --locked --manifest-path app/src-tauri/Cargo.toml --features native-e2e --test native_e2e notes_ -- --test-threads=1
```

Browser fixtures do not prove persistence or cryptography. Native tests use
synthetic accounts and private files, never a personal Telegram session. Full
native regression, optimized real-WebView IPC, packaged Windows dialogs,
replaced-EXE persistence and encrypted-video acceptance remain separate checks.
