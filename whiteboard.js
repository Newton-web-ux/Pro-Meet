// whiteboard.js - shared multi-page whiteboard for Pro Meet: live sync through Firestore, export PNG to your Google Drive.
import { getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { SCRIPT_URL } from "./meet-config.js";

const $ = id => document.getElementById(id), W = 1600, H = 900, MAXP = 30;
const S = new Map();                                   // stroke id -> stroke data (all pages)
const unseen = new Set();                              // pages where others drew while I was elsewhere
let db, auth, uid, room, col, metaRef, cv, g, tool = 'pen', color = '#111111', size = 5, cur = null, open = false, started = false, firstSnap = true, lastNote = 0;
let page = 0, metaPages = 1, metaFirst = true;
const pg = d => d.page | 0;                            // strokes without a page belong to page 1
const pageCount = () => { let n = Math.max(1, metaPages, page + 1); for (const s of S.values()) n = Math.max(n, pg(s) + 1); return Math.min(n, MAXP); };
const toast = t => { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; $('toasts').append(d); setTimeout(() => d.remove(), 3500); };
const myName = () => document.querySelector('#t-' + uid + ' .nm')?.textContent.replace(/ \(You\)$/, '') || 'Guest';
async function api(body) {
  const token = await auth.currentUser.getIdToken();
  const r = await fetch(SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, token }) });
  const j = await r.json(); if (!j.ok) throw new Error(j.error || 'request failed'); return j;
}

/* ---------- UI ---------- */
const css = document.createElement('style');
css.textContent = `#wb{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.wbbar{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;align-items:center;border-bottom:1px solid var(--line)}
.wbt{background:#222a36;padding:7px 10px;border-radius:8px;font-size:13px}.wbt:hover{background:#2c3544}.wbt.on{background:var(--acc);color:#fff}.wbt:disabled{opacity:.5}
.wbbar input[type=color]{width:34px;height:32px;padding:0;border-radius:8px;cursor:pointer}.wbbar input[type=range]{width:90px;padding:0}
.wbg{display:flex;gap:4px;align-items:center}.wbg select{background:#0b0e13;color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:7px 6px;font:inherit;font-size:13px}
.wbsp{flex:1}.wbarea{flex:1;display:flex;align-items:center;justify-content:center;padding:10px;min-height:0;overflow:auto}
#wbc{width:min(100%,calc((100vh - 230px)*1.7778));aspect-ratio:16/9;background:#fff;border-radius:10px;touch-action:none;cursor:crosshair}`;
document.head.append(css);

const btn = document.createElement('button'); btn.className = 'cb'; btn.id = 'wbBtn';
btn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M7 13l3-4 3 3 4-5M9 21h6M12 17v4"/></svg><span>Whiteboard</span><i class="dot hidden" id="wbDot">•</i>';
$('shareBtn').after(btn);
const wb = document.createElement('div'); wb.id = 'wb'; wb.className = 'hidden';
wb.innerHTML = `<div class="wbbar">
<button class="wbt on" data-t="pen">✏️ Pen</button><button class="wbt" data-t="eraser">🧽 Eraser</button><button class="wbt" data-t="line">╱ Line</button>
<button class="wbt" data-t="rect">▭ Box</button><button class="wbt" data-t="ellipse">◯ Circle</button><button class="wbt" data-t="text">T Text</button>
<input type="color" id="wbCol" value="#111111" title="Colour"><input type="range" id="wbSize" min="2" max="40" value="5" title="Size">
<button class="wbt" id="wbUndo">↩ Undo</button><button class="wbt" id="wbClear">🗑 Clear page</button>
<span class="wbg"><button class="wbt" id="wbPrev" title="Previous page">◀</button><select id="wbPg"></select><button class="wbt" id="wbNext" title="Next page">▶</button><button class="wbt" id="wbAdd">＋ Page</button></span>
<span class="wbsp"></span>
<button class="wbt" id="wbDrive">☁ Save page</button><button class="wbt" id="wbDriveAll">☁ Save all</button><button class="wbt" id="wbPng">⬇ PNG</button><button class="wbt" id="wbClose">✕ Close</button></div>
<div class="wbarea"><canvas id="wbc" width="${W}" height="${H}"></canvas></div>`;
$('grid').after(wb);
cv = $('wbc'); g = cv.getContext('2d');

