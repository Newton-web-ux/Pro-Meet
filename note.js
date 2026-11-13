// note.js - meeting notes for Pro Meet: private notes + private drawing pad + shared live notes.
// Save to Drive (host sees it in Drive) or Share to room (also posts file cards in chat).
import { getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, deleteDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { SCRIPT_URL } from "./meet-config.js";

const $ = id => document.getElementById(id), W = 800, H = 600;
const KINDS = { note: '📝', action: '✅', decision: '⭐' };
const N = new Map();                                    // shared note id -> data
let db, auth, uid, room, col, open = false, started = false, firstSnap = true, tab = 'me';
let strokes = [], cur = null, tool = 'pen', color = '#111111', size = 4, cv, g;

const toast = t => { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; $('toasts').append(d); setTimeout(() => d.remove(), 3500); };
const myName = () => document.querySelector('#t-' + uid + ' .nm')?.textContent.replace(/ \(You\)$/, '') || 'Guest';
const hhmm = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
async function api(body) {
  const token = await auth.currentUser.getIdToken();
  const r = await fetch(SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, token }) });
  const j = await r.json(); if (!j.ok) throw new Error(j.error || 'request failed'); return j;
}

/* ---------- UI ---------- */
const css = document.createElement('style');
css.textContent = `#nt{width:360px;background:var(--panel);border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.nth{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line);font-size:14px}
.ntt{display:flex;border-bottom:1px solid var(--line)}.ntt button{flex:1;padding:10px 4px;color:var(--mut);font-size:13px}
.ntt button.on{color:var(--txt);border-bottom:2px solid var(--acc)}
.ntp{flex:1;display:flex;flex-direction:column;min-height:0;padding:10px;gap:8px}
#ntMine{flex:1;resize:none;background:#0b0e13;color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:12px;font:inherit;font-size:14px;line-height:1.5;outline:none;min-height:0}
#ntMine:focus{border-color:var(--acc)}
.ntb{background:#222a36;padding:7px 10px;border-radius:8px;font-size:13px}.ntb:hover{background:#2c3544}.ntb:disabled{opacity:.6}
.ntb.pri{background:var(--acc);color:#fff}.ntb.on{background:var(--acc);color:#fff}
#ntList{flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px;min-height:0}
.ntn{background:#222a36;border-radius:10px;padding:8px 10px;font-size:14px;word-break:break-word}.ntn.mine{background:#1e3a68}
.ntn small{display:flex;justify-content:space-between;gap:8px;color:var(--mut);font-size:11px;margin-bottom:2px}
.ntn small button{color:var(--mut);font-size:12px}.ntn small button:hover{color:var(--red)}
.nte{color:var(--mut);font-size:13px;text-align:center;padding:20px 10px}
.ntf{display:flex;gap:6px}.ntf select{background:#0b0e13;color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:0 6px;font:inherit;font-size:13px}
.ntf input{padding:9px 11px}
.nta{display:flex;gap:6px;padding:10px;border-top:1px solid var(--line)}.nta .ntb{flex:1;padding:8px 4px}
.ntd{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--red);margin-left:6px}
.ntdt{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.ntdt input[type=color]{width:32px;height:30px;padding:0;border-radius:8px;cursor:pointer}.ntdt input[type=range]{width:70px;padding:0}
.ntarea{flex:1;display:flex;align-items:center;justify-content:center;min-height:0}
#ntc{width:100%;max-height:100%;aspect-ratio:4/3;background:#fff;border-radius:10px;touch-action:none;cursor:crosshair}
@media(max-width:760px){#nt{position:fixed;inset:0;width:100%;z-index:6}}`;
document.head.append(css);

const btn = document.createElement('button'); btn.className = 'cb'; btn.id = 'ntBtn';
btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg><span>Notes</span><i class="dot hidden" id="ntDot">•</i>';
$('handBtn').after(btn);

