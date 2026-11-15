/* Pro Meet · plan.js
 * One place that answers "what is this person allowed to do?". Limits come from the Apps Script
 * (LIMITS + approved payments in your sheet), never from the browser. Anyone who is not signed in
 * with Google, or whose plan expired, gets the Free limits.
 *
 * Usage in any page/module:
 *   import { getPlan, allows, upgradeMsg } from './plan.js';
 *   const p = await getPlan();                          // { plan, billing, expires, limits }
 *   if (!allows(p.limits, 'boards', boards.length)) return toast(upgradeMsg(p, 'boards'));
 */
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { SCRIPT_URL } from './meet-config.js';

const CFG = {
  apiKey: "AIzaSyD66Xgj2uhcBOzYhwTuAcn5_wxLxDMkCeA", authDomain: "pro-meet-9e44e.firebaseapp.com", projectId: "pro-meet-9e44e",
  storageBucket: "pro-meet-9e44e.firebasestorage.app", messagingSenderId: "360559567109", appId: "1:360559567109:web:0f9bd0d407db2a5365d76c"
};
/* Free limits are also the fallback when the server cannot be reached (fail closed). null = unlimited. */
export const FREE = { meetingMin: 30, boards: 1, pages: 5, meetings: 5, secluded: 5 };
const LABEL = { meetingMin: 'minutes per meeting', boards: 'whiteboards', pages: 'whiteboard pages', meetings: 'meetings', secluded: 'secluded meetings' };

const TTL = 120000, CK = 'pm_plan_cache';
let mem = null, pending = null, _auth = null;

/* The Firebase app named 'dash' (the Google sign-in) is created lazily, on first use. That keeps the
   page's own default app first in getApps(), which other scripts (whiteboard, notes, ...) rely on. */
function A() {
  if (!_auth) {
    _auth = getAuth(getApps().find(a => a.name === 'dash') || initializeApp(CFG, 'dash'));
    onAuthStateChanged(_auth, () => { mem = null; try { sessionStorage.removeItem(CK); } catch {} });   // account changed
  }
  return _auth;
}
const free = () => ({ plan: 'free', billing: null, expires: null, limits: { ...FREE } });
const firstUser = () => new Promise(res => { const off = onAuthStateChanged(A(), u => { off(); res(u); }); });

function remember(p, uid) { mem = { p, at: Date.now() }; try { sessionStorage.setItem(CK, JSON.stringify({ uid, at: Date.now(), p })); } catch {} return p; }

export function getPlan(force) {
  if (!force && mem && Date.now() - mem.at < TTL) return Promise.resolve(mem.p);
  return pending || (pending = load(force).finally(() => { pending = null; }));
}

async function load(force) {
  const u = await firstUser();
  if (!u || u.isAnonymous || !u.email) return remember(free(), '');
  if (!force) {
    try { const c = JSON.parse(sessionStorage.getItem(CK) || 'null'); if (c && c.uid === u.uid && Date.now() - c.at < TTL) { mem = { p: c.p, at: c.at }; return c.p; } } catch {}
  }
  if (!SCRIPT_URL || SCRIPT_URL.includes('PASTE')) return remember(free(), u.uid);
  try {
    const token = await u.getIdToken();
    const r = await fetch(SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'plan', token }) });
    const j = await r.json(); if (!j.ok) throw new Error(j.error || 'failed');
    return remember({ plan: j.plan, billing: j.billing, expires: j.expires, limits: { ...FREE, ...j.limits } }, u.uid);
  } catch { return mem ? mem.p : free(); }
}

/* count = how many the person already has. Unlimited (null) always passes. */
export const allows = (limits, key, count) => limits[key] == null || count < limits[key];
export const upgradeMsg = (p, key) => {
  const n = p.limits[key], name = p.plan[0].toUpperCase() + p.plan.slice(1);
  return name + ' plan allows ' + n + ' ' + (LABEL[key] || key) + '. Upgrade on the Pricing page for more.';
};

window.PM = { getPlan, allows, upgradeMsg, FREE };