function pgUI() {
  const n = pageCount(), sel = $('wbPg'); sel.innerHTML = '';
  for (let i = 0; i < n; i++) { const o = document.createElement('option'); o.value = i; o.textContent = 'Page ' + (i + 1) + ' of ' + n + (unseen.has(i) ? ' ●' : ''); sel.append(o); }
  sel.value = page; $('wbPrev').disabled = page <= 0; $('wbNext').disabled = page >= n - 1;
}
function goPage(i) {
  end(); page = Math.min(Math.max(0, i), pageCount() - 1); unseen.delete(page); pgUI(); redraw();
}
$('wbPrev').onclick = () => goPage(page - 1);
$('wbNext').onclick = () => goPage(page + 1);
$('wbPg').onchange = e => goPage(+e.target.value);
$('wbAdd').onclick = () => {
  if (!col) return toast('Join a meeting first');
  const n = pageCount(); if (n >= MAXP) return toast('Page limit reached (' + MAXP + ')');
  metaPages = n + 1;
  setDoc(metaRef, { pages: n + 1 }, { merge: true }).catch(() => toast('Could not add page (check Firestore rules)'));
  goPage(n);
};

function setOpen(v) {
  open = v; wb.classList.toggle('hidden', !v); $('grid').classList.toggle('hidden', v); btn.classList.toggle('act', v);
  if (v) { $('wbDot').classList.add('hidden'); unseen.delete(page); pgUI(); redraw(); }
}
btn.onclick = () => { if (!room) return toast('Join a meeting first'); setOpen(!open); };
$('wbClose').onclick = () => setOpen(false);
wb.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tool = b.dataset.t; wb.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('on', x === b)); });
$('wbCol').oninput = e => { color = e.target.value; };
$('wbSize').oninput = e => { size = +e.target.value; };

/* ---------- Drawing ---------- */
function stroke(c, s) {
  const p = s.pts; if (!p || p.length < 2) return;
  c.save(); c.lineCap = c.lineJoin = 'round'; c.lineWidth = s.tool === 'eraser' ? s.size * 3 : s.size; c.strokeStyle = c.fillStyle = s.color;
  c.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
  if (s.tool === 'pen' || s.tool === 'eraser') {
    c.beginPath(); c.moveTo(p[0] * W, p[1] * H); if (p.length === 2) c.lineTo(p[0] * W + .01, p[1] * H);
    for (let i = 2; i < p.length; i += 2) c.lineTo(p[i] * W, p[i + 1] * H); c.stroke();
  } else if (s.tool === 'text') { c.font = (s.size * 4 + 8) + 'px sans-serif'; c.textBaseline = 'top'; c.fillText(s.text || '', p[0] * W, p[1] * H); }
  else if (p.length >= 4) {
    const x0 = p[0] * W, y0 = p[1] * H, x1 = p[2] * W, y1 = p[3] * H; c.beginPath();
    if (s.tool === 'line') { c.moveTo(x0, y0); c.lineTo(x1, y1); }
    else if (s.tool === 'rect') c.rect(x0, y0, x1 - x0, y1 - y0);
    else c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, 7);
    c.stroke();
  }
  c.restore();
}
const onPage = p => [...S.values()].filter(s => pg(s) === p).sort((a, b) => a.ts - b.ts);
function redraw() { if (!open) return; g.clearRect(0, 0, W, H); onPage(page).forEach(s => stroke(g, s)); }
const pt = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height].map(v => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4); };
function add(s) {
  const ref = doc(col), d = { uid, name: myName(), color, size, ts: Date.now(), page, ...s };
  S.set(ref.id, d); setDoc(ref, d).catch(() => toast('Could not save drawing (check Firestore rules)')); redraw(); return { id: ref.id, ref };
}
cv.addEventListener('pointerdown', e => {
  if (!col) return; e.preventDefault(); cv.setPointerCapture(e.pointerId); const p = pt(e);
  if (tool === 'text') { const t = prompt('Text to add'); if (t && t.trim()) add({ tool, pts: p, text: t.trim().slice(0, 200) }); return; }
  cur = add({ tool, pts: tool === 'pen' || tool === 'eraser' ? p : [...p, ...p] });
});
cv.addEventListener('pointermove', e => {
  if (!cur) return; const p = pt(e), s = S.get(cur.id);
  if (s.tool === 'pen' || s.tool === 'eraser') { if (s.pts.length < 1200) s.pts.push(...p); } else { s.pts[2] = p[0]; s.pts[3] = p[1]; }
  cur.dirty = true; redraw();
});
const flush = () => { if (!cur) return; updateDoc(cur.ref, { pts: S.get(cur.id).pts }).catch(() => {}); cur.dirty = false; };
const end = () => { if (cur) { flush(); cur = null; } };
cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
setInterval(() => { if (cur && cur.dirty) flush(); }, 250);             // live strokes for everyone else

