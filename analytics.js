/* Pro Meet analytics helper.
 * - deviceId(): the unique visitor ID (a random id kept in this browser's localStorage, never personal data).
 * - track(event, detail, opts): sends an event to the Apps Script together with the best Firebase sign-in token it can find,
 *   so the server can record the login status (google / guest) and the Google email. Meeting create/join and file
 *   upload/download are recorded by the server itself, so they are not sent from here.
 * - Traffic sources (Code.gs v13): page_view events also carry document.referrer and an optional utm_source / ?ref= value.
 * - Bots: browsers that look like crawlers or automation (navigator.webdriver, or a bot-like user agent) send nothing.
 * - v15: INDEX PAGE CLICKS. On the home page (/, /index, /index.html) any element with a data-track="some_id" attribute
 *   sends an 'index_click' event with that id as the detail. The listener runs in the capture phase and uses a cached
 *   sign-in token (opts.fast), so the request is sent before the browser navigates away from the page.
 * - v16: GOOGLE EMAIL FIX. Why the email was missing:
 *     (a) the old code read auth.currentUser immediately on page load, but Firebase restores the saved sign-in a moment later,
 *         so the first events (page_view) were sent with NO token;
 *     (b) the old code only looked at the first Firebase app of the page. The dashboard signs in under the app named 'dash'
 *         (saved on this device), the meeting page uses the default app (saved for this tab only), and the home page has no
 *         Firebase at all, so a Google sign-in made on the dashboard was never seen by the other pages.
 *   Now bestToken() waits for every Firebase app on the page to finish restoring its sign-in, also opens the 'dash' app
 *   (read only, it never signs anyone in), and prefers a Google (non-anonymous, with email) user over an anonymous one.
 * - Also usable from any script as window.proMeetTrack('whiteboard_open').
 * Events the server accepts from here: page_view, login, logout, whiteboard_open, whiteboard_draw, meeting_leave, index_click */
import { SCRIPT_URL } from './meet-config.js';
import { getApps, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const UA = navigator.userAgent || '';
const WD = !!navigator.webdriver;
const BOT = WD || /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|curl|wget|python-requests|httpclient|scrapy|monitor|uptime/i.test(UA);

/* Same config as dashboard.html / meeting.html. Needed so the home page can read the dashboard's saved Google sign-in. */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD66Xgj2uhcBOzYhwTuAcn5_wxLxDMkCeA", authDomain: "pro-meet-9e44e.firebaseapp.com", projectId: "pro-meet-9e44e",
  storageBucket: "pro-meet-9e44e.firebasestorage.app", messagingSenderId: "360559567109", appId: "1:360559567109:web:0f9bd0d407db2a5365d76c"
};
const DASH_APP = 'dash';                                         // the app name dashboard.html signs in with

export function deviceId() {
  let id = '';
  try { id = localStorage.getItem('pm_dev') || ''; } catch {}
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem('pm_dev', id); } catch {}
  }
  return id;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);

/* Token of a Google user if one exists in any Firebase app, otherwise an anonymous token, otherwise ''. Never throws. */
async function bestToken() {
  try {
    /* Make sure the dashboard's app exists, so its saved Google sign-in can be read on pages that do not start it themselves.
       Opening an app never signs anyone in; it only restores what is already saved on this device. */
    let hasDash = getApps().some(a => a.name === DASH_APP);
    if (!hasDash) { try { initializeApp(FIREBASE_CONFIG, DASH_APP); } catch {} }
    let anon = '';
    for (const a of getApps()) {
      try {
        const au = getAuth(a);
        if (au.authStateReady) await withTimeout(au.authStateReady(), 2500);   // wait until the saved sign-in is restored
        const u = au.currentUser; if (!u) continue;
        const t = await u.getIdToken();
        if (!u.isAnonymous && u.email) return t;                                // a Google user wins
        if (!anon) anon = t;
      } catch {}
    }
    return anon;
  } catch { return ''; }
}

/* Cached token, so click events do not have to wait before the page navigates away. Refreshed at load and every 20 minutes. */
let cachedTok = '';
async function refreshTok() { cachedTok = await bestToken(); }
refreshTok();
setInterval(refreshTok, 20 * 60 * 1000);

export async function track(event, detail, opts) {
  try {
    if (BOT) return;
    if (!SCRIPT_URL || SCRIPT_URL.includes('PASTE')) return;
    const fast = !!(opts && opts.fast);
    let token = '';
    if (fast) token = cachedTok;
    else { token = await bestToken(); if (token) cachedTok = token; }
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
