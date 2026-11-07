# Encrypted folder names

In the Windows desktop sidebar, open a private folder's settings and choose
**Encrypt folder name**. Create/unlock the vault first (Settings → Encryption),
and keep a current vault recovery bundle somewhere safe.

The real name returns when that vault is unlocked. While locked, the folder is
shown as **Encrypted**, its descendants disappear from the app's folder tree,
and browsing those folders is refused. Search, recent/favorite/offline listings
withdraw their files. Rename remains available while unlocked and preserves
name encryption. WebDAV does not expose these folders, even while unlocked.
Folder public/invite actions are disabled for protected folders.

## What this protects—and what it does not

- The selected name is authenticated ciphertext in the current local layout and
  a text-only control message in its Telegram channel. Telegram's current channel
  title is replaced with a generic `Encrypted [TD-ENCRYPTED] [TD]` title.
- This **does not encrypt existing file contents, file names, captions, or child
  channel titles**. Choose file encryption separately. Hiding a subtree in this
  app is not Telegram access control; existing channel members and other Telegram
  clients can still access unencrypted content.
- Previous titles may remain in Telegram service messages, other devices,
  historical logs, backups, or old SQLite pages. This feature does not promise
  retroactive secure erasure. Existing offline downloads remain on disk.
- The same Telegram account and original vault key/recovery bundle are required
  to recover names on another installation. Creating a new vault with the same
  passphrase does not recreate the old key. Do not delete the control messages.
- Corrupt, missing-key, or wrong-account/folder metadata stays locked rather than
  falling back to a plaintext title. A failed scan retains the existing layout.
  Telegram history can still be deleted or rolled back by channel editors; this
  format does not provide remote anti-rollback guarantees.

## Interrupted operations

The app publishes recovery ciphertext and commits local protection before
masking the remote title. If the title update fails or its reply is lost, the
folder stays protected locally, but Telegram may still show the old title. The
app reports this explicitly. Unlock and choose **Encrypt folder name** again to
retry safely; the existing ciphertext is reused, not encrypted a second time.
An unlocked rename also repairs the generic remote title.

## Format

`TDFOLDERNAME1:` followed by standard base64 of a random 24-byte nonce and an
XChaCha20-Poly1305 ciphertext (including its authentication tag). The existing
vault wrapping key is used with authenticated additional data
`telegram-drive:folder-name:v1:{telegram_owner_id}:{channel_id}`. This binds the
name to both its account and folder. Records are bounded to 1024 bytes; names
are limited to 120 Unicode characters without control characters. Locking
revokes the session projection; decrypted names are not written back to layouts
or hierarchy backups.

## Release acceptance (not covered by controlled fixtures)

With a disposable Telegram account and a packaged Windows app: encrypt a private
folder with a child and ordinary/encrypted files, verify the generic title in
Telegram Desktop, lock during a refresh and during encryption/rename, restart,
and recover the vault on a separate clean installation. Confirm names restore,
children remain hidden while locked, external title edits cannot downgrade the
cached protection, and no ordinary transfers regress. Exercise missing control
messages and a disconnected/ambiguous title update. These live Telegram and
installed-WebView checks remain required before release.
