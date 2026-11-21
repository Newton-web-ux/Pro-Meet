/* Pro Meet — remote.js
   Remote control for shared screens.

   Flow
   1. A participant who is sharing their screen shows a "Request control" button on their tile to everyone else.
   2. The viewer sends a request; the sharer sees an Allow / Deny card.
   3. On Allow, the two browsers open a dedicated WebRTC data channel (signaling goes through Firestore at
      rooms/{room}/remote) and the viewer streams pointer, wheel and keyboard events as normalized coordinates.
   4. The sharer can end control at any time from the banner. Control also ends when sharing stops, when either
      person leaves, or when the data channel closes.

   How events are applied on the sharer's side
   - A browser page cannot inject operating-system input. Events are therefore applied in one of two ways:
     a) Local agent (optional): if a helper is listening on AGENT_URL, every event is forwarded to it as JSON so it
        can drive the real desktop. Message shapes are documented in forwardToAgent().
     b) In-page (default): events are replayed on the sharer's own Pro Meet page (buttons, chat, whiteboard, notes),
        with a visible remote cursor. This is the right mode when the shared surface is the Pro Meet tab itself.

   Firestore rules required (same access pattern as the signals collection):
     match /rooms/{room}/remote/{id} { allow read, write: if request.auth != null; }

   Load order: add  <script type="module" src="remote.js"></script>  after the main module. */

import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, addDoc, deleteDoc, onSnapshot, query, where }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const AGENT_URL = 'ws://127.0.0.1:8765';
const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
const REQUEST_TTL = 30000;     // how long the sharer has to answer
const CONNECT_TTL = 12000;     // how long the data channel has to open
const SIGNAL_TTL = 60000;      // ignore signals older than this
const MAX_RATE = 240;          // max accepted events per second on the sharer's side

const app = getApp(), auth = getAuth(app), db = getFirestore(app);
const $ = id => document.getElementById(id);

let room, uid, partCol, ctlCol;
let people = {};
let session = null;            // active control session
let pending = null;            // outgoing request awaiting an answer
let ask = null;                // incoming request awaiting a decision
let chain = Promise.resolve();
const unsubs = [];

/* ================= Boot ================= */
const boot = setInterval(() => {
  const m = $('meeting');
  if (!auth.currentUser || !m || m.classList.contains('hidden')) return;
  clearInterval(boot);
  start();
}, 400);

function start() {
  room = decodeURIComponent(location.hash.slice(1));
  uid = auth.currentUser.uid;
  if (!room) return;
  partCol = collection(db, 'rooms', room, 'participants');
  ctlCol = collection(db, 'rooms', room, 'remote');
  injectStyles();

  unsubs.push(onSnapshot(partCol, snap => {
    people = {};
    snap.docs.forEach(d => { people[d.id] = d.data(); });
    onRoster();
  }, () => {}));

  unsubs.push(onSnapshot(query(ctlCol, where('to', '==', uid)), snap => {
    const items = snap.docChanges().filter(c => c.type === 'added')
      .map(c => ({ ref: c.doc.ref, ...c.doc.data() })).sort((a, b) => a.ts - b.ts);
    items.forEach(s => {
      deleteDoc(s.ref).catch(() => {});
      if (Date.now() - s.ts > SIGNAL_TTL) return;
      chain = chain.then(() => onSignal(s)).catch(console.warn);
    });
  }));

  setInterval(decorate, 700);
  addEventListener('beforeunload', () => { if (session) send(session.peer, 'end', {}).catch(() => {}); });
}

const send = (to, type, data) => addDoc(ctlCol, { from: uid, to, type, data: JSON.stringify(data || {}), ts: Date.now() });
const nameOf = id => String(people[id]?.name || 'Someone').slice(0, 30);

function toast(text) {
  const box = $('toasts'); if (!box) return;
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = text; box.append(d);
  setTimeout(() => d.remove(), 3500);
}

/* ================= Roster reactions ================= */
function onRoster() {
  if (session) {
    const gone = !people[session.peer];
    const stopped = session.role === 'host' ? !people[uid]?.sharing : !people[session.peer]?.sharing;
    if (gone || stopped) endSession(true, gone ? 'The other person left' : 'Screen sharing stopped');
  }
  if (pending && !people[pending.to]?.sharing) clearPending();
  decorate();
}

