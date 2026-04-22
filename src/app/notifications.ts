//! Wrapper around the Tauri notification plugin with lazy permission prompt
//! and a simple background-only policy.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  type Options as NotificationOptions,
} from "@tauri-apps/plugin-notification";

export interface NotificationGate {
  /**
   * Send a notification if the window is currently not focused.
   * No-ops if permission is denied or the request is still pending.
   */
  notifyBackground(options: NotificationOptions): void;
}

export function createNotificationGate(win: Window): NotificationGate {
  let permission: "unknown" | "granted" | "denied" = "unknown";

  void (async () => {
    try {
      permission = (await isPermissionGranted()) ? "granted" : "denied";
      if (permission === "denied") {
        const response = await requestPermission();
        permission = response === "granted" ? "granted" : "denied";
      }
    } catch {
      permission = "denied";
    }
  })();

  return {
    notifyBackground(options) {
      if (permission !== "granted") {
        return;
      }
      if (win.document.hasFocus()) {
        return;
      }
      try {
        sendNotification(options);
      } catch {
        /* best effort */
      }
    },
  };
}