const panel = document.createElement('aside'); panel.id = 'nt'; panel.className = 'hidden';
panel.innerHTML = `<div class="nth"><b>Meeting notes</b><button class="ntb" id="ntX">✕</button></div>
<div class="ntt"><button id="ntTabMe" class="on">📝 My notes</button><button id="ntTabDraw">✏️ Draw</button><button id="ntTabAll">👥 Shared<span class="ntd hidden" id="ntTabDot"></span></button></div>
<div class="ntp" id="ntPaneMe"><textarea id="ntMine" placeholder="Only you can see these notes. They are saved in this browser."></textarea>
<div><button class="ntb" id="ntStamp">⏱ Add timestamp</button></div></div>
<div class="ntp hidden" id="ntPaneDraw"><div class="ntdt">
<button class="ntb on" data-t="pen">✏️</button><button class="ntb" data-t="eraser">🧽</button><button class="ntb" data-t="line">╱</button><button class="ntb" data-t="rect">▭</button><button class="ntb" data-t="ellipse">◯</button><button class="ntb" data-t="text">T</button>
<input type="color" id="ntCol" value="#111111" title="Colour"><input type="range" id="ntSize" min="2" max="30" value="4" title="Size">
<button class="ntb" id="ntUndo">↩</button><button class="ntb" id="ntClr">🗑</button></div>
<div class="ntarea"><canvas id="ntc" width="${W}" height="${H}"></canvas></div></div>
<div class="ntp hidden" id="ntPaneAll"><div id="ntList"></div>
<form class="ntf" id="ntForm"><select id="ntKind"><option value="note">📝 Note</option><option value="action">✅ Action</option><option value="decision">⭐ Decision</option></select>
<input id="ntIn" placeholder="Add a shared note…" maxlength="500" autocomplete="off"><button class="ntb pri">Add</button></form></div>
<div class="nta"><button class="ntb" id="ntDl">⬇ Download</button><button class="ntb" id="ntDrive">☁ Save to Drive</button><button class="ntb pri" id="ntShare">📤 Share to room</button></div>`;
$('side').before(panel);
cv = $('ntc'); g = cv.getContext('2d');

function setTab(t) {
  tab = t;
  [['me', 'Me'], ['draw', 'Draw'], ['all', 'All']].forEach(([k, s]) => { $('ntPane' + s).classList.toggle('hidden', t !== k); $('ntTab' + s).classList.toggle('on', t === k); });
  if (t === 'all') { $('ntTabDot').classList.add('hidden'); $('ntList').scrollTop = 1e9; }
  if (t === 'draw') redraw();
}
function setOpen(v) {
  open = v; panel.classList.toggle('hidden', !v); btn.classList.toggle('act', v);
  if (v) { $('ntDot').classList.add('hidden'); setTab(tab); }
}
btn.onclick = () => { if (!room) return toast('Join a meeting first'); setOpen(!open); };
$('ntX').onclick = () => setOpen(false);
$('ntTabMe').onclick = () => setTab('me'); $('ntTabDraw').onclick = () => setTab('draw'); $('ntTabAll').onclick = () => setTab('all');

/* ---------- Private notes (localStorage, per room) ---------- */
const lsKey = () => 'promeet-notes-' + room, lsDraw = () => 'promeet-draw-' + room;
$('ntMine').oninput = e => { try { localStorage.setItem(lsKey(), e.target.value); } catch {} };
$('ntStamp').onclick = () => {
  const t = $('ntMine'), s = '[' + $('timer').textContent + '] ';
  t.setRangeText(s, t.selectionStart, t.selectionEnd, 'end'); t.focus(); t.dispatchEvent(new Event('input'));
};

