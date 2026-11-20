/* Pro Meet: meeting recording.
 * Records everything you see (video tiles, shared screen, pinned view) plus the mixed audio of everyone in the call
 * into one file. While recording, the video is uploaded in parts to your Google Drive (via the Apps Script) so it shows
 * up in the dashboard under Recordings. A copy is also saved to this device when you stop. Everyone in the room is notified.
 * Loaded from meeting.html with <script type="module" src="recording.js"></script> */
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, updateDoc, addDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { SCRIPT_URL } from './meet-config.js';
import { deviceId } from './analytics.js';

const $ = id => document.getElementById(id);
const auth = getAuth(getApp()), db = getFirestore(getApp());
const W = 1280, H = 720, MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
const PART = 4 * 1024 * 1024;   // upload a part every ~4 MB (server accepts up to 10 MB per part and 600 parts; base64 adds ~33%)
let rec = null, watching = false, uploading = 0;

/* ---------- UI: Record button in the control bar + "someone is recording" banner ---------- */
const st = document.createElement('style');
st.textContent = '#recBanner{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#7f1d1d;color:#fff;padding:7px 16px;border-radius:99px;font-size:13px;z-index:11;display:none;box-shadow:0 6px 20px rgba(0,0,0,.4)}' +
  '#recBanner.on{display:block}#recBanner::before{content:"";display:inline-block;width:9px;height:9px;border-radius:50%;background:#ef4444;margin-right:8px;animation:rb 1s infinite}@keyframes rb{50%{opacity:.25}}';
document.head.append(st);
const btn = document.createElement('button');
btn.className = 'cb'; btn.id = 'recBtn'; btn.title = 'Record this meeting (saved to the dashboard and your device)';
btn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg><span>Record</span>';
$('bar').insertBefore(btn, $('leaveBtn'));
const banner = document.createElement('div'); banner.id = 'recBanner'; document.body.append(banner);

const room = () => decodeURIComponent(location.hash.slice(1));
const myTile = () => document.querySelector('#grid .tile:not(.remote)');
const myName = () => (myTile()?.querySelector('.nm')?.textContent || 'Someone').replace(/ \(You\)$/, '');
const note = t => { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; $('toasts').append(d); setTimeout(() => d.remove(), 3500); };
const post = text => addDoc(collection(db, 'rooms', room(), 'messages'), { uid: auth.currentUser.uid, name: myName(), text, ts: Date.now() }).catch(() => {});
const flag = on => updateDoc(doc(db, 'rooms', room(), 'participants', auth.currentUser.uid), { recording: on }).catch(() => {});

/* Everyone sees who is recording (updates whenever a participant record changes, including heartbeats). */
setInterval(() => {
  if (watching || !auth.currentUser || $('meeting').classList.contains('hidden') || !room()) return;
  watching = true;
  onSnapshot(collection(db, 'rooms', room(), 'participants'), snap => {
    const names = snap.docs.filter(d => d.id !== auth.currentUser.uid && d.data().recording && Date.now() - d.data().seen < 45000).map(d => d.data().name);
    banner.textContent = names.length ? names.join(', ') + (names.length > 1 ? ' are' : ' is') + ' recording this meeting' : '';
    banner.classList.toggle('on', names.length > 0);
  }, () => {});
}, 1000);

/* ---------- Uploading to Google Drive (Apps Script recUpload), in parts ---------- */
const toB64 = blob => new Promise((res, rej) => {
  const f = new FileReader();
  f.onload = () => res(String(f.result).split(',')[1] || '');
  f.onerror = () => rej(f.error); f.readAsDataURL(blob);
});

async function upPart(r, n, blob, last) {
  const data = await toB64(blob);
  for (let i = 0; i < 4; i++) {
    try {
      const token = await auth.currentUser.getIdToken();          // fresh token each time (they expire after 1 hour)
      const resp = await fetch(SCRIPT_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'recUpload', token, device: deviceId(), room: r.room, recId: r.id, part: n, data,
          mime: r.mime.split(';')[0], by: r.by, start: r.t0, last, dur: Math.round((Date.now() - r.t0) / 1000)
        })
      });
      const j = await resp.json();
      if (j.ok) return true;
      throw new Error(j.error || 'failed');
    } catch (e) { console.warn('recUpload retry', n, e); await new Promise(s => setTimeout(s, 1500 * (i + 1))); }
  }
  return false;
}

