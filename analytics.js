/* Pro Meet analytics helper.
 * - deviceId(): the unique visitor ID (a random id kept in this browser's localStorage, never personal data).
 * - track(event, detail): sends an event to the Apps Script. If the visitor is signed in to Firebase, their token is
 *   attached so the server can record the login status (google / guest). Meeting create/join and file upload/download
 *   are recorded by the server itself, so they are not sent from here.
 * - Traffic sources (Code.gs v13): page_view events also carry document.referrer and an optional utm_source / ?ref= value,
 *   so the server can classify where the visitor came from (Google, Bing, WhatsApp, Direct ...). Other events do not send
 *   them, so a device's first source is never recorded wrongly as Direct.
 * - Bots: browsers that look like crawlers or automation (navigator.webdriver, or a bot-like user agent) send nothing.
 *   The user agent and the webdriver flag are also sent, so the server (isBot_ in Code.gs v11) can ignore any that slip through.
 * - Also usable from any script as window.proMeetTrack('whiteboard_open'). whiteboard.js calls track() itself for opens and drawing; saves are logged by the server.
 * Events the server accepts from here: page_view, login, logout, whiteboard_open, whiteboard_draw, meeting_leave
 * (whiteboard_save, notes_save and file_share are logged by the server on upload; if sent from here they are ignored). */
import { SCRIPT_URL } from './meet-config.js';
import { getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const UA = navigator.userAgent || '';
const WD = !!navigator.webdriver;
const BOT = WD || /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|curl|wget|python-requests|httpclient|scrapy|monitor|uptime/i.test(UA);

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
    if (BOT) return;
    if (!SCRIPT_URL || SCRIPT_URL.includes('PASTE')) return;
    let token = '';
    try { const a = getApps()[0], u = a && getAuth(a).currentUser; if (u) token = await u.getIdToken(); } catch {}
    const room = decodeURIComponent(location.hash.slice(1)).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);

    /* Traffic source: only page views carry it. utm_source / ?ref= (e.g. ?utm_source=whatsapp) wins over document.referrer. */
    let src = {};
    if (event === 'page_view') {
      const q = new URLSearchParams(location.search);
      src = { referrer: document.referrer || '', utm: q.get('utm_source') || q.get('ref') || '' };
    }

    fetch(SCRIPT_URL, {
      method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // text/plain avoids a CORS preflight
      body: JSON.stringify({ action: 'track', event, detail: detail || '', device: deviceId(), token, room, page: location.pathname, platform: navigator.platform || '', ua: UA, wd: WD, ...src })
    }).catch(() => {});
  } catch {}
}
window.proMeetTrack = track;
