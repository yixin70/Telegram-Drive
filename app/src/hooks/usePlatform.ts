// The application ships only for Windows; browser fixtures use the same shell.
export function usePlatform() {
  return { isMobile: false, isDesktop: true, isAndroid: false };
}
