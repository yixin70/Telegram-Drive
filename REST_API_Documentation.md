# Telegram Drive REST API — retired

The local REST API that this page used to describe (`http://127.0.0.1:8550/api/v1`, protected by an `X-API-Key` header) has been **removed** from Telegram Drive. This page is kept only as a retirement notice; the previous endpoint reference, request examples, error contract and OpenAPI document no longer apply.

## What this means for existing REST scripts

This is a **breaking change**. Any external script, integration or tool that called the REST API stops working:

- The REST server is no longer started, on the default port or a custom one.
- The settings and API-key commands that configured it are gone, so there is no way to enable it or generate a key.
- Requests to the former paths — including `/api/v1/health`, `/api/v1/openapi.json` and any protected operation — are no longer served by Telegram Drive.

There is no drop-in replacement listener on the old address.

## WebDAV is not a drop-in replacement

[WebDAV access](WEBDAV_GUIDE.md) remains a supported local, loopback-only integration, but it is **not** a full semantic replacement for the REST API:

- It has different authentication (a one-time capability URL rather than an API key) and a different address (`http://127.0.0.1:8551/dav/<private-token>/`).
- It is read-only unless file changes are explicitly enabled.
- It does not reproduce REST search, bulk/ZIP, reporting, storage-insight, thumbnail or media-metadata endpoint semantics.

Do not assume command-for-command or response-for-response compatibility.

## Upgrade and downgrade behavior

- No data migration was performed. A previously enabled `api_settings.json` in the application data directory is left in place but is **inert**: current builds read it nowhere and start no REST listener. No settings, session, vault, folder or database data is rewritten.
- Because that file is retained, reinstalling or rolling back to an **older REST-capable release** may honor its stored `enabled` setting and start the server again. Treat that as a deliberate downgrade choice; current releases do not expose the REST API.

## Removal release

The REST API was retired in an unreleased change set, and no released version number is assigned in this notice yet. See the [Changelog](CHANGELOG.md) for the entry and the [WebDAV guide](WEBDAV_GUIDE.md) for the supported local integration.
