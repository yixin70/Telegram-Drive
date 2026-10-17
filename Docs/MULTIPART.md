# Large files: TDMP1 transport

Local-file uploads automatically split when a normal document would exceed
2,000,000,000 bytes, including encryption overhead. Download the resulting logical
file through this version of Telegram Drive to reconstruct the original bytes.
The 5 TiB combined weekly quota is separate; Telegram restrictions and available
local disk space still apply. At most 4,096 pieces are supported.

## Encryption and compatibility

TDMP1 is a new transport container, **not a change to TDENC2**. Each protected
piece is an independent TDENC2 envelope with fresh randomness. The manifest uses
the same selected vault, file-passphrase, or combined protection. Original names,
MIME type, digests and piece references live inside that encrypted manifest; opaque
piece names and captions expose only a random group identifier and ordinal.
Multipart metadata is protected even if optional single-file metadata protection
was not selected. Existing single-document files and vault recovery are unchanged.

Older clients and Telegram itself cannot concatenate these objects. Do not edit,
forward only the manifest, rename, or delete individual pieces in Telegram. This
version hides confidently identified pieces and presents the manifest as one file.
Locked encrypted manifests show a generic name and no logical size. A file password
is requested for downloads and protected move/delete operations when necessary.

## Commit, verification and resource limits

The final document is the commit point. Its bounded `TDMP1\n` JSON payload records
version 1, UUID group, account and folder, protection mode, original metadata,
logical length/SHA-256, and ordered piece records. Each record binds its ordinal,
Telegram message/document identity, exact transport/plaintext lengths, SHA-256 of
transport bytes, and protected envelope UUID. Duplicate identities, invalid
ordering, excessive sizes/counts, scope changes and unknown schema fields fail
closed. Manifests and journals are bounded to 2 MiB. Standard SHA-256 checks detect
damage, not a malicious party who can replace an entire unencrypted collection.

Uploads read bounded ranges; encryption capacity includes the real header, key
slots, per-chunk authentication tags and final record. No full-size plaintext copy
is made. Downloads verify each piece, TDENC2 authentication/final record where
applicable, and whole-file length/SHA-256 into an owner-private sibling staging
file. Only verified results reach the normal atomic collision-policy publication
boundary. Errors and cancellation remove that staging file and preserve an existing
destination. Full destination disk capacity is required.

Piece and manifest transfers, verification reads and recovery reads use the normal
quota reservations and network pacing. Verification may consume additional download
quota. Logical progress reaches completion only after publication. Multipart
mutations are serialized within an account to prevent recovery-journal races.

## Restart and explicit cleanup

Account-scoped journals retain content identity, confirmed documents and pending
resumable headers. Protected journals are themselves encrypted. Retrying with the
same source and credentials verifies confirmed remote pieces before reusing them.
Windows holds a deny-write/delete source handle during the transfer. Source changes
start a fresh group; previous uncommitted references remain available for cleanup.
On other platforms, interrupted pending encrypted pieces start a fresh group rather
than risk reusing their envelope against changed plaintext.

If a previously committed set was moved or deleted, direct message lookup retires
its checkpoint so the same source can be uploaded again as a fresh group. Network
errors or delayed search indexing are not treated as proof of deletion; any old
uncommitted references remain available for explicit cleanup.

Cancellation does not silently delete confirmed remote objects. Retry the original
upload to resume. Advanced explicit cleanup is exposed through the native command
`cmd_multipart_recovery` (there is not yet a recovery settings panel):

- With `folderId`, `ownerId` and no `group`, list unlocked pending records.
- With the returned `group` and its exact `folderId`, remove only that uncommitted
  set. Supply a one-use `promptToken` from the existing password prompt for a
  per-file password; never persist a password in settings or pass it to mutation commands.
- Unlock the original vault first when required. The list cannot reveal records
  protected with unavailable credentials. A maximum of 128 records is scanned.
- Cleanup refuses any group with a committed manifest. Failure retains the journal
  so cleanup can be retried. Account changes cannot expose or clean another account.

A fresh installation needs only the remote collection, correct Telegram account,
and the original encryption credentials/recovered vault to download a committed
file; the uploading computer's journal or metadata cache is not required.

## File operations and other paths

Desktop move copies every document, publishes a rewritten destination manifest,
verifies destination bytes/references, then removes the original collection.
Deletion targets the complete set, manifest last, and checkpoints partial cleanup
for retry. Mixed multi-selection moves containing multipart files are rejected;
move one logical multipart file at a time. Multipart rename is explicitly rejected
rather than changing an authenticated name incidentally.

Local-file upload/download is the supported initial journey. URL/temp-file imports
that reach the common upload implementation use the same transport; their existing
download/import size limits still apply. Archive upload retains its existing input
limits. Folder Sync rejects oversized uploads and skips multipart remote entries.
REST and WebDAV listing intentionally omit these containers; raw serving,
transcoding/remux, archive extraction/download, sharing, offline-pack reads and
unsupported mutations reject them instead of returning manifest or piece bytes.
Android multipart download publication is explicitly unsupported
in this implementation; no Android device build or coverage is claimed.

### Original-quality protected media preview

The desktop media player can stream vault-backed multipart audio/video through
the authenticated loopback `/stream` route while the vault is unlocked (including
vault-and-passphrase files opened with their vault slot). MP4 uses the original
media rather than the unsupported remux/transcoding routes. Codec support still
depends on the WebView; this does not add transcoding. Standard and passphrase-only
multipart preview, thumbnails and other preview consumers remain unsupported;
download the logical file before opening those.

Each request authenticates the bounded manifest in its account/folder scope and
maps HTTP plaintext ranges across pieces. It checks referenced document identity,
envelope UUID, protection mode and length, and authenticates every returned TDENC2
record before delivery. Seeks fetch only the necessary records (plus bounded
header/CDN read-ahead); they do not stage a full plaintext file. Memory stays bounded
by a crypto record and bounded transport/output buffers, not the logical file size.
Responses use `Cache-Control: no-store`; credentials remain operation-scoped and
vault lock/account changes revoke in-flight requests and future seeks. Loopback
tokens, including operation credentials, must not be shared or logged.

A range does **not** verify unread content or claim the whole-file digest matched.
Whenever a complete piece is read, its final record, exact ciphertext length and
transport digest are checked before its last plaintext record is released. A full
logical read also verifies the whole-file digest before releasing its final bytes.
Errors truncate the response rather than delivering unauthenticated bytes. Already
delivered authenticated bytes cannot be recalled, and locking cannot erase bytes
already buffered by the player. HTTP quota/pacing applies to delivered plaintext;
manifest reads retain their existing separate accounting.

## Validation boundary

Native child-process tests use real journals, files, encryption, quota accounting
and atomic download publication with a controlled Telegram object transport and a
fixture-only tiny object limit. Browser tests exercise the UI with fixture IPC.
These do not establish live multi-GB Telegram acceptance, real-account cross-install
recovery, low-disk/storage-pressure behavior or device coverage; those require
separate authorized acceptance testing before relying on this for sole copies.
