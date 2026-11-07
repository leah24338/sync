// Teacher console: streams the mic to the server and sends whiteboard photos.

const $ = (id) => document.getElementById(id);
const key = new URLSearchParams(location.search).get("key");
const withKey = (path) => (key ? `${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}` : path);
const wsUrl = (path) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${withKey(path)}`;
const post = (path, body) =>
  fetch(withKey(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

// ---------- Server status ----------

async function refreshStatus() {
  try {
    const s = await fetch("/api/status").then((r) => r.json());
    const flag = (on, name) => `<span class="pill ${on ? "on" : "off"}" title="${name} ${on ? "connected" : "key missing"}">${name}</span>`;
    const count = (n, word) => `<span class="pill neutral">${n} ${word}${n === 1 ? "" : "s"}</span>`;
    $("serverStatus").innerHTML = `${flag(s.claude, "Claude")}${flag(s.deepgram, "Deepgram")}${count(s.students, "viewer")}${count(s.events, "event")}`;
  } catch {
    $("serverStatus").innerHTML = '<span class="pill off">Server unreachable</span>';
  }
}
refreshStatus();
setInterval(refreshStatus, 3000);

// The student app is only there when the page is opened through the app (port 8080 or the
// tunnel), not straight from the lecture server.
if (location.port === "3001") $("studentLinks").hidden = true;

// ---------- Microphone ----------
// MediaRecorder produces WebM/Opus chunks every 250 ms; they go straight to Deepgram via our server.

const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
let micStream = null;
let recorder = null;
let teacherWs = null;
let micWanted = false;

$("micStart").onclick = async () => {
  const mimeType = MIME_TYPES.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mimeType) {
    $("micStatus").textContent = "This browser can't stream WebM audio. Use Chrome, Edge or Firefox.";
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    $("micStatus").textContent = `Mic blocked: ${error.message}`;
    return;
  }
  micWanted = true;
  $("micStart").disabled = true;
  $("micStop").disabled = false;
  document.body.classList.add("mic-on");
  stopLevelMeter = startLevelMeter(micStream);
  connectTeacher(mimeType);
};

$("micStop").onclick = () => {
  micWanted = false;
  stopRecorder();
  teacherWs?.close();
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  stopLevelMeter?.();
  document.body.classList.remove("mic-on");
  $("micStart").disabled = false;
  $("micStop").disabled = true;
  $("micStatus").textContent = "Mic off.";
};

// Live input level, so the teacher can see the mic is actually hearing them.
let stopLevelMeter = null;
function startLevelMeter(stream) {
  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 512;
  audio.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  let frame;
  const tick = () => {
    analyser.getByteTimeDomainData(samples);
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s - 128));
    $("level").style.transform = `scaleX(${Math.min(1, peak / 64)})`;
    frame = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(frame);
    audio.close();
    $("level").style.transform = "scaleX(0)";
  };
}

function connectTeacher(mimeType) {
  $("micStatus").textContent = "Connecting…";
  teacherWs = new WebSocket(wsUrl("/ws/teacher"));
  teacherWs.onopen = () => startRecorder(mimeType);
  teacherWs.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "status") {
      const text = { connecting: "Connecting to Deepgram…", open: "Listening", closed: "Deepgram closed", error: "Error" }[msg.state];
      $("micStatus").textContent = msg.message ? `${text}: ${msg.message}` : text;
    } else if (msg.type === "audio-restart") {
      stopRecorder();
      startRecorder(mimeType);
    }
  };
  teacherWs.onclose = () => {
    stopRecorder();
    if (micWanted) {
      $("micStatus").textContent = "Reconnecting…";
      setTimeout(() => micWanted && connectTeacher(mimeType), 1000);
    }
  };
}

function startRecorder(mimeType) {
  if (!micStream || teacherWs?.readyState !== WebSocket.OPEN) return;
  // Tell the server a new recording starts: its first chunk carries the WebM header.
  teacherWs.send(JSON.stringify({ type: "start" }));
  recorder = new MediaRecorder(micStream, { mimeType, audioBitsPerSecond: 32000 });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0 && teacherWs?.readyState === WebSocket.OPEN) teacherWs.send(e.data);
  };
  recorder.start(250);
}

function stopRecorder() {
  if (!recorder) return;
  recorder.ondataavailable = null; // don't send the old recording's tail into a new stream
  if (recorder.state !== "inactive") recorder.stop();
  recorder = null;
}

// ---------- Camera and whiteboard ----------

const video = $("video");
let camOn = false;

$("camStart").onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    camOn = true;
    $("camStart").disabled = true;
    $("capture").disabled = false;
    $("boardStatus").textContent = "Camera on. Fill the frame with the board, avoid glare, then press Capture board.";
  } catch (error) {
    $("boardStatus").textContent = `Camera blocked: ${error.message}`;
  }
};

$("capture").onclick = () => captureBoard("Manual");

// Photos are resized to at most 1280 px wide before upload: big enough to read marker,
// small enough to keep the image around ~1,200 Claude tokens and the upload fast.
const MAX_WIDTH = 1280;
const canvas = document.createElement("canvas");

async function captureBoard(reason) {
  if (!camOn || !video.videoWidth) return;
  const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  lastSentFrame = grayFrame();
  lastSentAt = Date.now();
  try {
    const res = await fetch(withKey("/api/board"), { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
    const body = await res.json();
    const note = body.claude === false ? " (Claude is off: add ANTHROPIC_API_KEY)" : "";
    $("boardStatus").textContent = `${reason} capture sent at ${new Date().toLocaleTimeString()} (${Math.round(blob.size / 1024)} KB)${note}`;
  } catch (error) {
    $("boardStatus").textContent = `Upload failed: ${error.message}`;
  }
}

// Auto-capture: compare tiny grayscale frames twice a second. Send a photo only when
//  1) the picture has been still for 2 s (the teacher stepped away or stopped writing), and
//  2) it differs from the last photo sent (something new is on the board), and
//  3) at least 5 s have passed since the last photo.
// This keeps people out of the shot and sends a few photos a minute instead of 30 frames a second.
const SMALL_W = 160;
const SMALL_H = 90;
const PIXEL_DIFF = 30; // a pixel "changed" if its brightness moved by more than this (0–255)
const MOTION_LIMIT = 0.01; // under 1% of pixels changing between ticks counts as "still"
const CHANGE_MIN = 0.008; // over 0.8% of pixels differing from the last photo counts as "new writing"
const STILL_MS = 2000;
const MIN_GAP_MS = 5000;
const TICK_MS = 500;

const small = document.createElement("canvas");
small.width = SMALL_W;
small.height = SMALL_H;
const smallCtx = small.getContext("2d", { willReadFrequently: true });
let prevFrame = null;
let lastSentFrame = null;
let lastSentAt = 0;
let stillMs = 0;

function grayFrame() {
  if (!video.videoWidth) return null;
  smallCtx.drawImage(video, 0, 0, SMALL_W, SMALL_H);
  const rgba = smallCtx.getImageData(0, 0, SMALL_W, SMALL_H).data;
  const gray = new Uint8Array(SMALL_W * SMALL_H);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    gray[j] = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
  }
  return gray;
}

function changedFraction(a, b) {
  if (!a || !b) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL_DIFF) changed++;
  return changed / a.length;
}

setInterval(() => {
  if (!camOn || !$("auto").checked) {
    $("meter").textContent = "";
    return;
  }
  const frame = grayFrame();
  const motion = changedFraction(frame, prevFrame);
  prevFrame = frame;
  stillMs = motion < MOTION_LIMIT ? stillMs + TICK_MS : 0;
  const change = changedFraction(frame, lastSentFrame);
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  $("meter").textContent = `motion ${pct(motion)} · new since last photo ${pct(change)} · still ${(stillMs / 1000).toFixed(1)} s`;
  if (stillMs >= STILL_MS && change > CHANGE_MIN && Date.now() - lastSentAt > MIN_GAP_MS) {
    captureBoard("Auto");
  }
}, TICK_MS);

// ---------- Explanation settings ----------

async function loadSettings() {
  try {
    const current = await fetch("/api/settings").then((r) => r.json());
    $("idioms").value = current.idioms;
    $("terms").value = current.terms;
  } catch {
    // Keep the defaults shown in the page.
  }
}
loadSettings();

for (const id of ["idioms", "terms"]) {
  $(id).onchange = async () => {
    const res = await post("/api/settings", { idioms: $("idioms").value, terms: $("terms").value });
    $("settingsStatus").textContent = res.error
      ? `Couldn't save: ${res.error}`
      : `Saved. Applies from the next sentence. Idioms: ${$("idioms").selectedOptions[0].text} · Key terms: ${$("terms").selectedOptions[0].text}`;
  };
}

// ---------- Lecture controls ----------

async function loadSessions() {
  try {
    const { sessions } = await fetch(withKey("/api/sessions")).then((r) => r.json());
    $("sessions").innerHTML = '<option value="">Saved sessions…</option>';
    for (const name of sessions) $("sessions").add(new Option(name, name));
  } catch {
    // Not fatal: the list just stays empty.
  }
}
loadSessions();

const show = (text) => ($("lectureStatus").textContent = text);

$("replayMock").onclick = async () => show(`Replaying: ${(await post("/api/replay")).replaying}`);
$("replaySession").onclick = async () => {
  const session = $("sessions").value;
  if (!session) return show("Pick a saved session first.");
  const res = await post("/api/replay", { session });
  show(res.error ?? `Replaying: ${res.replaying}`);
};
$("replayStop").onclick = async () => {
  await post("/api/replay/stop");
  show("Replay stopped.");
};
$("save").onclick = async () => {
  show(`Saved ${(await post("/api/save")).saved}`);
  loadSessions();
};
$("reset").onclick = async () => {
  if (!confirm("Clear the whole lecture for everyone?")) return;
  await post("/api/reset");
  show("Lecture reset.");
};