$('wbUndo').onclick = () => { const m = [...S.entries()].filter(([, s]) => s.uid === uid && pg(s) === page).sort((a, b) => b[1].ts - a[1].ts)[0]; if (m) deleteDoc(doc(col, m[0])).catch(() => {}); };
$('wbClear').onclick = () => {
  const ids = [...S.entries()].filter(([, s]) => pg(s) === page).map(([id]) => id);
  if (ids.length && confirm('Clear page ' + (page + 1) + ' for everyone?')) ids.forEach(id => deleteDoc(doc(col, id)).catch(() => {}));
};

/* ---------- Export ---------- */
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const fileName = (p, t) => 'whiteboard-' + room + '-p' + (p + 1) + '-' + t + '.png';
function renderPage(p) {                                // any page, open or not
  const t = document.createElement('canvas'); t.width = W; t.height = H; const tc = t.getContext('2d');
  onPage(p).forEach(s => stroke(tc, s));
  const o = document.createElement('canvas'); o.width = W; o.height = H; const c = o.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, H); c.drawImage(t, 0, 0); return o.toDataURL('image/png');
}
$('wbPng').onclick = () => { const a = document.createElement('a'); a.href = renderPage(page); a.download = fileName(page, stamp()); a.click(); };
async function saveDrive(all) {
  if (!SCRIPT_URL || SCRIPT_URL.includes('PASTE')) return toast('Google Drive is not set up yet (see meet-config.js)');
  const pages = all ? [...Array(pageCount()).keys()].filter(p => onPage(p).length) : [page];
  if (!pages.length || (!all && !onPage(page).length)) return toast(all ? 'The whiteboard is empty' : 'This page is empty');
  const bs = [$('wbDrive'), $('wbDriveAll')], labels = bs.map(b => b.textContent), t = stamp();
  bs.forEach(b => { b.disabled = true; }); bs[all ? 1 : 0].textContent = 'Saving…';
  try {
    for (const p of pages) {
      const j = await api({ action: 'upload', room, name: fileName(p, t), type: 'image/png', data: renderPage(p).split(',')[1] });
      const info = { id: j.id, name: j.name, size: j.size, type: j.type };
      await addDoc(collection(db, 'rooms', room, 'messages'), { uid, name: myName(), text: '[[drive:' + JSON.stringify(info) + ']]', ts: Date.now() });
    }
    toast(pages.length + ' page(s) saved to Google Drive and shared in the chat');
  } catch (e) { console.error(e); toast('Save failed (' + e.message + ')'); }
  bs.forEach((b, i) => { b.disabled = false; b.textContent = labels[i]; });
  pgUI();
}
$('wbDrive').onclick = () => saveDrive(false);
$('wbDriveAll').onclick = () => saveDrive(true);

/* ---------- Live sync (starts when you join a meeting) ---------- */
function start() {
  if (started) return; started = true;
  const app = getApps()[0]; auth = getAuth(app); db = getFirestore(app); uid = auth.currentUser?.uid;
  room = decodeURIComponent(location.hash.slice(1)); if (!uid || !room) { started = false; return; }
  col = collection(db, 'rooms', room, 'wb');
  metaRef = doc(db, 'rooms', room, 'wbmeta', 'state');

  onSnapshot(metaRef, s => {                            // page count shared by everyone
    const n = Math.min(MAXP, s.exists() ? (s.data().pages | 0) || 1 : 1);
    if (!metaFirst && n > metaPages) { if (n - 1 !== page || !open) unseen.add(n - 1); if (!open) $('wbDot').classList.remove('hidden'); }
    metaPages = n; metaFirst = false; pgUI();
  }, e => console.error(e));

  onSnapshot(col, snap => {
    let other = null; const otherPages = new Set();
    snap.docChanges().forEach(ch => {
      const id = ch.doc.id, d = ch.doc.data();
      if (ch.type === 'removed') { S.delete(id); return; }
      if (d.uid === uid && S.has(id)) return;                              // my own stroke is already drawn locally
      S.set(id, d); if (d.uid !== uid) { other = d; otherPages.add(pg(d)); }
    });
    if (!firstSnap) otherPages.forEach(p => { if (!open || p !== page) unseen.add(p); });
    redraw(); pgUI();
    if (other && !firstSnap && !open) { $('wbDot').classList.remove('hidden'); if (Date.now() - lastNote > 30000) { lastNote = Date.now(); toast((other.name || 'Someone') + ' is drawing on the whiteboard. Click Whiteboard to join.'); } }
    firstSnap = false;
  }, e => console.error(e));
}
new MutationObserver(() => { if (!$('meeting').classList.contains('hidden')) start(); }).observe($('meeting'), { attributes: true, attributeFilter: ['class'] });
pgUI();
