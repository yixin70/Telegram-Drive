# In-app text files

`.txt` files up to 1 MiB can be previewed, edited and saved in the shared desktop/mobile text viewer. Save also works with Ctrl/Cmd+S. Closing or navigating away from an unsaved edit asks for confirmation.

## Protected documents

- Vault-protected files require the vault key. File-passphrase protection uses the existing masked passphrase dialog and a one-use native credential token.
- Hybrid files retain **both** their vault and file-passphrase access routes. Saving requires both original credentials; it never silently replaces a passphrase or drops a protection route.
- Protected editing requires an authenticated `.txt` filename in the envelope metadata. Legacy files without that metadata are not guessed from an untrusted display name.
- Decryption is authenticated through the final record before text is returned. Protected text is held in memory, not written to the ordinary preview cache or a plaintext temporary file. External-app opening is not offered for protected text.
- Saves use a fresh envelope, DEK, UUID and nonce prefix while preserving the authenticated filename, MIME type and optional sync path. Telegram receives ciphertext under an opaque name with the `TDENC2` marker, not the plaintext filename/content.
- Saving uploads a replacement message and records its envelope before deleting the original. The replacement has a new Telegram message ID. Failed or ambiguous sends are not automatically retried; a failure after publication can leave both messages, so refresh before retrying.
- Vault locking clears and closes the viewer, including unsaved text, and rejects late reads and stale saves. Reopen the document after unlocking. Account changes also revoke the viewer's access.

Text decoding follows the plain-text viewer: UTF-8 (including a UTF-8 BOM) is accepted, invalid sequences are replaced, and saves use UTF-8. This is not a lossless editor for arbitrary legacy encodings. Multipart documents remain unsupported.

## Regression coverage and limits

`app/tests/e2e/text-preview.spec.ts` covers the viewer, consecutive saves, credential prompts, failure retention and vault-lock cleanup using a controlled Tauri transport. Native `protected_text_` journeys exercise the production text/envelope service across child processes and persistent ciphertext storage; only Telegram transport is substituted. These do not replace live Telegram or Android/device release acceptance.