/* Adds a "Request control" button to every remote tile that is sharing */
function decorate() {
  for (const id in people) {
    const t = $('t-' + id); if (!t) continue;
    let b = t.querySelector('.rc-btn');
    const show = id !== uid && !!people[id].sharing;
    if (!show) { b?.remove(); continue; }
    if (!b) {
      b = document.createElement('button'); b.className = 'rc-btn';
      b.onmousedown = e => e.stopPropagation();
      b.onclick = e => { e.stopPropagation(); onButton(id); };
      t.append(b);
    }
    const active = session?.role === 'viewer' && session.peer === id;
    const waiting = pending?.to === id;
    b.textContent = active ? 'Stop controlling' : waiting ? 'Requesting…' : 'Request control';
    b.classList.toggle('on', active || waiting);
  }
}
function onButton(id) {
  if (session?.role === 'viewer' && session.peer === id) return endSession(true, 'Control ended');
  if (pending?.to === id) return clearPending();
  if (session) return toast('End the current remote session first');
  if (pending) clearPending();
  requestControl(id);
}

/* ================= Signaling ================= */
async function onSignal(s) {
  let d = {}; try { d = JSON.parse(s.data); } catch {}
  switch (s.type) {
    case 'req': return onRequest(s.from, d);
    case 'cancel': if (ask?.from === s.from) closeAsk(); return;
    case 'deny':
      if (pending?.to === s.from) { clearPending(); toast(d.reason || nameOf(s.from) + ' declined remote control'); }
      return;
    case 'grant':
      if (pending?.to === s.from) { clearPending(); return beginViewer(s.from); }
      return;
    case 'offer': return onOffer(s.from, d);
    case 'answer':
      if (session?.peer === s.from && session.role === 'viewer') { await session.pc.setRemoteDescription(d); await flush(session); }
      return;
    case 'ice':
      if (session?.peer !== s.from) return;
      if (session.pc.remoteDescription) await session.pc.addIceCandidate(d).catch(() => {});
      else session.q.push(d);
      return;
    case 'end':
      if (session?.peer === s.from) endSession(false, 'Remote control ended by ' + nameOf(s.from));
      return;
  }
}
async function flush(s) { for (const c of s.q.splice(0)) await s.pc.addIceCandidate(c).catch(() => {}); }

function makePc(s) {
  const pc = new RTCPeerConnection(ICE);
  pc.onicecandidate = e => e.candidate && send(s.peer, 'ice', e.candidate.toJSON()).catch(() => {});
  pc.onconnectionstatechange = () => {
    if (session === s && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) endSession(true, 'Remote control connection lost');
  };
  return pc;
}

/* ================= Viewer: request and drive ================= */
function requestControl(id) {
  pending = { to: id, timer: setTimeout(() => { if (pending?.to === id) { send(id, 'cancel', {}).catch(() => {}); clearPending(); toast('No response to your control request'); } }, REQUEST_TTL + 3000) };
  send(id, 'req', { name: people[uid]?.name || 'Someone' }).catch(() => { clearPending(); toast('Could not send request'); });
  decorate();
}
function clearPending() {
  if (!pending) return;
  clearTimeout(pending.timer);
  const to = pending.to; pending = null;
  send(to, 'cancel', {}).catch(() => {});
  decorate();
}

async function beginViewer(peer) {
  const s = session = { role: 'viewer', peer, q: [], off: [] };
  s.pc = makePc(s);
  s.dc = s.pc.createDataChannel('ctl', { ordered: true });
  s.dc.onopen = () => { clearTimeout(s.timer); attachViewer(s); };
  s.dc.onclose = () => { if (session === s) endSession(true, 'Remote control ended'); };
  s.timer = setTimeout(() => { if (session === s && s.dc.readyState !== 'open') endSession(true, 'Could not open the control channel'); }, CONNECT_TTL);
  await s.pc.setLocalDescription(await s.pc.createOffer());
  send(peer, 'offer', s.pc.localDescription.toJSON());
}

