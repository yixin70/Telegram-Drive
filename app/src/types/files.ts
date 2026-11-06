import type { EncryptionState, FileEncryptionInfo } from './encryption';

export interface TelegramFile {
  id: number;
  name: string;
  size: number;
  sizeStr: string;
  created_at?: string;
  type?: 'folder' | 'file';
  folder_id?: number | null;
  /** Presentation only; mutations always use folder_id and message identity. */
  folder_path?: string;
  encryption?: FileEncryptionInfo;
  encryption_state?: EncryptionState;
  mime_type?: string;
  file_ext?: string;
  is_favorite?: boolean;
  is_pinned?: boolean;
  last_opened_at?: number;
  offline_available?: boolean;
}

export type SmartView = 'recents' | 'favorites' | 'pinned' | 'offline';

export interface OfflineCacheStatus {
  file_count: number;
  total_bytes: number;
  max_files: number;
  max_bytes: number;
}

export interface TelegramFolder {
  id: number;
  name: string;
  parent_id?: number | null;
  username?: string;
  /** Whether the channel has a public username set. */
  is_public?: boolean;
  group_id?: number | null;
  display_order?: number;
}

export interface FolderGroup {
  id: number;
  name: string;
  color_hex: string;
  display_order: number;
}

export interface FolderInviteInfo {
  link: string;
  is_public: boolean;
  username?: string;
}

export interface BandwidthStats {
  date: string;
  up_bytes: number;
  down_bytes: number;
  limit_bytes: number;
  period: 'weekly';
}
