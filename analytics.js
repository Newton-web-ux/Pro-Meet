/* Pro Meet analytics helper.
 * - deviceId(): the unique visitor ID (a random id kept in this browser's localStorage, never personal data).
 * - track(event, detail, opts): sends an event to the Apps Script. If the visitor is signed in to Firebase, their token is
 *   attached so the server can record the login status (google / guest). Meeting create/join and file upload/download
 *   are recorded by the server itself, so they are not sent from here.
 * - Traffic sources (Code.gs v13): page_view events also carry document.referrer and an optional utm_source / ?ref= value,
 *   so the server can classify where the visitor came from (Google, Bing, WhatsApp, Direct ...). Other events do not send
 *   them, so a device's first source is never recorded wrongly as Direct.
 * - Bots: browsers that look like crawlers or automation (navigator.webdriver, or a bot-like user agent) send nothing.
 *   The user agent and the webdriver flag are also sent, so the server (isBot_ in Code.gs v11) can ignore any that slip through.
 * - v15: INDEX PAGE CLICKS. On the home page (/, /index, /index.html) any element with a data-track="some_id" attribute
 *   sends an 'index_click' event with that id as the detail. The listener runs in the capture phase and uses a cached
 *   sign-in token (opts.fast), so the request is sent before the browser navigates away from the page.
 *   The server only accepts ids made of a-z, 0-9 and _ (max 40 characters).
 * - Also usable from any script as window.proMeetTrack('whiteboard_open'). whiteboard.js calls track() itself for opens and drawing; saves are logged by the server.
 * Events the server accepts from here: page_view, login, logout, whiteboard_open, whiteboard_draw, meeting_leave, index_click
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

/* Cached Firebase ID token, so click events do not have to wait for an async token call before the page navigates away.
 * Stays empty on pages that do not start Firebase (the server then falls back to the device id). */
let cachedTok = '';
async function refreshTok() {
  try { const a = getApps()[0], u = a && getAuth(a).currentUser; cachedTok = u ? await u.getIdToken() : ''; } catch {}
}
setTimeout(refreshTok, 1500);
setInterval(refreshTok, 20 * 60 * 1000);

export async function track(event, detail, opts) {
  try {
    if (BOT) return;
    if (!SCRIPT_URL || SCRIPT_URL.includes('PASTE')) return;
    const fast = !!(opts && opts.fast);
    let token = '';
    if (fast) token = cachedTok;
    else { try { const a = getApps()[0], u = a && getAuth(a).currentUser; if (u) { token = await u.getIdToken(); cachedTok = token; } } catch {} }
    /* On the home page the hash is a section anchor (#features ...), not a room, so clicks carry no room. */
    const room = event === 'index_click' ? '' : decodeURIComponent(location.hash.slice(1)).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);

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

/* ---- v15: index page click tracking ---- */
const IS_INDEX = /^\/(index(\.html)?)?$/.test(location.pathname);
if (IS_INDEX) {
  document.addEventListener('click', e => {
    try {
      const t = e.target && e.target.closest ? e.target.closest('[data-track]') : null;
      if (!t) return;
      const id = String(t.getAttribute('data-track') || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
      if (id) track('index_click', id, { fast: true });
    } catch {}
  }, true);                                                      // capture phase: runs before any navigation handler
}
