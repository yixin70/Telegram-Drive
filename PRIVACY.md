# Telegram Drive Privacy Policy

Last updated: October 18, 2026

Telegram Drive is a local-first desktop and Android client. It does not operate a file-storage or Telegram account service and does not sell personal information.

> **Personal-use checkout:** Advertising and the optional paid supporter (ad-free license) system have been removed from this checkout. The application makes no requests to advertising providers, displays no sponsor placements, and contains no checkout, entitlement, or verification service. Descriptions of upstream release behavior that are not present here have been dropped.

## Data stored on your device

Application settings, transfer queues, cached thumbnails and previews, local activity flags, and encrypted vault material are stored locally. Cache controls in Settings can remove cached media without deleting files stored in Telegram.

## Data sent to Telegram

Authentication and file operations connect directly to Telegram using credentials supplied by the user. Folders are represented by private Telegram channels. Telegram receives the messages and file bytes necessary to provide those operations, subject to Telegram's own terms and privacy policy.

The Telegram API hash is stored in the desktop operating-system credential manager or Android Keystore, separately from ordinary JSON settings. A legacy plaintext API hash is retained only until secure migration succeeds. The non-secret API ID and Telegram session database remain in the application's local data directory.

## Crash reporting

Crash reporting is disabled by default and requires explicit consent. A report contains only the application version, operating-system platform, error type, timestamp, and sanitized function names. It excludes error messages, file names, paths, file contents, Telegram messages or identifiers, credentials, phone numbers, and user-entered values. Reporting can be disabled at any time in Settings; disabling it also clears queued reports.

## Local sharing servers

WebDAV, REST, and password-protected local links are disabled until enabled by the user. They listen on the addresses shown in Settings and use capability tokens, API keys, or passwords. Disabling a server or regenerating its credential revokes that access. Guest or anonymous WebDAV connections receive no token-scoped file access.

## User control

Users can clear caches, disable crash reporting, stop local servers, revoke share links, lock the encryption vault, and remove local settings. Files stored in Telegram remain governed by the user's Telegram account until the user deletes them. No payment records are collected because the application has no payment or entitlement feature.

Security reports should not include credentials or private file data. Contact the maintainer through [cameronamer.com](https://www.cameronamer.com) to arrange private disclosure.
