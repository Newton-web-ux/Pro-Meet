// history.js - records attendance for each meeting so the dashboard can list past meetings.
import { getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let started = false, ref = null;
const ping = () => { if (ref) updateDoc(ref, { leftAt: Date.now() }).catch(() => {}); };

function start() {
  if (started) return; started = true;
  const app = getApps()[0], auth = getAuth(app), db = getFirestore(app), uid = auth.currentUser?.uid;
  const room = decodeURIComponent(location.hash.slice(1));
  if (!uid || !room) { started = false; return; }
  const name = (document.querySelector('#t-' + uid + ' .nm')?.textContent.replace(/ \(You\)$/, '') || 'Guest').slice(0, 30);
  const now = Date.now();
  ref = doc(collection(db, 'rooms', room, 'sessions'));
  setDoc(ref, { uid, name, joinedAt: now, leftAt: now }).catch(e => console.warn('Could not record attendance (check Firestore rules)', e));
  setInterval(ping, 20000);
  addEventListener('pagehide', ping);
  document.getElementById('leaveBtn')?.addEventListener('click', ping);
}
new MutationObserver(() => { if (!document.getElementById('meeting').classList.contains('hidden')) start(); })
  .observe(document.getElementById('meeting'), { attributes: true, attributeFilter: ['class'] });
