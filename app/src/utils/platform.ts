import { type as osType } from '@tauri-apps/plugin-os';

// Legacy transfer queue helpers retain their format, but Android is no longer
// a supported execution target. Never switch queue ownership based on a UA.
export const isAndroidPlatform: boolean = false;

export function isWindowsPlatform(): boolean {
  try {
    return osType() === 'windows';
  } catch {
    return typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);
  }
}
