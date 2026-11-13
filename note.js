// note.js - meeting notes for Pro Meet: private notes (autosaved locally) + shared live notes (Firestore).
import { getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, deleteDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { SCRIPT_URL } from "./meet-config.js";

const $ = id => document.getElementById(id);
const KINDS = { note: '📝', action: '✅', decision: '⭐' };
const N = new Map();                                    // shared note id -> data
let db, auth, uid, room, col, open = false, started = false, firstSnap = true, tab = 'me';

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
css.textContent = `#nt{width:340px;background:var(--panel);border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.nth{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line);font-size:14px}
.ntt{display:flex;border-bottom:1px solid var(--line)}.ntt button{flex:1;padding:10px;color:var(--mut);font-size:13px}
.ntt button.on{color:var(--txt);border-bottom:2px solid var(--acc)}
.ntp{flex:1;display:flex;flex-direction:column;min-height:0;padding:10px;gap:8px}
#ntMine{flex:1;resize:none;background:#0b0e13;color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:12px;font:inherit;font-size:14px;line-height:1.5;outline:none;min-height:0}
#ntMine:focus{border-color:var(--acc)}
.ntb{background:#222a36;padding:7px 10px;border-radius:8px;font-size:13px}.ntb:hover{background:#2c3544}.ntb:disabled{opacity:.6}
.ntb.pri{background:var(--acc);color:#fff}
#ntList{flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px;min-height:0}
.ntn{background:#222a36;border-radius:10px;padding:8px 10px;font-size:14px;word-break:break-word}.ntn.mine{background:#1e3a68}
.ntn small{display:flex;justify-content:space-between;gap:8px;color:var(--mut);font-size:11px;margin-bottom:2px}
.ntn small button{color:var(--mut);font-size:12px}.ntn small button:hover{color:var(--red)}
.nte{color:var(--mut);font-size:13px;text-align:center;padding:20px 10px}
.ntf{display:flex;gap:6px}.ntf select{background:#0b0e13;color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:0 6px;font:inherit;font-size:13px}
.ntf input{padding:9px 11px}
.nta{display:flex;gap:6px;padding:10px;border-top:1px solid var(--line)}.nta .ntb{flex:1}
.ntd{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--red);margin-left:6px}
@media(max-width:760px){#nt{position:fixed;inset:0;width:100%;z-index:6}}`;
document.head.append(css);

const btn = document.createElement('button'); btn.className = 'cb'; btn.id = 'ntBtn';
btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg><span>Notes</span><i class="dot hidden" id="ntDot">•</i>';
$('handBtn').after(btn);

const panel = document.createElement('aside'); panel.id = 'nt'; panel.className = 'hidden';
panel.innerHTML = `<div class="nth"><b>Meeting notes</b><button class="ntb" id="ntX">✕</button></div>
<div class="ntt"><button id="ntTabMe" class="on">My notes (private)</button><button id="ntTabAll">Shared<span class="ntd hidden" id="ntTabDot"></span></button></div>
<div class="ntp" id="ntPaneMe"><textarea id="ntMine" placeholder="Only you can see these notes. They are saved in this browser."></textarea>
<div><button class="ntb" id="ntStamp">⏱ Add timestamp</button></div></div>
<div class="ntp hidden" id="ntPaneAll"><div id="ntList"></div>
<form class="ntf" id="ntForm"><select id="ntKind"><option value="note">📝 Note</option><option value="action">✅ Action</option><option value="decision">⭐ Decision</option></select>
<input id="ntIn" placeholder="Add a shared note…" maxlength="500" autocomplete="off"><button class="ntb pri">Add</button></form></div>
<div class="nta"><button class="ntb" id="ntDl">⬇ Download</button><button class="ntb" id="ntDrive">☁ Save to Drive</button></div>`;
$('side').before(panel);

function setTab(t) {
  tab = t;
  $('ntPaneMe').classList.toggle('hidden', t !== 'me'); $('ntPaneAll').classList.toggle('hidden', t !== 'all');
  $('ntTabMe').classList.toggle('on', t === 'me'); $('ntTabAll').classList.toggle('on', t === 'all');
  if (t === 'all') { $('ntTabDot').classList.add('hidden'); $('ntList').scrollTop = 1e9; }
}
function setOpen(v) {
  open = v; panel.classList.toggle('hidden', !v); btn.classList.toggle('act', v);
  if (v) { $('ntDot').classList.add('hidden'); if (tab === 'all') setTab('all'); }
}
btn.onclick = () => { if (!room) return toast('Join a meeting first'); setOpen(!open); };
$('ntX').onclick = () => setOpen(false);
$('ntTabMe').onclick = () => setTab('me'); $('ntTabAll').onclick = () => setTab('all');

/* ---------- Private notes (localStorage, per room) ---------- */
const lsKey = () => 'promeet-notes-' + room;
$('ntMine').oninput = e => { try { localStorage.setItem(lsKey(), e.target.value); } catch {} };
$('ntStamp').onclick = () => {
  const t = $('ntMine'), s = '[' + $('timer').textContent + '] ', a = t.selectionStart, b = t.selectionEnd;
  t.setRangeText(s, a, b, 'end'); t.focus(); t.dispatchEvent(new Event('input'));
};

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

/* ---------- Export ---------- */
function exportText() {
  const out = ['Meeting notes · room ' + room, new Date().toLocaleString(), ''];
  const mine = $('ntMine').value.trim();
  out.push('=== My notes ===', mine || '(empty)', '', '=== Shared notes ===');
  const items = [...N.values()].sort((a, b) => a.ts - b.ts);
  if (!items.length) out.push('(none)');
  items.forEach(n => out.push('[' + hhmm(n.ts) + '] ' + (n.name || 'Guest') + ' (' + (n.kind || 'note') + '): ' + n.text));
  return out.join('\n');
}
const fileName = () => 'notes-' + room + '-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.txt';
$('ntDl').onclick = () => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([exportText()], { type: 'text/plain' }));
  a.download = fileName(); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$('ntDrive').onclick = async () => {
  if (!SCRIPT_URL || SCRIPT_URL.includes('PASTE')) return toast('Google Drive is not set up yet (see meet-config.js)');
  const b = $('ntDrive'); b.disabled = true; b.textContent = 'Saving…';
  try {
    const bytes = new TextEncoder().encode(exportText()); let bin = ''; bytes.forEach(c => bin += String.fromCharCode(c));
    const j = await api({ action: 'upload', room, name: fileName(), type: 'text/plain', data: btoa(bin) });
    const info = { id: j.id, name: j.name, size: j.size, type: j.type };
    await addDoc(collection(db, 'rooms', room, 'messages'), { uid, name: myName(), text: '[[drive:' + JSON.stringify(info) + ']]', ts: Date.now() });
    toast('Notes saved to Google Drive and shared in the chat');
  } catch (e) { console.error(e); toast('Save failed (' + e.message + ')'); }
  b.disabled = false; b.textContent = '☁ Save to Drive';
};

/* ---------- Start when you join a meeting ---------- */
function start() {
  if (started) return; started = true;
  const app = getApps()[0]; auth = getAuth(app); db = getFirestore(app); uid = auth.currentUser?.uid;
  room = decodeURIComponent(location.hash.slice(1)); if (!uid || !room) { started = false; return; }
  col = collection(db, 'rooms', room, 'notes');
  try { $('ntMine').value = localStorage.getItem(lsKey()) || ''; } catch {}
  render();
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