function attachViewer(s) {
  const tile = $('t-' + s.peer), video = tile?.querySelector('video');
  if (!tile || !video) return endSession(true, 'Shared screen is not visible');
  s.tile = tile; s.video = video; s.focus = false;
  tile.classList.add('rc-live');
  banner('Controlling ' + nameOf(s.peer) + '\u2019s screen. Click outside the shared screen to use your own keyboard.', 'Stop');

  const emit = m => { if (s.dc.readyState === 'open') s.dc.send(JSON.stringify(m)); };
  const mods = e => (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  const skip = e => e.target.closest?.('.rc-btn, .pin');
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); s.off.push(() => target.removeEventListener(type, fn, opts)); };

  let moveRaf = 0, lastMove = null;
  on(tile, 'mousemove', e => {
    const p = norm(e, video); if (!p) return;
    lastMove = { t: 'move', ...p };
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (lastMove && s.dc.bufferedAmount < 65536) emit(lastMove);
    });
  });
  on(tile, 'mousedown', e => {
    if (skip(e)) return;
    s.focus = true; const p = norm(e, video); if (!p) return;
    e.preventDefault(); emit({ t: 'down', ...p, b: e.button, m: mods(e) });
  });
  on(tile, 'mouseup', e => {
    if (skip(e)) return;
    const p = norm(e, video); if (!p) return;
    e.preventDefault(); emit({ t: 'up', ...p, b: e.button, m: mods(e) });
  });
  on(tile, 'dblclick', e => {
    if (skip(e)) return;
    const p = norm(e, video); if (p) { e.preventDefault(); emit({ t: 'dbl', ...p }); }
  });
  on(tile, 'contextmenu', e => e.preventDefault());
  on(tile, 'wheel', e => {
    const p = norm(e, video); if (!p) return;
    e.preventDefault();
    emit({ t: 'wheel', ...p, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY), u: e.deltaMode });
  }, { passive: false });
  on(document, 'mousedown', e => { if (!tile.contains(e.target)) s.focus = false; }, true);

  const keyHandler = down => e => {
    if (!s.focus) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat && !down) return;
    emit({ t: 'key', d: down ? 1 : 0, k: e.key, c: e.code, m: mods(e) });
  };
  on(document, 'keydown', keyHandler(true), true);
  on(document, 'keyup', keyHandler(false), true);
  decorate();
}

/* Maps a pointer position to 0..1 coordinates of the shared surface (accounts for object-fit: contain) */
function norm(e, v) {
  const r = v.getBoundingClientRect(), vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return null;
  const k = Math.min(r.width / vw, r.height / vh), w = vw * k, h = vh * k;
  const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
  const x = (e.clientX - ox) / w, y = (e.clientY - oy) / h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: +x.toFixed(5), y: +y.toFixed(5) };
}

/* ================= Host: approve and apply ================= */
function onRequest(from, d) {
  if (!people[uid]?.sharing) return send(from, 'deny', { reason: 'Nothing is being shared right now' }).catch(() => {});
  if (session || ask) return send(from, 'deny', { reason: nameOf(from) === 'Someone' ? 'Busy' : 'The host is busy with another request' }).catch(() => {});
  const name = String(d.name || nameOf(from)).slice(0, 30);
  const card = document.createElement('div'); card.id = 'rc-ask';
  const t = document.createElement('div'); t.textContent = name + ' is asking to control your shared screen';
  const row = document.createElement('div'); row.className = 'rc-row';
  const ok = document.createElement('button'); ok.className = 'rc-ok'; ok.textContent = 'Allow';
  const no = document.createElement('button'); no.className = 'rc-no'; no.textContent = 'Deny';
  row.append(ok, no); card.append(t, row); document.body.append(card);
  ask = { from, card, timer: setTimeout(() => { send(from, 'deny', { reason: 'The request timed out' }).catch(() => {}); closeAsk(); }, REQUEST_TTL) };
  ok.onclick = () => {
    const peer = from; closeAsk();
    session = { role: 'host', peer, name, q: [], off: [], hits: [], cursor: null };
    session.timer = setTimeout(() => { if (session && !session.dc) endSession(true, 'Could not open the control channel'); }, CONNECT_TTL + REQUEST_TTL);
    send(peer, 'grant', {}).catch(() => {});
  };
  no.onclick = () => { send(from, 'deny', {}).catch(() => {}); closeAsk(); };
  toast(name + ' is asking for control');
}
function closeAsk() { if (!ask) return; clearTimeout(ask.timer); ask.card.remove(); ask = null; }

async function onOffer(from, d) {
  const s = session;
  if (!s || s.role !== 'host' || s.peer !== from || s.pc) return;     // only accepted from a viewer that was allowed
  s.pc = makePc(s);
  s.pc.ondatachannel = e => {
    s.dc = e.channel;
    s.dc.onopen = () => { clearTimeout(s.timer); attachHost(s); };
    s.dc.onmessage = ev => onHostMessage(s, ev.data);
    s.dc.onclose = () => { if (session === s) endSession(true, 'Remote control ended'); };
  };
  await s.pc.setRemoteDescription(d); await flush(s);
  await s.pc.setLocalDescription(await s.pc.createAnswer());
  send(from, 'answer', s.pc.localDescription.toJSON());
}

