/* Pro Meet analytics helper.
 * - deviceId(): the unique visitor ID (a random id kept in this browser's localStorage, never personal data).
 * - track(event, detail): sends an event to the Apps Script. If the visitor is signed in to Firebase, their token is
 *   attached so the server can record the login status (google / guest). Meeting create/join and file upload/download
 *   are recorded by the server itself, so they are not sent from here.
 * - Also usable from any script as window.proMeetTrack('whiteboard_open'). whiteboard.js calls track() itself for opens and drawing; saves are logged by the server.
 * Allowed events: page_view, login, logout, whiteboard_open, whiteboard_draw, whiteboard_save, notes_save, file_share, meeting_leave */
import { SCRIPT_URL } from './meet-config.js';
import { getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

export function deviceId() {
  let id = '';
  try { id = localStorage.getItem('pm_dev') || ''; } catch {}
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem('pm_dev', id); } catch {}
  }
  return id;
}

export async function track(event, detail) {
  try {
    if (!SCRIPT_URL || SCRIPT_URL.includes('PASTE')) return;
    let token = '';
    try { const a = getApps()[0], u = a && getAuth(a).currentUser; if (u) token = await u.getIdToken(); } catch {}
    const room = decodeURIComponent(location.hash.slice(1)).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
    fetch(SCRIPT_URL, {
      method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // text/plain avoids a CORS preflight
      body: JSON.stringify({ action: 'track', event, detail: detail || '', device: deviceId(), token, room, page: location.pathname, platform: navigator.platform || '' })
    }).catch(() => {});
  } catch {}
}
window.proMeetTrack = track;
