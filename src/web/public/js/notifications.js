// Browser notifications. Opt-in: the user explicitly enables in Settings.
// We throttle so a fast queue doesn't spam the system tray.

const KEY = 'tgdl-notifications-enabled';

let lastBatch = { ts: 0, count: 0 };

export function isSupported() {
    return typeof window !== 'undefined' && 'Notification' in window;
}

export function isEnabled() {
    return isSupported() && localStorage.getItem(KEY) === '1' && Notification.permission === 'granted';
}

export async function requestEnable() {
    if (!isSupported()) return false;
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') return false;
    localStorage.setItem(KEY, '1');
    return true;
}

export function disable() {
    localStorage.removeItem(KEY);
}

export function notifyDownloadComplete(payload) {
    if (!isEnabled()) return;
    // Coalesce: bursts of completions within 4s become a single "5 files done" notification.
    const now = Date.now();
    if (now - lastBatch.ts < 4000) {
        lastBatch.count += 1;
        return;
    }
    lastBatch = { ts: now, count: 1 };
    const fileName = payload?.filePath ? payload.filePath.split(/[\\/]/).pop() : 'a file';
    new Notification('Download complete', {
        body: fileName,
        icon: '/favicon.ico',
        tag: 'tgdl-download',
    });
}

export function flushPending() {
    if (lastBatch.count > 1 && isEnabled()) {
        new Notification(`${lastBatch.count} downloads complete`, { tag: 'tgdl-batch' });
    }
    lastBatch = { ts: 0, count: 0 };
}