/* ---------- Drawing pad (private, saved in this browser) ---------- */
function draw(c, s) {
  const p = s.pts; if (!p || p.length < 2) return;
  c.save(); c.lineCap = c.lineJoin = 'round'; c.lineWidth = s.tool === 'eraser' ? s.size * 3 : s.size; c.strokeStyle = c.fillStyle = s.color;
  c.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
  if (s.tool === 'pen' || s.tool === 'eraser') {
    c.beginPath(); c.moveTo(p[0] * W, p[1] * H); if (p.length === 2) c.lineTo(p[0] * W + .01, p[1] * H);
    for (let i = 2; i < p.length; i += 2) c.lineTo(p[i] * W, p[i + 1] * H); c.stroke();
  } else if (s.tool === 'text') { c.font = (s.size * 4 + 10) + 'px sans-serif'; c.textBaseline = 'top'; c.fillText(s.text || '', p[0] * W, p[1] * H); }
  else if (p.length >= 4) {
    const x0 = p[0] * W, y0 = p[1] * H, x1 = p[2] * W, y1 = p[3] * H; c.beginPath();
    if (s.tool === 'line') { c.moveTo(x0, y0); c.lineTo(x1, y1); }
    else if (s.tool === 'rect') c.rect(x0, y0, x1 - x0, y1 - y0);
    else c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, 7);
    c.stroke();
  }
  c.restore();
}
function redraw() { g.clearRect(0, 0, W, H); strokes.forEach(s => draw(g, s)); }
const saveDraw = () => { try { localStorage.setItem(lsDraw(), JSON.stringify(strokes)); } catch {} };
const pt = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height].map(v => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4); };

panel.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tool = b.dataset.t; panel.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('on', x === b)); });
$('ntCol').oninput = e => { color = e.target.value; }; $('ntSize').oninput = e => { size = +e.target.value; };
cv.addEventListener('pointerdown', e => {
  e.preventDefault(); const p = pt(e);
  if (tool === 'text') { const t = prompt('Text to add'); if (t && t.trim()) { strokes.push({ tool, color, size, pts: p, text: t.trim().slice(0, 200) }); saveDraw(); redraw(); } return; }
  cv.setPointerCapture(e.pointerId);
  cur = { tool, color, size, pts: tool === 'pen' || tool === 'eraser' ? p : [...p, ...p] }; strokes.push(cur); redraw();
});
cv.addEventListener('pointermove', e => {
  if (!cur) return; const p = pt(e);
  if (cur.tool === 'pen' || cur.tool === 'eraser') { if (cur.pts.length < 4000) cur.pts.push(...p); } else { cur.pts[2] = p[0]; cur.pts[3] = p[1]; }
  redraw();
});
const end = () => { if (cur) { cur = null; saveDraw(); } };
cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
$('ntUndo').onclick = () => { strokes.pop(); saveDraw(); redraw(); };
$('ntClr').onclick = () => { if (strokes.length && confirm('Clear your drawing?')) { strokes = []; saveDraw(); redraw(); } };
function png() { const o = document.createElement('canvas'); o.width = W; o.height = H; const c = o.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, W, H); c.drawImage(cv, 0, 0); return o.toDataURL('image/png'); }

/* ---------- Shared notes (Firestore) ---------- */
function render() {
  const l = $('ntList'); l.innerHTML = '';
  const items = [...N.entries()].sort((a, b) => a[1].ts - b[1].ts);
  if (!items.length) { const e = document.createElement('div'); e.className = 'nte'; e.textContent = 'No shared notes yet. Anything added here is visible to everyone in the room.'; l.append(e); return; }
  items.forEach(([id, n]) => {
    const d = document.createElement('div'), h = document.createElement('small'), who = document.createElement('span'), b = document.createElement('div');
    d.className = 'ntn' + (n.uid === uid ? ' mine' : '');
    who.textContent = (KINDS[n.kind] || '📝') + ' ' + (n.uid === uid ? 'You' : n.name || 'Guest') + ' · ' + hhmm(n.ts);
    h.append(who);
    if (n.uid === uid) { const x = document.createElement('button'); x.textContent = '🗑'; x.title = 'Delete'; x.onclick = () => deleteDoc(doc(col, id)).catch(() => toast('Could not delete note')); h.append(x); }
    b.textContent = n.text; d.append(h, b); l.append(d);
  });
  l.scrollTop = 1e9;
}
$('ntForm').onsubmit = e => {
  e.preventDefault(); const text = $('ntIn').value.trim(); if (!text || !col) return;
  addDoc(col, { uid, name: myName(), kind: $('ntKind').value, text: text.slice(0, 500), ts: Date.now() }).catch(() => toast('Could not save note (check Firestore rules)'));
  $('ntIn').value = '';
};