function flushPart(r, last) {
  const blob = new Blob(r.buf, { type: r.mime.split(';')[0] }); r.buf = []; r.bufSize = 0;
  const n = ++r.part;
  uploading++;
  r.q = r.q.then(() => upPart(r, n, blob, last)).then(ok => { if (!ok) r.failed = true; }).finally(() => { uploading--; });   // serial queue keeps the parts in order
  return r.q;
}

/* ---------- Drawing the meeting onto a canvas ---------- */
function drawTile(g, t, x, y, w, h) {
  const v = t.querySelector('video'), vw = v.videoWidth, name = t.querySelector('.nm')?.textContent || '';
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  if (vw && v.readyState >= 2 && !t.classList.contains('novid')) {
    const k = (t.classList.contains('share') ? Math.min : Math.max)(w / vw, h / v.videoHeight), dw = vw * k, dh = v.videoHeight * k;
    g.fillStyle = '#000'; g.fillRect(x, y, w, h); g.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  } else {
    g.fillStyle = '#1d2430'; g.fillRect(x, y, w, h);
    const r = Math.min(w, h) * 0.2; g.fillStyle = '#3b82f6'; g.beginPath(); g.arc(x + w / 2, y + h / 2, r, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.font = '600 ' + r * 0.8 + 'px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(t.querySelector('.av span')?.textContent || '?', x + w / 2, y + h / 2 + 2);
  }
  const label = (t.classList.contains('muted') ? '🔇 ' : '') + (t.classList.contains('hand') ? '✋ ' : '') + name;
  g.font = '15px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
  const lw = Math.min(w - 12, g.measureText(label).width + 16);
  g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(x + 8, y + h - 32, lw, 24); g.fillStyle = '#fff'; g.fillText(label, x + 16, y + h - 20, lw - 12);
  g.restore();
}
function drawFrame(g) {
  g.fillStyle = '#0b0e13'; g.fillRect(0, 0, W, H);
  const tiles = [...document.querySelectorAll('#grid .tile')]; if (!tiles.length) return;
  const big = tiles.find(t => t.classList.contains('share')) || tiles.find(t => t.classList.contains('pinned'));
  if (big) {
    const rest = tiles.filter(t => t !== big), sh = rest.length ? 130 : 0;
    drawTile(g, big, 0, 0, W, H - sh);
    const tw = Math.min(200, (W - 10) / Math.max(rest.length, 1) - 10);
    rest.forEach((t, i) => drawTile(g, t, 10 + i * (tw + 10), H - sh + 6, tw, sh - 12));
    return;
  }
  const n = tiles.length, c = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4, r = Math.ceil(n / c), gap = 8;
  const w = (W - gap * (c + 1)) / c, h = (H - gap * (r + 1)) / r;
  tiles.forEach((t, i) => drawTile(g, t, gap + (i % c) * (w + gap), gap + Math.floor(i / c) * (h + gap), w, h));
}

/* ---------- Start / stop ---------- */
async function start() {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return note('Recording is not supported in this browser. Use Chrome, Edge or Firefox.');
  const mime = MIMES.find(t => MediaRecorder.isTypeSupported(t)); if (!mime) return note('No supported recording format found');
  if (!confirm('Start recording? Everyone in the meeting will be notified. The recording is uploaded to the dashboard (Recordings) and also saved to your device when you stop.')) return;

  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), ac = new (window.AudioContext || window.webkitAudioContext)(), dest = ac.createMediaStreamDestination();
  await ac.resume().catch(() => {});
  const r = rec = {
    mime, chunks: [], ac, srcs: new Set(), mic: null, gain: null, t0: Date.now(), n: 0,
    room: room(), by: myName(), id: (Math.random().toString(36).slice(2) + 'abcdefgh').slice(0, 10),   // lowercase letters/digits, 10 chars (server needs 6-20)
    part: 0, buf: [], bufSize: 0, q: Promise.resolve(), failed: false
  };

  /* Mix the audio of every tile. If your own tile has no audio (while you share your screen), your microphone is added and follows the Mute button. */
  const mix = () => {
    document.querySelectorAll('#grid .tile video').forEach(v => {
      const s = v.srcObject, k = s && s.getAudioTracks().map(t => t.id).join(); if (!k || r.srcs.has(k)) return;
      try { ac.createMediaStreamSource(s).connect(dest); r.srcs.add(k); } catch {}
    });
    const own = myTile()?.querySelector('video')?.srcObject?.getAudioTracks().length > 0;
    if (!own && !r.mic) {
      r.mic = 'loading';
      navigator.mediaDevices.getUserMedia({ audio: true }).then(ms => { r.mic = ms; r.gain = ac.createGain(); ac.createMediaStreamSource(ms).connect(r.gain); r.gain.connect(dest); }).catch(() => {});
    }
    if (r.gain) r.gain.gain.value = (own || $('micBtn').classList.contains('off')) ? 0 : 1;
  };
  mix();

  /* A Worker timer keeps drawing even when this tab is in the background (normal timers get throttled). */
  r.worker = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),50)'], { type: 'application/javascript' })));
  r.worker.onmessage = () => { drawFrame(g); if (++r.n % 20 === 0) mix(); };
  drawFrame(g);

  r.vs = cv.captureStream(20);
  r.mr = new MediaRecorder(new MediaStream([...r.vs.getVideoTracks(), ...dest.stream.getAudioTracks()]), { mimeType: mime, videoBitsPerSecond: 2500000 });
  r.mr.ondataavailable = e => {
    if (!e.data.size) return;
    r.chunks.push(e.data); r.buf.push(e.data); r.bufSize += e.data.size;     // chunks = full local copy, buf = the part waiting to be uploaded
    if (r.bufSize >= PART) flushPart(r, false);
  };
  r.mr.start(1000);

  r.timer = setInterval(() => {
    const s = Math.floor((Date.now() - r.t0) / 1000);
    btn.querySelector('span').textContent = 'Stop ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
  btn.classList.add('off'); btn.querySelector('span').textContent = 'Stop 00:00';
  flag(true); post('🔴 ' + myName() + ' started recording this meeting.'); note('Recording started');
}

function stop() {
  const r = rec; if (!r) return Promise.resolve();
  rec = null;
  return new Promise(done => {
    r.mr.onstop = async () => {
      /* 1) local copy */
      const ext = r.mime.includes('mp4') ? 'mp4' : 'webm', a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(r.chunks, { type: r.mime.split(';')[0] }));
      a.download = 'promeet-' + r.room + '-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '.' + ext;
      document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      /* 2) upload the final part (marks the recording as complete) and wait for every earlier part */
      note('Uploading recording to the dashboard…');
      try { await flushPart(r, true); } catch (e) { r.failed = true; console.warn(e); }
      note(r.failed ? 'Some parts failed to upload. The file is still saved on your device.' : 'Recording uploaded. Find it in the dashboard under Recordings');
      done();
    };
    clearInterval(r.timer); r.worker.terminate();
    r.mr.state !== 'inactive' ? r.mr.stop() : r.mr.onstop();
    r.vs.getTracks().forEach(t => t.stop()); if (r.mic && r.mic.getTracks) r.mic.getTracks().forEach(t => t.stop()); r.ac.close().catch(() => {});
    btn.classList.remove('off'); btn.querySelector('span').textContent = 'Record';
    flag(false); post('⏹ Recording stopped.'); note('Recording stopped');
  });
}

btn.onclick = () => rec ? stop() : start();

/* Save the recording before leaving the meeting (Leave button, or the plan's time limit ending the call). */
$('leaveBtn').addEventListener('click', e => { if (!rec) return; e.stopImmediatePropagation(); e.preventDefault(); stop().then(() => $('leaveBtn').click()); }, true);
new MutationObserver(() => { if (rec && /time limit reached/i.test($('toasts').textContent)) stop(); }).observe($('toasts'), { childList: true });
/* Warn if the tab is closed while recording or while parts are still uploading */
addEventListener('beforeunload', e => { if (rec || uploading > 0) { e.preventDefault(); e.returnValue = ''; } });
