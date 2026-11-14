// settings.js - all meeting settings for Pro Meet: audio (volumes, devices, noise), video, backgrounds, host controls, general.
// Load it LAST (after history.js). It hooks the page's WebRTC / WebAudio objects, so it must load before you join a meeting.
import { getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, setDoc, deleteDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = id => document.getElementById(id);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const KEY = 'promeet-settings-v1';
const D = { master: 100, mic: 100, spk: '', micDev: '', cam: '', q: '720', bg: 'none', custom: '', mirror: true, fit: false, snd: true, joinMic: false, joinCam: false };
let S = { ...D };
try { S = { ...D, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };

let db, me, room, started = false, open = false, tab = 'audio', P = {}, R = {}, hostGain = 1, mctx = null;
const V = {}, HG = {};                                           // my volume per participant / host's voice level per participant
const G = { pcs: new Set(), src: null, hp: null, gain: null };    // captured peer connections + mic processing chain
const fx = { raw: null, out: null, vid: null, cvs: null, ctx: null, seg: null, bgImg: null, timer: 0, busy: false };
const PRE = { ocean: ['#38bdf8', '#1e3a8a'], sunset: ['#fb923c', '#7c3aed'], forest: ['#4ade80', '#064e3b'], slate: ['#64748b', '#0f172a'], sand: ['#fde68a', '#f59e0b'] };
const QS = { 720: [1280, 720, 30], 480: [640, 480, 30], 360: [640, 360, 15] };
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/';

const toast = t => { const d = el('div', 'toast', t); $('toasts').append(d); setTimeout(() => d.remove(), 3500); };
const lbl = id => $(id)?.querySelector('span')?.textContent || '';
const micOn = () => lbl('micBtn') === 'Mute', camOn = () => lbl('camBtn') === 'Stop video';
const stream = () => $('preview')?.srcObject;                      // the page's local stream (same object for the whole session)
const camTrack = () => fx.raw || stream()?.getVideoTracks()[0];
const ac = () => { mctx = mctx || new (window.AudioContext || window.webkitAudioContext)(); if (mctx.state === 'suspended') mctx.resume(); return mctx; };

/* ---------- Hooks (run at load, before the page creates its peers and audio chain) ---------- */
const RPC = window.RTCPeerConnection;
if (RPC) {
  window.RTCPeerConnection = function (...a) { const pc = new RPC(...a); G.pcs.add(pc); pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'closed') G.pcs.delete(pc); }); return pc; };
  window.RTCPeerConnection.prototype = RPC.prototype; Object.setPrototypeOf(window.RTCPeerConnection, RPC);
}
const oc = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (d, ...r) {
  try {
    if (this instanceof MediaStreamAudioSourceNode && d instanceof BiquadFilterNode) { G.src = this; G.hp = d; }          // microphone -> high-pass
    if (this instanceof DynamicsCompressorNode && d instanceof MediaStreamAudioDestinationNode && !G.gain) {            // insert my mic-volume node before the output
      const gn = this.context.createGain(); gn.gain.value = S.mic / 100 * hostGain; G.gain = gn; oc.call(this, gn); oc.call(gn, d); return d;
    }
  } catch {}
  return oc.call(this, d, ...r);
};
const setGain = () => { if (G.gain) G.gain.gain.value = S.mic / 100 * hostGain; };