/* ---------- Export / Drive ---------- */
function exportText() {
  const out = ['Meeting notes · room ' + room + ' · ' + myName(), new Date().toLocaleString(), ''];
  out.push('=== My notes ===', $('ntMine').value.trim() || '(empty)', '', '=== Shared notes ===');
  const items = [...N.values()].sort((a, b) => a.ts - b.ts);
  if (!items.length) out.push('(none)');
  items.forEach(n => out.push('[' + hhmm(n.ts) + '] ' + (n.name || 'Guest') + ' (' + (n.kind || 'note') + '): ' + n.text));
  return out.join('\n');
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const who = () => myName().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'guest';
const base = () => room + '-' + who() + '-' + stamp();
const hasText = () => $('ntMine').value.trim() || N.size;

function download(href, name) { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); }
$('ntDl').onclick = () => {
  const url = URL.createObjectURL(new Blob([exportText()], { type: 'text/plain' }));
  download(url, 'notes-' + base() + '.txt'); setTimeout(() => URL.revokeObjectURL(url), 5000);
  if (strokes.length) setTimeout(() => download(png(), 'drawing-' + base() + '.png'), 300);
};
async function saveToDrive(share) {
  if (!SCRIPT_URL || SCRIPT_URL.includes('PASTE')) return toast('Google Drive is not set up yet (see meet-config.js)');
  if (!hasText() && !strokes.length) return toast('Nothing to save yet. Write a note or draw something first.');
  const bs = [$('ntDrive'), $('ntShare')], labels = bs.map(b => b.textContent);
  bs.forEach(b => { b.disabled = true; }); (share ? bs[1] : bs[0]).textContent = 'Saving…';
  try {
    const files = [];
    if (hasText()) { let bin = ''; new TextEncoder().encode(exportText()).forEach(c => bin += String.fromCharCode(c)); files.push({ name: 'notes-' + base() + '.txt', type: 'text/plain', data: btoa(bin) }); }
    if (strokes.length) files.push({ name: 'drawing-' + base() + '.png', type: 'image/png', data: png().split(',')[1] });
    for (const f of files) {
      const j = await api({ action: 'upload', room, ...f });
      if (share) await addDoc(collection(db, 'rooms', room, 'messages'), { uid, name: myName(), text: '[[drive:' + JSON.stringify({ id: j.id, name: j.name, size: j.size, type: j.type }) + ']]', ts: Date.now() });
    }
    toast(share ? 'Shared to the room: ' + files.length + ' file(s) posted in chat' : 'Saved to Google Drive (' + files.length + ' file(s))');
  } catch (e) { console.error(e); toast('Save failed (' + e.message + ')'); }
  bs.forEach((b, i) => { b.disabled = false; b.textContent = labels[i]; });
}
$('ntDrive').onclick = () => saveToDrive(false);
$('ntShare').onclick = () => saveToDrive(true);

/* ---------- Start when you join a meeting ---------- */
function start() {
  if (started) return; started = true;
  const app = getApps()[0]; auth = getAuth(app); db = getFirestore(app); uid = auth.currentUser?.uid;
  room = decodeURIComponent(location.hash.slice(1)); if (!uid || !room) { started = false; return; }
  col = collection(db, 'rooms', room, 'notes');
  try { $('ntMine').value = localStorage.getItem(lsKey()) || ''; strokes = JSON.parse(localStorage.getItem(lsDraw()) || '[]'); } catch { strokes = []; }
  redraw(); render();
  onSnapshot(col, snap => {
    let other = false;
    snap.docChanges().forEach(ch => {
      if (ch.type === 'removed') { N.delete(ch.doc.id); return; }
      const d = ch.doc.data(); N.set(ch.doc.id, d);
      if (ch.type === 'added' && d.uid !== uid && !firstSnap) other = true;
    });
    render(); firstSnap = false;
    if (other) {
      if (!open) $('ntDot').classList.remove('hidden');
      if (!open || tab !== 'all') $('ntTabDot').classList.remove('hidden');
    }
  }, e => console.error(e));
}
new MutationObserver(() => { if (!$('meeting').classList.contains('hidden')) start(); }).observe($('meeting'), { attributes: true, attributeFilter: ['class'] });

/* Shortcut: press N to open/close notes (ignored while typing) */
addEventListener('keydown', e => {
  if (!room || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'n') btn.click();
});
