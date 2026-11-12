// attach.js - chat file sharing. Files are saved in YOUR Google Drive through the Apps Script web app (Code.gs).
import { getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, addDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { SCRIPT_URL } from "./meet-config.js";

const MAX = 10 * 1024 * 1024, TAG = /^\[\[drive:(\{.*\})\]\]$/s, IMG = /^image\/(png|jpe?g|gif|webp)$/;
const $ = id => document.getElementById(id), cache = {};
const fmt = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const toast = t => { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; $('toasts').append(d); setTimeout(() => d.remove(), 3500); };
const ctx = () => { const app = getApps()[0], auth = getAuth(app); return { db: getFirestore(app), auth, uid: auth.currentUser?.uid, room: decodeURIComponent(location.hash.slice(1)) }; };
async function api(body) {
  const token = await ctx().auth.currentUser.getIdToken();
  const r = await fetch(SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, token }) });
  const j = await r.json(); if (!j.ok) throw new Error(j.error || 'request failed'); return j;
}

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
const btn = document.createElement('button'); btn.type = 'button'; btn.id = 'attBtn'; btn.title = 'Attach a file (max 10 MB, saved to Google Drive)'; btn.textContent = '📎';
$('cf').prepend(btn); $('cf').after(fin);
btn.onclick = () => fin.click();
fin.onchange = () => { [...fin.files].forEach(queue); fin.value = ''; };
const pane = $('paneChat');
['dragenter', 'dragover'].forEach(e => pane.addEventListener(e, ev => { ev.preventDefault(); pane.classList.add('drag'); }));
['dragleave', 'drop'].forEach(e => pane.addEventListener(e, ev => { ev.preventDefault(); pane.classList.remove('drag'); }));
pane.addEventListener('drop', ev => [...ev.dataTransfer.files].forEach(queue));
$('chatIn').addEventListener('paste', ev => { const fs = [...(ev.clipboardData?.files || [])]; if (fs.length) { ev.preventDefault(); fs.forEach(queue); } });

/* ---- Upload to Drive ---- */
async function send(file) {
  const { db, uid, room } = ctx();
  if (!uid || !room) return toast('Join a meeting first');
  if (!SCRIPT_URL || SCRIPT_URL.includes('PASTE')) return toast('File sharing is not set up yet (see meet-config.js)');
  if (!file.size) return toast('That file is empty');
  if (file.size > MAX) return toast(file.name + ' is larger than 10 MB');
  const st = document.createElement('div'); st.className = 'msg mine'; st.textContent = 'Uploading ' + file.name + ' to Drive…'; $('msgs').append(st); $('msgs').scrollTop = 1e9;
  try {
    const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
    const j = await api({ action: 'upload', room, name: file.name, type: file.type, data });
    cache[j.id] = file;
    const nm = document.querySelector('#t-' + uid + ' .nm')?.textContent.replace(/ \(You\)$/, '') || 'Guest';
    const info = { id: j.id, name: j.name.slice(0, 120), size: j.size, type: j.type || '' };
    await addDoc(collection(db, 'rooms', room, 'messages'), { uid, name: nm, text: '[[drive:' + JSON.stringify(info) + ']]', ts: Date.now() });
  } catch (e) { console.error(e); toast('Upload failed (' + e.message + ')'); }
  st.remove();
}

/* ---- Download / preview ---- */
async function getBlob(f) {
  if (cache[f.id]) return cache[f.id];
  const j = await api({ action: 'get', id: f.id, room: ctx().room });
  return cache[f.id] = new Blob([Uint8Array.from(atob(j.data), c => c.charCodeAt(0))], { type: j.type || 'application/octet-stream' });
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
    if (!/^[\w-]{10,80}$/.test(f.id) || typeof f.name !== 'string' || !(f.size >= 0 && f.size <= MAX)) return;
    f.type = String(f.type || ''); sp.replaceWith(card(f));
  } catch {}
}
const msgs = $('msgs');
[...msgs.children].forEach(enhance);
new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(enhance))).observe(msgs, { childList: true });
