/**
 * NOTIFICATIONS seam (REQ-MOB-006).
 * Web uses the browser Notification API (foreground / PWA); React Native injects UNUserNotificationCenter (iOS)
 * or NotificationManagerCompat (Android) via `setNotificationProvider(...)`.
 */
export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface NotificationPayload {
  id: string;
  title: string;
  body: string;
  severity?: 'info' | 'warning' | 'critical';
  silent?: boolean;
}

export interface NotificationProvider {
  readonly name: string;
  readonly supported: boolean;
  permission(): NotificationPermissionState;
  requestPermission(): Promise<NotificationPermissionState>;
  notify(payload: NotificationPayload): Promise<boolean>;
  cancel(id: string): void;
}

const activeWeb = new Map<string, Notification>();

export const webNotificationProvider: NotificationProvider = {
  name: 'web-notifications',
  get supported() {
    return typeof window !== 'undefined' && 'Notification' in window;
  },
  permission() {
    if (!this.supported) return 'unsupported';
    return window.Notification.permission;
  },
  async requestPermission() {
    if (!this.supported) return 'unsupported';
    try {
      return await window.Notification.requestPermission();
    } catch {
      return 'denied';
    }
  },
  async notify(payload) {
    if (!this.supported || window.Notification.permission !== 'granted') return false;
    try {
      activeWeb.get(payload.id)?.close();
      const n = new window.Notification(payload.title, {
        body: payload.body,
        tag: payload.id,
        silent: payload.silent,
      });
      activeWeb.set(payload.id, n);
      n.onclose = () => {
        if (activeWeb.get(payload.id) === n) activeWeb.delete(payload.id);
      };
      return true;
    } catch {
      return false;
    }
  },
  cancel(id) {
    activeWeb.get(id)?.close();
    activeWeb.delete(id);
  },
};

let current: NotificationProvider = webNotificationProvider;

export function getNotificationProvider(): NotificationProvider {
  return current;
}

export function setNotificationProvider(provider: NotificationProvider | null): void {
  current = provider ?? webNotificationProvider;
}