function attachHost(s) {
  banner(s.name + ' is controlling your screen', 'Stop control');
  connectAgent(s);
  s.cursor = document.createElement('div'); s.cursor.id = 'rc-cur';
  s.cursor.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l16 10-7 1.5L9.5 21 4 2z" fill="#f59e0b" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg><span></span>';
  s.cursor.querySelector('span').textContent = s.name;
  document.body.append(s.cursor);
  toast(s.name + ' now has control');
}

/* Optional local helper that performs real desktop input.
   Messages (JSON, one per event, coordinates normalized 0..1 of the shared display):
   {t:'hello', name}                          sent once on connect
   {t:'move'|'down'|'up'|'dbl', x, y, b?, m?} pointer events (b: 0 left, 1 middle, 2 right; m: modifier bitmask)
   {t:'wheel', x, y, dx, dy, u}               wheel/scroll (u: deltaMode)
   {t:'key', d:1|0, k, c, m}                  key down (d=1) / up (d=0) with KeyboardEvent key and code
   {t:'end'}                                  control ended */
function connectAgent(s) {
  try {
    const ws = new WebSocket(AGENT_URL);
    ws.onopen = () => { s.agent = ws; ws.send(JSON.stringify({ t: 'hello', name: s.name })); toast('Local desktop agent connected'); };
    ws.onclose = ws.onerror = () => { if (s.agent === ws) s.agent = null; };
  } catch {}
}
function forwardToAgent(s, m) {
  if (s.agent && s.agent.readyState === 1) { s.agent.send(JSON.stringify(m)); return true; }
  return false;
}

let rateWin = 0, rateCnt = 0;
function onHostMessage(s, raw) {
  if (session !== s) return;
  const now = Date.now();
  if (now - rateWin > 1000) { rateWin = now; rateCnt = 0; }
  if (++rateCnt > MAX_RATE) return;
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.t !== 'string') return;
  if ('x' in m) { m.x = clamp(+m.x); m.y = clamp(+m.y); }
  if (m.t === 'key') { m.k = String(m.k || '').slice(0, 24); m.c = String(m.c || '').slice(0, 24); }
  if (!['move', 'down', 'up', 'dbl', 'wheel', 'key'].includes(m.t)) return;
  if (forwardToAgent(s, m)) return;
  inject(s, m);
}
const clamp = v => Math.min(1, Math.max(0, isFinite(v) ? v : 0));

/* ================= In-page injection (default) ================= */
const down = { el: null, b: 0 };
function targetAt(X, Y) {
  const el = document.elementFromPoint(X, Y);
  return el && !el.closest('#rc-bar, #rc-ask, #rc-cur') ? el : null;
}
function fireMouse(el, type, X, Y, m) {
  const init = {
    bubbles: true, cancelable: true, composed: true, view: window, clientX: X, clientY: Y,
    button: m.b || 0, buttons: type.endsWith('down') ? 1 << (m.b || 0) : 0,
    ctrlKey: !!(m.m & 1), shiftKey: !!(m.m & 2), altKey: !!(m.m & 4), metaKey: !!(m.m & 8)
  };
  if (type.startsWith('pointer')) el.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 77, pointerType: 'mouse', isPrimary: true }));
  else el.dispatchEvent(new MouseEvent(type, init));
}
function inject(s, m) {
  if (m.t === 'key') return injectKey(m);
  const X = m.x * innerWidth, Y = m.y * innerHeight, el = targetAt(X, Y);
  if (s.cursor) { s.cursor.style.display = 'block'; s.cursor.style.transform = `translate(${X}px,${Y}px)`; }
  if (!el) return;
  switch (m.t) {
    case 'move':
      fireMouse(el, 'pointermove', X, Y, m); fireMouse(el, 'mousemove', X, Y, m); break;
    case 'down': {
      down.el = el; down.b = m.b || 0;
      fireMouse(el, 'pointerdown', X, Y, m);
      fireMouse(el, 'mousedown', X, Y, m);
      const f = el.closest('input, textarea, select, button, [contenteditable], [tabindex]');
      if (f) f.focus({ preventScroll: true }); else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      break;
    }
    case 'up':
      fireMouse(el, 'pointerup', X, Y, m); fireMouse(el, 'mouseup', X, Y, m);
      if (down.el && (m.b || 0) === down.b) {
        if (m.b === 2) fireMouse(el, 'contextmenu', X, Y, m);
        else if (!m.b && (el === down.el || down.el.contains(el) || el.contains(down.el))) el.click();
      }
      down.el = null; break;
    case 'dbl':
      fireMouse(el, 'dblclick', X, Y, m); break;
    case 'wheel': {
      const unit = m.u === 1 ? 16 : m.u === 2 ? innerHeight : 1;
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, view: window, clientX: X, clientY: Y, deltaX: m.dx, deltaY: m.dy, deltaMode: m.u || 0 }));
      const sc = scrollable(el); if (sc) sc.scrollBy(m.dx * unit, m.dy * unit);
      break;
    }
  }
}
function scrollable(el) {
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) return n;
  }
  return null;
}
function injectKey(m) {
  const a = document.activeElement, el = a && a !== document.body ? a : document.body;
  const init = {
    key: m.k, code: m.c, bubbles: true, cancelable: true, composed: true,
    ctrlKey: !!(m.m & 1), shiftKey: !!(m.m & 2), altKey: !!(m.m & 4), metaKey: !!(m.m & 8)
  };
  if (!m.d) return void el.dispatchEvent(new KeyboardEvent('keyup', init));
  const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
  if (!proceed || el === document.body || (m.m & 9)) return;
  const text = el.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea') || el.isContentEditable;
  if (!text) return void (m.k === 'Enter' || m.k === ' ' ? el.click?.() : 0);
  if (m.k.length === 1) document.execCommand('insertText', false, m.k);
  else if (m.k === 'Backspace') document.execCommand('delete');
  else if (m.k === 'Delete') document.execCommand('forwardDelete');
  else if (m.k === 'Enter') {
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) document.execCommand('insertLineBreak');
    else el.form?.requestSubmit?.();
  }
}

