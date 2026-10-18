# Nested folders

## Storage and scope

Each folder, including each child, is a **separate Telegram channel**. The app
stores parent links and sibling order; Telegram itself still displays flat
channels. Telegram channel limits, permissions and flood waits still apply.
Moving a folder changes only placement metadata: channel IDs, message IDs, file
bytes, encryption envelopes, multipart sets, notes and queued transfers stay put.
Moving individual files between channels is a different, existing operation.

Nesting does **not** inherit privacy, sharing, encryption or access. A parent's
invite link never grants access to its children. Channel creation is online-only
and creates a private channel. Recursive delete, share, download, drag-to-reparent
and local-directory-tree import are not part of this release.

## Navigation

- **Folders** is a folder overview, not Saved Messages. Saved Messages remains a
  separate storage destination with its existing null folder ID.
- The desktop sidebar expands ancestors. Breadcrumbs and child-folder cards open
  folders; each normal listing contains only that channel's own files.
- **Create folder** uses the open folder, or top level from the overview/smart
  views. The dialog names its destination. **New subfolder** is explicit.
- **Move folder** includes top level and full destination paths; self, descendants
  and the current parent are disabled. It never moves file bytes.
- Search scope is unchanged: a channel listing is not recursively searched;
  global/smart views remain global. Paths distinguish search results and pickers.
- Groups remain device-local. Root group filters include descendants of matching
  roots, without rewriting the descendants' existing group assignments. Expansion
  and selected location are also local and account-scoped.
- The mobile dashboard has breadcrumbs, child rows, touch-sized actions and
  parent/back navigation. The current shipping `App.tsx` entry point still selects
  the desktop shell; the mobile component's browser journey uses a development
  route. This change does not claim native Android routing/device acceptance.

## Automatic sync and privacy

The app loads its account-specific SQLite cache immediately, reconciles at
startup/resume/reconnection, and checks every **30 seconds while visible**.
Accepted local moves and ordering changes enter a durable outbox, including when
offline, and trigger reconciliation when connected. Failures back off from
60 seconds to five minutes; manual Sync can retry sooner. This is not an
instant-delivery guarantee and cannot run while the app/OS suspends execution.
The actual propagation target still needs real-Telegram acceptance.

The remote namespace is plain-text `TDHIERARCHY:` JSON messages in the account's
Saved Messages. It contains version/account ID, operation UUID, logical clock and
base, channel ID, parent ID, sibling order and deletion marker. It includes **no
names, file contents, notes, credentials or encryption keys**. Relationships and
IDs are nevertheless sensitive metadata. There is no additional application-layer
encryption or new key to recover: normal Telegram cloud privacy applies, **not
end-to-end encryption**. These text-only records are not file attachments and are
excluded from the media/file catalog. Do not delete or edit them casually.

Discovery uses fully paginated Telegram search, not a fixed recent-message
window. Operations are immutable and deduplicated by UUID. Replay uses logical
clock plus UUID ordering, not device time. Independent edits merge; incompatible
moves converge deterministically. Cyclic edges and deleted parents promote the
affected folder to top level with a conflict explanation. Users can move it again.
Tombstones prevent resurrection; replay never deletes channels or files remotely.
No history is compacted in this version: pruning requires a future verified
checkpoint/rebase protocol. Very large histories increase reconciliation cost.

**Synced** means a complete remote pull confirmed the outbox, not just that a local
write succeeded. Cached, syncing, pending, offline, error and conflict states are
distinct. Unknown channels cause a full inventory scan; unresolved channel access
is an error rather than a false success.

## Safety and recovery

SQLite schema version 5 adds nullable `parent_id`, its index and an owner-keyed
operation log. Old folders become roots; old saved layouts default to no parent.
Account guards validate session epochs and client ownership around remote awaits.
Local placement and outbox writes are transactional. Complete scans preserve
placement/order; incomplete scans are not proof that a parent was deleted.

All app, REST and WebDAV channel-deletion entry points reconcile first and block
folders with children. Move children elsewhere before deleting. An eligible leaf
deletion still deletes its Telegram channel under the existing warning/permission
rules. A child concurrently moved under a deleted parent survives at top level.

If Telegram creates a channel but local persistence fails, the error includes the
channel ID and the create dialog closes. Refresh inventory instead of blindly
retrying creation. A cached newly created channel with unpublished placement stays
visible and retries metadata publication without creating another channel.

Missing previously confirmed operations, corrupt records, incompatible versions,
partial reads or timeouts preserve cached data and pending edits and report a sync
error. Restoring the missing Saved Messages records is preferable. **Export layout
backup** and **Restore layout backup** in the overview provide explicit repair:

- Versioned, account-bound JSON; no files, names or secrets. Keep it private.
- Export requires a new filename and never overwrites an existing backup.
- Import is limited to 16 MiB, validates IDs, duplicates, history collisions,
  missing/deleted channels and cycles, and previews paths before confirmation.
- Apply is atomic and revalidated. Matching placements become new operations;
  other folders and retained history remain. Explicit repair republishes retained
  immutable metadata through the outbox. It never recreates deleted channels.

A fresh installation recovers from the remote log after discovering its channels.
If **all** remote history has been deleted and there is no local cache or backup,
the original tree cannot be recovered: this is indistinguishable from first use.
An intact older device or exported layout is needed for repair. Hierarchy backups
are not backups of Telegram file bytes, credentials, notes or vault keys.

## External clients and older apps

REST keeps its existing ID-based contracts. Old create requests create roots;
channel IDs and Saved Messages identity are unchanged. External writes share the
account-guarded create/delete service. The existing folder catalog is still flat.

**WebDAV remains a documented flat compatibility view**, including nested
channels as separate top-level directories. MKCOL creates roots; arbitrary-depth
paths are not partially supported. Parent deletion is blocked even in this flat
view. Renaming does not move a subtree. Older app versions display channels flat
and cannot organize the tree; use an updated app for placement changes.

## Verification boundary

Browser E2E journeys simulate native IPC. Native child-process journeys use real
SQLite/account layouts and a controlled remote-message transport, including two
independent stores, restart/offline edits, fresh recovery, retry deduplication,
cycles, delete races and backup repair. These are **not live Telegram tests**.
Release acceptance still requires two explicitly approved real devices/sessions
and disposable data, reconnect after offline editing, busy Saved Messages search,
channel create/delete failure recovery and native platform builds. No live
mutations or Android-source publication are authorized by these fixtures.
