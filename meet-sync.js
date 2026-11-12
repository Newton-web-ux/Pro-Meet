// meet-sync.js - connects index.html to the dashboard. Add ONE line before </body> in index.html:
//   <script type="module" src="meet-sync.js"></script>
import "./attach.js";   // chat file attachments

const $ = id => document.getElementById(id);
const get = k => { try { return localStorage.getItem(k); } catch { return null; } };

/* 1. Prefill the name saved on the dashboard; remember it when you join */
if (get('pm_name') && !$('nameIn').value) $('nameIn').value = get('pm_name');
$('joinBtn').addEventListener('click', () => { const n = $('nameIn').value.trim(); if (n) try { localStorage.setItem('pm_name', n); } catch {} });

/* 2. Links back to the dashboard */
const st = document.createElement('style');
st.textContent = 'a.ghost{text-decoration:none;color:var(--acc);font-size:14px}';
document.head.append(st);
const back = document.createElement('a'); back.className = 'ghost'; back.href = 'index.html'; back.textContent = '← Back to dashboard';
document.querySelector('#lobby .form').append(back);
const dash = document.createElement('a'); dash.className = 'ghost'; dash.href = 'index.html'; dash.target = '_blank'; dash.textContent = 'Dashboard';
dash.style.marginRight = '14px'; $('copyBtn').before(dash);

/* 3. Tell the dashboard when you join a room (it syncs this to your account) */
let joined = false;
new MutationObserver(() => {
  const inMeeting = !$('meeting').classList.contains('hidden');
  if (inMeeting && !joined) {
    joined = true;
    const code = decodeURIComponent(location.hash.slice(1)); if (!code) return;
    try { const j = JSON.parse(get('pm_joins') || '[]'); j.push({ code, ts: Date.now() }); localStorage.setItem('pm_joins', JSON.stringify(j.slice(-50))); } catch {}
  } else if (!inMeeting) joined = false;
}).observe($('meeting'), { attributes: true, attributeFilter: ['class'] });