/* ================= Teardown ================= */
function endSession(notify, reason) {
  const s = session; if (!s) return;
  session = null;
  clearTimeout(s.timer);
  if (notify) send(s.peer, 'end', {}).catch(() => {});
  s.off?.forEach(f => f());
  s.tile?.classList.remove('rc-live');
  s.cursor?.remove();
  if (s.agent) { try { s.agent.send(JSON.stringify({ t: 'end' })); s.agent.close(); } catch {} }
  try { s.dc?.close(); } catch {}
  try { s.pc?.close(); } catch {}
  down.el = null;
  $('rc-bar')?.remove();
  if (reason) toast(reason);
  decorate();
}

/* ================= Banner and styles ================= */
function banner(text, label) {
  $('rc-bar')?.remove();
  const b = document.createElement('div'), t = document.createElement('span'), x = document.createElement('button');
  b.id = 'rc-bar'; t.textContent = text; x.textContent = label;
  x.onclick = () => endSession(true, 'Remote control ended');
  b.append(t, x); document.body.append(b);
}
function injectStyles() {
  if ($('rc-style')) return;
  const st = document.createElement('style'); st.id = 'rc-style';
  st.textContent = `
.rc-btn{position:absolute;top:8px;left:8px;z-index:3;background:rgba(0,0,0,.65);color:#fff;border-radius:8px;padding:5px 10px;font-size:12px;opacity:0;transition:opacity .15s,background .15s}
.tile:hover .rc-btn,.rc-btn.on{opacity:1}
.rc-btn:hover,.rc-btn.on{background:var(--acc,#3b82f6)}
.tile.rc-live{border-color:#f59e0b!important;cursor:crosshair}
#rc-bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:20;display:flex;gap:12px;align-items:center;max-width:calc(100% - 24px);background:#f59e0b;color:#111;padding:8px 14px;border-radius:12px;font-size:13px;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,.4)}
#rc-bar button{flex:none;background:#111;color:#fff;border-radius:8px;padding:5px 12px;font-size:12px}
#rc-cur{position:fixed;left:0;top:0;z-index:19;pointer-events:none;display:none;will-change:transform}
#rc-cur span{position:absolute;left:18px;top:16px;background:#f59e0b;color:#111;font-size:11px;font-weight:600;padding:2px 6px;border-radius:6px;white-space:nowrap}
#rc-ask{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:21;width:min(340px,calc(100% - 32px));background:var(--panel,#171c24);border:1px solid var(--line,#262d38);border-radius:12px;padding:14px;font-size:14px;box-shadow:0 10px 30px rgba(0,0,0,.5)}
#rc-ask .rc-row{display:flex;gap:8px;margin-top:12px}
#rc-ask button{flex:1;padding:8px;border-radius:8px;font-weight:600;color:#fff}
#rc-ask .rc-ok{background:var(--grn,#22c55e)}#rc-ask .rc-no{background:#222a36}`;
  document.head.append(st);
}
