// attach.js - file sharing for the Pro Meet chat (paperclip button, drag & drop, paste an image).
// Files (max 5 MB) are stored in Firestore as small chunks, so it works on the free Firebase plan.
import { getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, addDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const MAX = 5 * 1024 * 1024, CH = 600000, TAG = /^\[\[file:(\{.*\})\]\]$/s, IMG = /^image\/(png|jpe?g|gif|webp)$/;
const $ = id => document.getElementById(id), cache = {};
const fmt = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const ctx = () => { const app = getApps()[0]; return { db: getFirestore(app), uid: getAuth(app).currentUser?.uid, room: decodeURIComponent(location.hash.slice(1)) }; };
const toast = t => { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; $('toasts').append(d); setTimeout(() => d.remove(), 3500); };

const css = document.createElement('style');
css.textContent = `#attBtn{background:#222a36!important;color:#e8ecf2!important;padding:0 12px!important}
.pane.drag{outline:2px dashed var(--acc);outline-offset:-6px}
.fcard{display:flex;flex-direction:column;gap:6px;min-width:180px}.ftop{display:flex;gap:8px;align-items:center}
.fnm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px}.fsz{color:var(--mut);font-size:11px}
.fimg{max-width:100%;max-height:220px;border-radius:8px;object-fit:contain;background:#000}
.fdl{background:var(--acc);color:#fff;padding:6px 10px;border-radius:8px;font-size:12px}.fdl:disabled{opacity:.6}`;
document.head.append(css);

/* ---- UI: paperclip, drag & drop, paste ---- */
let q = Promise.resolve();
const queue = f => { q = q.then(() => send(f)).catch(() => {}); };
const fin = document.createElement('input'); fin.type = 'file'; fin.multiple = true; fin.hidden = true;
const btn = document.createElement('button'); btn.type = 'button'; btn.id = 'attBtn'; btn.title = 'Attach a file (max 5 MB)'; btn.textContent = '📎';
$('cf').prepend(btn); $('cf').after(fin);
btn.onclick = () => fin.click();
fin.onchange = () => { [...fin.files].forEach(queue); fin.value = ''; };
const pane = $('paneChat');
['dragenter', 'dragover'].forEach(e => pane.addEventListener(e, ev => { ev.preventDefault(); pane.classList.add('drag'); }));
['dragleave', 'drop'].forEach(e => pane.addEventListener(e, ev => { ev.preventDefault(); pane.classList.remove('drag'); }));
pane.addEventListener('drop', ev => [...ev.dataTransfer.files].forEach(queue));
$('chatIn').addEventListener('paste', ev => { const fs = [...(ev.clipboardData?.files || [])]; if (fs.length) { ev.preventDefault(); fs.forEach(queue); } });

/* ---- Upload ---- */
function status(text) { const d = document.createElement('div'); d.className = 'msg mine'; d.textContent = text; $('msgs').append(d); $('msgs').scrollTop = 1e9; return d; }
async function send(file) {
  const { db, uid, room } = ctx();
  if (!uid || !room) return toast('Join a meeting first');
  if (!file.size) return toast('That file is empty');
  if (file.size > MAX) return toast(file.name + ' is larger than 5 MB');
  const st = status('Uploading ' + file.name + ' …');
  try {
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
    const n = Math.ceil(b64.length / CH), id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const idx = [...Array(n).keys()]; let done = 0;
    const worker = async () => {
      while (idx.length) {
        const i = idx.shift();
        await setDoc(doc(db, 'rooms', room, 'files', id, 'chunks', String(i).padStart(4, '0')), { i, d: b64.slice(i * CH, (i + 1) * CH) });
        st.textContent = 'Uploading ' + file.name + ' … ' + Math.round(++done / n * 100) + '%';
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    cache[id] = file;
    const info = { id, name: file.name.slice(0, 120), size: file.size, type: file.type || '', chunks: n };
    const nm = document.querySelector('#t-' + uid + ' .nm')?.textContent.replace(/ \(You\)$/, '') || 'Guest';
    await addDoc(collection(db, 'rooms', room, 'messages'), { uid, name: nm, text: '[[file:' + JSON.stringify(info) + ']]', ts: Date.now() });
  } catch (e) { console.error(e); toast('Upload failed (' + (e.code || e.message) + ')'); }
  st.remove();
}

/* ---- Download / preview ---- */
async function getBlob(f) {
  if (cache[f.id]) return cache[f.id];
  const { db, room } = ctx();
  const snap = await getDocs(collection(db, 'rooms', room, 'files', f.id, 'chunks'));
  if (snap.size !== f.chunks) throw new Error('incomplete file');
  const parts = snap.docs.map(d => { const s = atob(d.data().d), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; });
  return cache[f.id] = new Blob(parts, { type: f.type || 'application/octet-stream' });
}
function card(f) {
  const c = document.createElement('div'), top = document.createElement('div'), ic = document.createElement('span'), nm = document.createElement('span'), sz = document.createElement('span'), b = document.createElement('button');
  c.className = 'fcard'; top.className = 'ftop'; nm.className = 'fnm'; sz.className = 'fsz'; b.className = 'fdl';
  ic.textContent = IMG.test(f.type) ? '🖼' : '📎'; nm.textContent = f.name; sz.textContent = fmt(f.size); b.textContent = 'Download';
  top.append(ic, nm, sz); c.append(top, b);
  b.onclick = async () => {
    b.disabled = true; b.textContent = 'Loading…';
    try { const a = document.createElement('a'); a.href = URL.createObjectURL(await getBlob(f)); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
    catch (e) { console.error(e); toast('Could not download ' + f.name); }
    b.disabled = false; b.textContent = 'Download';
  };
  if (IMG.test(f.type) && f.size <= 1048576)
    getBlob(f).then(bl => { const im = document.createElement('img'); im.className = 'fimg'; im.alt = f.name; im.src = URL.createObjectURL(bl); im.onload = () => { $('msgs').scrollTop = 1e9; }; c.insertBefore(im, b); }).catch(() => {});
  return c;
}

/* ---- Turn file messages into cards ---- */
function enhance(el) {
  if (!el.classList?.contains('msg')) return;
  const sp = el.querySelector('span'), m = sp && TAG.exec(sp.textContent); if (!m) return;
  try {
    const f = JSON.parse(m[1]);
    if (!/^[a-z0-9]+$/.test(f.id) || typeof f.name !== 'string' || !(f.size >= 0 && f.size <= MAX) || !Number.isInteger(f.chunks) || f.chunks < 0 || f.chunks > 20) return;
    f.type = String(f.type || ''); sp.replaceWith(card(f));
  } catch {}
}
const msgs = $('msgs');
[...msgs.children].forEach(enhance);
new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(enhance))).observe(msgs, { childList: true });