/* ---------- UI ---------- */
const css = document.createElement('style');
css.textContent = `#toasts{z-index:60}
#st{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50;display:flex;align-items:center;justify-content:center;padding:14px}
.stbox{background:var(--panel);border:1px solid var(--line);border-radius:16px;width:min(640px,100%);max-height:90vh;display:flex;flex-direction:column;overflow:hidden}
.sth{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line);font-size:15px}
.stt{display:flex;overflow:auto;border-bottom:1px solid var(--line)}.stt button{flex:1;padding:11px 10px;color:var(--mut);font-size:13px;white-space:nowrap}.stt button.on{color:var(--txt);border-bottom:2px solid var(--acc)}
.stbody{padding:16px 18px 20px;overflow:auto;display:flex;flex-direction:column;gap:10px}.stbody section{display:flex;flex-direction:column;gap:10px}
.stbody label{font-size:12px;color:var(--mut);display:flex;justify-content:space-between;align-items:center}.stbody label b{color:var(--txt);font-weight:600}
.stbody h4{font-size:12px;color:var(--mut);margin-top:8px;font-weight:600}
.stbody label.chk{justify-content:flex-start;gap:8px;color:var(--txt);font-size:13px}
.stbody input[type=range]{padding:0;border:0;background:none;width:100%;accent-color:var(--acc)}
.stbody input[type=checkbox]{width:auto;padding:0;accent-color:var(--acc)}
.stbody select{background:#0b0e13;color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit;font-size:13px;width:100%;outline:none}
.stb{background:#222a36;padding:8px 12px;border-radius:8px;font-size:13px;white-space:nowrap}.stb:hover{background:#2c3544}.stb.on{background:var(--acc);color:#fff}.stb:disabled{opacity:.5}
.stro{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.stro select{flex:1;min-width:0}
.meter{height:8px;background:#0b0e13;border:1px solid var(--line);border-radius:6px;overflow:hidden}.meter i{display:block;height:100%;width:0;background:var(--grn);transition:width .08s}
.seg{display:flex;gap:6px}.seg button{flex:1}
.stm{color:var(--mut);font-size:12px;line-height:1.5}
.stpv{background:#000;border-radius:12px;overflow:hidden;aspect-ratio:16/9;max-height:230px;align-self:center;width:100%}.stpv video{width:100%;height:100%;object-fit:contain;transform:scaleX(-1);display:block}
.bgg{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px}.bgg button{height:58px;border-radius:10px;background:#222a36;font-size:12px;border:2px solid transparent;background-size:cover;color:#fff;text-shadow:0 1px 3px #000}
.bgg button.on{border-color:var(--acc)}
.stvr{display:grid;grid-template-columns:110px 1fr 44px;gap:10px;align-items:center;font-size:13px}.stvr span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stvr b{text-align:right;font-size:12px;color:var(--mut)}
.sthr{display:grid;grid-template-columns:1fr 1fr auto auto;gap:8px;align-items:center;font-size:13px;padding:8px 0;border-bottom:1px solid var(--line)}
#stLobby{margin-top:-4px}
@media(max-width:560px){.stvr{grid-template-columns:80px 1fr 40px}.sthr{grid-template-columns:1fr 1fr}}`;
document.head.append(css);
const dyn = document.createElement('style'); document.head.append(dyn);
const applyCss = () => { dyn.textContent = (S.mirror ? '' : '.tile.me video,#stPv{transform:none!important}') + (S.fit ? '.tile video{object-fit:contain!important}' : ''); };

const btn = el('button', 'cb'); btn.id = 'stBtn';
btn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg><span>Settings</span>';
$('leaveBtn')?.before(btn);
const lobbyBtn = el('button', 'ghost', '⚙ Audio, video & background settings'); lobbyBtn.id = 'stLobby'; $('newBtn')?.after(lobbyBtn);

