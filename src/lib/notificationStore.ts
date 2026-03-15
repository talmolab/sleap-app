export interface NotificationEntry {
  id: number;
  timestamp: number;
  type: "success" | "error" | "info" | "warning";
  message: string;
  description?: string;
  read: boolean;
}

const MAX_ENTRIES = 200;
let nextId = 0;

/** Global notification buffer that persists across re-renders. */
export const notificationBuffer: NotificationEntry[] = [];
export const notificationListeners = new Set<() => void>();

function notify() {
  notificationListeners.forEach((fn) => fn());
}

export function pushNotification(
  type: NotificationEntry["type"],
  message: string,
  description?: string,
) {
  notificationBuffer.push({
    id: nextId++,
    timestamp: Date.now(),
    type,
    message,
    description,
    read: false,
  });
  if (notificationBuffer.length > MAX_ENTRIES) {
    notificationBuffer.splice(0, notificationBuffer.length - MAX_ENTRIES);
  }
  notify();
}

export function clearNotifications() {
  notificationBuffer.length = 0;
  notify();
}

export function markAllRead() {
  for (const entry of notificationBuffer) {
    entry.read = true;
  }
  notify();
}

export function getUnreadCount(): number {
  return notificationBuffer.filter((e) => !e.read).length;
}
