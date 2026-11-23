/**
 * SHARE SHEET & CLIPBOARD seam.
 * Web uses Web Share API + `navigator.clipboard`; React Native injects `Share.share` + native Clipboard via
 * `setShareProvider(...)`.
 */
export interface SharePayload {
  title: string;
  text?: string;
  url: string;
}

export interface ShareProvider {
  readonly name: string;
  canShare(): boolean;
  share(data: SharePayload): Promise<'shared' | 'cancelled' | 'failed'>;
  copyText(text: string): Promise<boolean>;
}

export const webShareProvider: ShareProvider = {
  name: 'web-share',
  canShare() {
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  },
  async share(data) {
    if (!this.canShare()) return 'failed';
    try {
      await navigator.share(data);
      return 'shared';
    } catch (e) {
      return (e as DOMException)?.name === 'AbortError' ? 'cancelled' : 'failed';
    }
  },
  async copyText(text) {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  },
};

let current: ShareProvider = webShareProvider;

export function getShareProvider(): ShareProvider {
  return current;
}

export function setShareProvider(provider: ShareProvider | null): void {
  current = provider ?? webShareProvider;
}