const box = el('div'); box.id = 'st'; box.className = 'hidden';
box.innerHTML = `<div class="stbox">
<div class="sth"><b>⚙ Settings</b><button class="stb" id="stX">✕</button></div>
<div class="stt"><button data-p="audio" class="on">🎤 Audio</button><button data-p="video">📷 Video</button><button data-p="bg">🖼 Background</button><button data-p="host">👑 Host</button><button data-p="gen">⚙ General</button></div>
<div class="stbody">
<div class="stpv hidden" id="stPvBox"><video id="stPv" autoplay muted playsinline></video></div>
<section data-p="audio">
<label>Speaker volume <b id="vMaster"></b></label><input type="range" id="rMaster" min="0" max="100">
<label>Microphone volume <b id="vMic"></b></label><input type="range" id="rMic" min="0" max="200">
<div class="meter"><i id="meter"></i></div>
<label>Microphone</label><select id="sMic"></select>
<label>Speaker</label><div class="stro"><select id="sSpk"></select><button class="stb" id="bTest">🔊 Test</button></div>
<label>Noise cancellation</label><div class="seg" id="segNoise"><button class="stb" data-v="Off">Off</button><button class="stb" data-v="Standard">Standard</button><button class="stb" data-v="Strong">Strong</button></div>
<label class="chk"><input type="checkbox" id="cEcho"> Echo guard (turn off when you wear headphones)</label>
<h4>Volume of each participant (only on your device)</h4><div id="pVols"></div>
</section>
<section data-p="video" class="hidden">
<label>Camera</label><select id="sCam"></select>
<label>Quality</label><select id="sQ"><option value="720">HD 720p</option><option value="480">Standard 480p</option><option value="360">Data saver 360p</option></select>
<label class="chk"><input type="checkbox" id="cMirror"> Mirror my video (others always see it normally)</label>
<label class="chk"><input type="checkbox" id="cFit"> Show full video without cropping</label>
</section>
<section data-p="bg" class="hidden">
<div class="bgg" id="bgGrid"><button data-b="none">None</button><button data-b="blur">Blur</button><button data-b="blur2">Strong blur</button>${Object.entries(PRE).map(([k, [a, b]]) => `<button data-b="pre:${k}" style="background-image:linear-gradient(135deg,${a},${b})">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}<button data-b="custom" id="bgCustom" class="hidden">My image</button><button id="bgUp">⬆ Upload</button></div>
<input type="file" id="bgFile" accept="image/*" hidden>
<div class="stm" id="bgStat">Backgrounds use your camera, so they need a moment to load the first time and use extra CPU.</div>
</section>
<section data-p="host" class="hidden"><div id="stHost" style="display:flex;flex-direction:column;gap:10px"></div></section>
<section data-p="gen" class="hidden">
<label class="chk"><input type="checkbox" id="cSnd"> Play a sound when someone joins or leaves</label>
<label class="chk"><input type="checkbox" id="cJoinMic"> Join meetings with my microphone off</label>
<label class="chk"><input type="checkbox" id="cJoinCam"> Join meetings with my camera off</label>
<h4>Keyboard shortcuts</h4><div class="stm">M mute · V camera · C chat · N notes · S settings · Esc close</div>
<div><button class="stb" id="bReset">Reset settings</button></div>
</section>
</div></div>`;
document.body.append(box);

/* ---------- Tabs / open / close ---------- */
let mRaf = 0;
function setTab(t) {
  tab = t;
  box.querySelectorAll('.stt button').forEach(b => b.classList.toggle('on', b.dataset.p === t));
  box.querySelectorAll('section').forEach(s => s.classList.toggle('hidden', s.dataset.p !== t));
  const pv = t === 'video' || t === 'bg'; $('stPvBox').classList.toggle('hidden', !pv); if (pv) $('stPv').srcObject = stream() || null;
  if (t === 'audio') { pVols(); if (!mRaf) meter(); }
  if (t === 'host') renderHost(true);
}
function setOpen(v) { open = v; box.classList.toggle('hidden', !v); if (v) { syncUI(); setTab(tab); devices(); } }
btn.onclick = () => setOpen(!open); lobbyBtn.onclick = () => setOpen(true); $('stX').onclick = () => setOpen(false);
box.onclick = e => { if (e.target === box) setOpen(false); };
box.querySelectorAll('.stt button').forEach(b => b.onclick = () => setTab(b.dataset.p));
addEventListener('keydown', e => {
  if (e.key === 'Escape' && open) return setOpen(false);
  if (e.key === 's' && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && !$('meeting')?.classList.contains('hidden')) setOpen(!open);
});

/* ---------- Audio: volumes, devices, noise, echo ---------- */
function applyVol() {
  document.querySelectorAll('.tile.remote video').forEach(v => {
    const id = v.closest('.tile').id.slice(2);
    v.volume = Math.max(0, Math.min(1, S.master / 100 * (V[id] ?? 1)));
    if ('sinkId' in v && v.sinkId !== S.spk) v.setSinkId(S.spk).catch(() => {});
  });
}
function pVols() {
  const b = $('pVols'); b.innerHTML = ''; const t = [...document.querySelectorAll('.tile.remote')];
  if (!t.length) return void b.append(el('div', 'stm', 'No one else is in the meeting yet.'));
  t.forEach(x => {
    const id = x.id.slice(2), r = el('div', 'stvr'), n = el('span', '', x.querySelector('.nm')?.textContent || 'Guest'), s = el('input'), v = el('b', '', Math.round((V[id] ?? 1) * 100) + '%');
    s.type = 'range'; s.min = 0; s.max = 100; s.value = (V[id] ?? 1) * 100;
    s.oninput = () => { V[id] = s.value / 100; v.textContent = s.value + '%'; applyVol(); };
    r.append(n, s, v); b.append(r);
  });
}
$('rMaster').oninput = e => { S.master = +e.target.value; $('vMaster').textContent = S.master + '%'; save(); applyVol(); };
$('rMic').oninput = e => { S.mic = +e.target.value; $('vMic').textContent = S.mic + '%'; save(); setGain(); };
new MutationObserver(() => { applyVol(); if (open && tab === 'audio') pVols(); }).observe($('grid'), { childList: true });

const curMic = () => (G.src ? G.src.mediaStream : stream())?.getAudioTracks()[0]?.getSettings?.().deviceId || '';
const curCam = () => camTrack()?.getSettings?.().deviceId || '';
async function devices() {
  let d = []; try { d = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const fill = (id, kind, cur) => {
    const s = $(id), l = d.filter(x => x.kind === kind); s.innerHTML = '';
    if (!l.length) s.append(new Option('Default', ''));
    l.forEach((x, i) => s.append(new Option(x.label || kind + ' ' + (i + 1), x.deviceId))); if (cur) s.value = cur;
  };
  fill('sMic', 'audioinput', curMic()); fill('sCam', 'videoinput', curCam()); fill('sSpk', 'audiooutput', S.spk);
  $('sSpk').disabled = !('setSinkId' in HTMLMediaElement.prototype);
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => open && devices());

function putTrack(kind, t) {                                       // swap a track in the local stream AND in every peer connection
  const ls = stream(); if (!ls) return;
  const old = ls.getTracks().find(x => x.kind === kind); if (old === t) return;
  if (t && old) t.enabled = old.enabled;
  if (old) ls.removeTrack(old); if (t) ls.addTrack(t);
  if (old) G.pcs.forEach(pc => pc.getSenders().forEach(s => { if (s.track === old) s.replaceTrack(t || null).catch(() => {}); }));
}
async function setMic(id) {
  const ns = (await navigator.mediaDevices.getUserMedia({ audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })).getAudioTracks()[0];
  if (G.src) {                                                     // in a meeting: feed the page's own noise-gate chain
    const old = G.src.mediaStream.getTracks(); G.src.disconnect();
    G.src.context.createMediaStreamSource(new MediaStream([ns])).connect(G.hp); old.forEach(t => t.stop());
  } else putTrack('audio', ns);                                    // lobby: the page wraps it when you join
}
$('sMic').onchange = async e => { try { await setMic(e.target.value); S.micDev = e.target.value; save(); toast('Microphone changed'); } catch { toast('Could not use that microphone'); devices(); } };
$('sSpk').onchange = e => { S.spk = e.target.value; save(); applyVol(); toast('Speaker changed'); };
function wav() {
  const sr = 22050, n = sr * .6 | 0, b = new ArrayBuffer(44 + n * 2), d = new DataView(b), w = (o, s) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, sr, true); d.setUint32(28, sr * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const t = i / sr; d.setInt16(44 + i * 2, Math.sin(2 * Math.PI * (t < .3 ? 660 : 880) * t) * Math.min(1, t * 20, (.6 - t) * 10) * 12000, true); }
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
$('bTest').onclick = async () => { const a = new Audio(wav()); a.volume = S.master / 100; if (S.spk && a.setSinkId) await a.setSinkId(S.spk).catch(() => {}); a.play().catch(() => {}); };
$('segNoise').onclick = e => {
  const v = e.target.dataset?.v; if (!v || !$('noiseBtn')) return;
  for (let i = 0; i < 3 && lbl('noiseBtn') !== 'Noise: ' + v; i++) { const b = lbl('noiseBtn'); $('noiseBtn').click(); if (lbl('noiseBtn') === b) break; }
  syncNoise();
};
const syncNoise = () => { const c = lbl('noiseBtn').replace('Noise: ', ''); $('segNoise').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === c)); };
$('cEcho').onchange = e => { if (e.target.checked !== lbl('echoBtn').includes('On')) $('echoBtn')?.click(); };

let mAn, mSrc, mTid;                                               // live microphone level
function meter() {
  if (!open || tab !== 'audio') { mRaf = 0; return; }
  const t = stream()?.getAudioTracks()[0];
  if (t && t.id !== mTid) { mTid = t.id; try { mSrc?.disconnect(); const c = ac(); mAn = mAn || c.createAnalyser(); mAn.fftSize = 512; mSrc = c.createMediaStreamSource(new MediaStream([t])); mSrc.connect(mAn); } catch {} }
  if (mAn) { const b = new Uint8Array(mAn.fftSize); mAn.getByteTimeDomainData(b); let m = 0; b.forEach(v => m = Math.max(m, Math.abs(v - 128))); $('meter').style.width = Math.min(100, m / 128 * 220) + '%'; }
  mRaf = requestAnimationFrame(meter);
}

/* ---------- Video: camera, quality, mirror, fit ---------- */
async function getCam(id) {
  const [w, h, f] = QS[S.q];
  return (await navigator.mediaDevices.getUserMedia({ video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: f } } })).getVideoTracks()[0];
}
async function setCam(id) {
  const old = camTrack(), t = await getCam(id);
  if (fx.out) fx.vid.srcObject = new MediaStream([t]); else putTrack('video', t);
  old?.stop(); fx.raw = t;
}
$('sCam').onchange = async e => { try { await setCam(e.target.value); S.cam = e.target.value; save(); toast('Camera changed'); } catch { toast('Could not use that camera'); devices(); } };
$('sQ').onchange = e => { S.q = e.target.value; save(); const [w, h, f] = QS[S.q]; camTrack()?.applyConstraints({ width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: f } }).catch(() => toast('This camera cannot change quality')); };
$('cMirror').onchange = e => { S.mirror = e.target.checked; save(); applyCss(); };
$('cFit').onchange = e => { S.fit = e.target.checked; save(); applyCss(); };

/* ---------- Background (blur / virtual image) ---------- */
const stat = t => { $('bgStat').textContent = t; };
let segP;
function loadSeg() {
  if (fx.seg) return Promise.resolve();
  return segP = segP || new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = CDN + 'selfie_segmentation.js'; s.crossOrigin = 'anonymous';
    s.onload = () => { try { fx.seg = new SelfieSegmentation({ locateFile: f => CDN + f }); fx.seg.setOptions({ modelSelection: 1 }); fx.seg.onResults(drawFrame); fx.seg.initialize().then(res, rej); } catch (e) { rej(e); } };
    s.onerror = rej; document.head.append(s);
  }).catch(e => { segP = null; fx.seg = null; throw e; });
}
const tmp = document.createElement('canvas');
function blur(c, img, w, h, px) {
  if ('filter' in c) { c.filter = `blur(${px}px)`; c.drawImage(img, -px * 2, -px * 2, w + px * 4, h + px * 4); c.filter = 'none'; return; }
  const k = px > 10 ? 24 : 12; tmp.width = Math.max(1, w / k | 0); tmp.height = Math.max(1, h / k | 0);
  tmp.getContext('2d').drawImage(img, 0, 0, tmp.width, tmp.height); c.imageSmoothingQuality = 'high'; c.drawImage(tmp, 0, 0, w, h);
}
function drawFrame(r) {
  const c = fx.ctx, w = fx.cvs.width, h = fx.cvs.height; if (!c) return;
  c.save(); c.clearRect(0, 0, w, h);
  c.drawImage(r.segmentationMask, 0, 0, w, h);
  c.globalCompositeOperation = 'source-in'; c.drawImage(r.image, 0, 0, w, h);                      // keep only the person
  c.globalCompositeOperation = 'destination-over';                                                  // paint the new background behind
  if (S.bg.startsWith('blur')) blur(c, r.image, w, h, S.bg === 'blur2' ? 18 : 8);
  else if (fx.bgImg) { const i = fx.bgImg, s = Math.max(w / i.width, h / i.height); c.drawImage(i, (w - i.width * s) / 2, (h - i.height * s) / 2, i.width * s, i.height * s); }
  else { c.fillStyle = '#1d2430'; c.fillRect(0, 0, w, h); }
  c.restore();
}
async function tick() {
  if (fx.busy || !fx.vid || fx.vid.readyState < 2) return; fx.busy = true;
  try { const w = fx.vid.videoWidth, h = fx.vid.videoHeight; if (w && (fx.cvs.width !== w || fx.cvs.height !== h)) { fx.cvs.width = w; fx.cvs.height = h; } await fx.seg.send({ image: fx.vid }); } catch {}
  fx.busy = false;
}
async function bgSource() {
  if (S.bg.startsWith('pre:')) { const [a, b] = PRE[S.bg.slice(4)] || PRE.slate, k = document.createElement('canvas'); k.width = 1280; k.height = 720; const x = k.getContext('2d'), g = x.createLinearGradient(0, 0, 1280, 720); g.addColorStop(0, a); g.addColorStop(1, b); x.fillStyle = g; x.fillRect(0, 0, 1280, 720); return k; }
  if (S.bg === 'custom' && S.custom) return new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = S.custom; });
  return null;
}
function stopFx() { clearInterval(fx.timer); if (fx.out) { putTrack('video', fx.raw); fx.out.stop(); fx.out = null; } }
async function applyBg() {
  const raw = camTrack(); if (!raw) { stat('No camera available.'); return; }
  fx.raw = fx.raw || raw;
  if (S.bg === 'none') { stopFx(); stat('Background effects are off.'); return; }
  stat('Loading background effect…');
  try { await loadSeg(); } catch { S.bg = 'none'; save(); stopFx(); markBg(); stat('Could not load the background model. Check your connection and try again.'); toast('Background effects are unavailable'); return; }
  fx.bgImg = await bgSource();
  if (!fx.out) {
    fx.vid = fx.vid || Object.assign(document.createElement('video'), { muted: true, playsInline: true });
    fx.vid.srcObject = new MediaStream([fx.raw]); await fx.vid.play().catch(() => {});
    fx.cvs = fx.cvs || document.createElement('canvas'); fx.cvs.width = fx.vid.videoWidth || 1280; fx.cvs.height = fx.vid.videoHeight || 720; fx.ctx = fx.cvs.getContext('2d');
    fx.out = fx.cvs.captureStream(24).getVideoTracks()[0]; putTrack('video', fx.out);
    fx.timer = setInterval(tick, 1000 / 24);
  }
  stat('Background effect is on. Keep this tab visible: browsers slow down hidden tabs.');
}
const markBg = () => $('bgGrid').querySelectorAll('[data-b]').forEach(b => b.classList.toggle('on', b.dataset.b === S.bg));
function setBg(v) { S.bg = v; save(); markBg(); applyBg(); }
$('bgGrid').onclick = e => { const b = e.target.closest('[data-b]'); if (b) setBg(b.dataset.b); };
$('bgUp').onclick = () => $('bgFile').click();
$('bgFile').onchange = e => {
  const f = e.target.files[0]; if (!f) return; const i = new Image();
  i.onload = () => { const s = Math.min(1, 960 / i.width), k = document.createElement('canvas'); k.width = i.width * s; k.height = i.height * s; k.getContext('2d').drawImage(i, 0, 0, k.width, k.height); URL.revokeObjectURL(i.src); S.custom = k.toDataURL('image/jpeg', .82); $('bgCustom').classList.remove('hidden'); setBg('custom'); };
  i.onerror = () => toast('That file is not a valid image'); i.src = URL.createObjectURL(f); e.target.value = '';
};

/* ---------- General ---------- */
$('cSnd').onchange = e => { S.snd = e.target.checked; save(); };
$('cJoinMic').onchange = e => { S.joinMic = e.target.checked; save(); };
$('cJoinCam').onchange = e => { S.joinCam = e.target.checked; save(); };
$('bReset').onclick = () => { if (!confirm('Reset all settings to their defaults?')) return; S = { ...D }; save(); applyCss(); applyVol(); setGain(); setBg('none'); syncUI(); toast('Settings reset'); };
function beep(up) {
  if (!S.snd) return;
  try { const c = ac(), o = c.createOscillator(), g = c.createGain(); o.frequency.value = up ? 660 : 440; g.gain.setValueAtTime(.08, c.currentTime); g.gain.exponentialRampToValueAtTime(.001, c.currentTime + .25); o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + .26); } catch {}
}
new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { const t = n.textContent || ''; if (/ joined$/.test(t)) beep(true); else if (/ left$/.test(t)) beep(false); }))).observe($('toasts'), { childList: true });

function syncUI() {
  $('rMaster').value = S.master; $('vMaster').textContent = S.master + '%'; $('rMic').value = S.mic; $('vMic').textContent = S.mic + '%';
  $('sQ').value = S.q; $('cMirror').checked = S.mirror; $('cFit').checked = S.fit; $('cSnd').checked = S.snd; $('cJoinMic').checked = S.joinMic; $('cJoinCam').checked = S.joinCam;
  $('bgCustom').classList.toggle('hidden', !S.custom); markBg(); syncNoise(); $('cEcho').checked = lbl('echoBtn').includes('On');
  $('cEcho').disabled = $('noiseBtn') == null; $('bgStat').textContent = fx.out ? 'Background effect is on.' : $('bgStat').textContent;
}

/* ---------- Host controls (Firestore) ---------- */
const hostUid = () => Object.entries(P).filter(([id, p]) => id === me || Date.now() - (p.seen || 0) < 45000).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))[0]?.[0];
const isHost = () => !!me && hostUid() === me;
const lock = k => !!R[k] && R.by === hostUid() && !isHost();
const cmd = (type, to = 'all', val = null) => addDoc(collection(db, 'rooms', room, 'commands'), { from: me, type, to, val, ts: Date.now() })
  .then(r => setTimeout(() => deleteDoc(r).catch(() => {}), 20000)).catch(() => toast('Could not send (check Firestore rules)'));
function run(c) {                                                  // a command from the host
  if (c.type === 'mute' && micOn()) { $('micBtn').click(); toast('The host muted your microphone'); }
  else if (c.type === 'stopvideo' && camOn()) { $('camBtn').click(); toast('The host turned off your video'); }
  else if (c.type === 'lowerhand' && /Lower/.test(lbl('handBtn'))) $('handBtn').click();
  else if (c.type === 'gain') { hostGain = Math.max(0, Math.min(1.5, +c.val || 1)); setGain(); toast('The host changed your voice level'); }
  else if (c.type === 'kick') { toast('The host removed you from the meeting'); setTimeout(() => $('leaveBtn').click(), 800); }
}
let hsig = '';
function renderHost(force) {
  const b = $('stHost'); if (!b) return;
  if (!room) { b.innerHTML = ''; return void b.append(el('div', 'stm', 'Join a meeting to see the host controls.')); }
  const host = hostUid(), ids = Object.keys(P).filter(id => id === me || Date.now() - (P[id].seen || 0) < 45000);
  const sig = host + '|' + ids.map(i => i + P[i].name).join() + '|' + !!R.micLock + !!R.noShare + R.by;
  if (!force && sig === hsig) return; hsig = sig; b.innerHTML = '';
  b.append(el('div', 'stm', 'Host: ' + (P[host]?.name || '…') + (host === me ? ' (you)' : '') + '. The host is whoever has been in the room longest. If they leave, the next person takes over.'));
  if (host !== me) { if (lock('micLock')) b.append(el('div', 'stm', '🔒 The host has locked microphones.')); if (lock('noShare')) b.append(el('div', 'stm', '🚫 Only the host can share their screen.')); return; }
  const row = el('div', 'stro');
  [['🔇 Mute all', 'mute'], ['📷 Stop all video', 'stopvideo'], ['✋ Lower all hands', 'lowerhand']].forEach(([t, k]) => { const x = el('button', 'stb', t); x.onclick = () => { cmd(k); toast('Sent to everyone'); }; row.append(x); });
  b.append(row);
  [['micLock', '🔒 Lock microphones (people can mute but not unmute)'], ['noShare', '🚫 Only the host can share the screen']].forEach(([k, t]) => {
    const l = el('label', 'chk'), c = el('input'); c.type = 'checkbox'; c.checked = !!R[k];
    c.onchange = () => setDoc(doc(db, 'rooms', room, 'hostset', 'state'), { [k]: c.checked, by: me }, { merge: true }).catch(() => toast('Could not save (check Firestore rules)'));
    l.append(c, t); b.append(l);
  });
  b.append(el('h4', '', 'Participants and voice level'));
  const others = ids.filter(i => i !== me); if (!others.length) b.append(el('div', 'stm', 'No one else is here yet.'));
  others.forEach(id => {
    const r = el('div', 'sthr'), s = el('input'), v = el('b', '', (HG[id] ?? 100) + '%'), m = el('button', 'stb', '🔇'), k = el('button', 'stb', 'Remove');
    s.type = 'range'; s.min = 0; s.max = 150; s.value = HG[id] ?? 100; m.title = 'Mute'; k.title = 'Remove from meeting';
    s.oninput = () => { v.textContent = s.value + '%'; }; s.onchange = () => { HG[id] = +s.value; cmd('gain', id, s.value / 100); };
    m.onclick = () => { cmd('mute', id); toast('Muted ' + P[id].name); }; k.onclick = () => { if (confirm('Remove ' + P[id].name + ' from the meeting?')) cmd('kick', id); };
    const w = el('div', 'stro'); w.style.gap = '6px'; w.append(s, v);
    r.append(el('span', '', P[id].name || 'Guest'), w, m, k); b.append(r);
  });
}
document.addEventListener('click', e => {                          // enforce host locks on this device
  const t = e.target.closest ? e.target.closest('#micBtn,#shareBtn') : null; if (!t) return;
  if (t.id === 'micBtn' && lock('micLock') && !micOn()) { e.stopImmediatePropagation(); e.preventDefault(); toast('The host has locked microphones'); }
  if (t.id === 'shareBtn' && lock('noShare') && !/Stop/.test(lbl('shareBtn'))) { e.stopImmediatePropagation(); e.preventDefault(); toast('Only the host can share the screen'); }
}, true);
addEventListener('keydown', e => { if (e.key === 'm' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && lock('micLock') && !micOn()) { e.stopImmediatePropagation(); toast('The host has locked microphones'); } }, true);

function joinPrefs() { if (S.joinMic && micOn()) $('micBtn').click(); if (S.joinCam && camOn()) $('camBtn').click(); }
function start() {
  if (started) return; started = true;
  const app = getApps()[0]; db = getFirestore(app); me = getAuth(app).currentUser?.uid;
  room = decodeURIComponent(location.hash.slice(1)); if (!me || !room) { started = false; return; }
  onSnapshot(collection(db, 'rooms', room, 'participants'), s => { P = {}; s.docs.forEach(d => P[d.id] = d.data()); renderHost(); }, e => console.error(e));
  onSnapshot(doc(db, 'rooms', room, 'hostset', 'state'), s => { R = s.exists() ? s.data() : {}; renderHost(); }, () => {});
  let first = true;
  onSnapshot(collection(db, 'rooms', room, 'commands'), s => {
    s.docChanges().forEach(ch => {
      if (first || ch.type !== 'added') return; const c = ch.doc.data();
      if (c.from === me || c.from !== hostUid() || (c.to !== 'all' && c.to !== me)) return; run(c);
    }); first = false;
  }, () => {});
  setTimeout(joinPrefs, 1500); applyVol();
}
new MutationObserver(() => { if (!$('meeting').classList.contains('hidden')) start(); }).observe($('meeting'), { attributes: true, attributeFilter: ['class'] });

/* ---------- Restore saved devices / background once the camera preview exists ---------- */
async function ready() {
  const n = $('nameIn'); if (n && !n.value) { try { n.value = localStorage.getItem('pm_name') || ''; } catch {} }
  for (let i = 0; i < 40 && !stream(); i++) await new Promise(r => setTimeout(r, 250));
  if (!stream()) return;
  try { if (S.cam && S.cam !== curCam()) await setCam(S.cam); } catch { S.cam = ''; }
  try { if (S.micDev && S.micDev !== curMic()) await setMic(S.micDev); } catch { S.micDev = ''; }
  save(); if (S.bg !== 'none') applyBg(); applyVol();
}
applyCss(); syncUI(); ready();
