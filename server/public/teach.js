// Teacher console: one button runs the lecture (microphone + board camera); everything else is optional.

const $ = (id) => document.getElementById(id);
const key = new URLSearchParams(location.search).get("key");
const withKey = (path) => (key ? `${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}` : path);
const wsBase = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const post = (path, body) =>
  fetch(withKey(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const say = (text) => ($("micStatus").textContent = text);
const boardSay = (text) => ($("boardStatus").textContent = text);

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2800);
}

function friendlyError(error, device) {
  if (device === "screen share" && error?.name === "NotAllowedError") {
    return "Screen sharing was cancelled. Press Share screen to try again.";
  }
  switch (error?.name) {
    case "NotAllowedError":
      return `The ${device} is blocked. Click the ${device} icon in the address bar, allow access, then try again.`;
    case "NotFoundError":
      return `No ${device} found. Plug one in and try again.`;
    case "NotReadableError":
      return `Another app is using the ${device}. Close it and try again.`;
    case "OverconstrainedError":
      return `That ${device} isn't available any more. Pick another one.`;
    default:
      return `Couldn't start the ${device}: ${error?.message ?? error}`;
  }
}

// ---------- Status ----------

async function refreshStatus() {
  try {
    const s = await fetch("/api/status").then((r) => r.json());
    const chip = (on, okText, offText, offHelp) =>
      `<span class="chip ${on ? "ok" : "bad"}" title="${on ? "Ready" : offHelp}">${on ? okText : offText}</span>`;
    const joined = `${s.students} student${s.students === 1 ? "" : "s"} joined`;
    $("serverStatus").innerHTML =
      chip(s.deepgram, "Captions ready", "Captions off", "Add DEEPGRAM_API_KEY to .env") +
      chip(s.claude, "AI notes ready", "AI notes off", "Add ANTHROPIC_API_KEY to .env") +
      `<span class="chip">${joined}</span>`;
    $("studentCount").textContent = joined;
  } catch {
    $("serverStatus").innerHTML = '<span class="chip bad">Server unreachable</span>';
  }
}
refreshStatus();
setInterval(refreshStatus, 3000);

// ---------- Start / end lecture ----------

let live = false;
let startedAt = 0;
let timer = null;

$("startLecture").onclick = async () => {
  const wantMic = $("useMic").checked;
  const wantCam = $("useCam").checked;
  if (!wantMic && !wantCam) return say("Choose the microphone, the board camera, or both.");
  if (!navigator.mediaDevices?.getUserMedia) {
    return say("This page needs its secure (https) address to use the microphone and camera. Open it through the tunnel link.");
  }
  $("startLecture").disabled = true;
  say("Starting… If your browser asks, allow access.");
  const problems = [];
  // The board goes first: screen sharing must start straight from the click, before any other prompt.
  const camOk = wantCam ? await startBoard().catch((e) => (problems.push(friendlyError(e, boardDevice())), false)) : false;
  const micOk = wantMic ? await startMic().catch((e) => (problems.push(friendlyError(e, "microphone")), false)) : false;
  $("startLecture").disabled = false;
  if (!micOk && !camOk) return say(problems.join(" "));

  live = true;
  document.body.classList.add("live");
  startedAt = Date.now();
  tickTimer();
  timer = setInterval(tickTimer, 1000);
  say(problems.length ? problems.join(" ") : micOk ? "Listening. Students see captions live." : "Camera on. Captions are off on this device.");
  fillDevicePickers();
};

$("endLecture").onclick = async () => {
  const hadMic = Boolean(micStream);
  stopMic();
  stopCamera();
  live = false;
  clearInterval(timer);
  document.body.classList.remove("live");
  if (!hadMic) return say("Camera stopped.");
  const { saved } = await post("/api/save");
  say(`Lecture ended and saved. Students can still scroll back through it.`);
  toast("Lecture saved");
  loadSessions(saved);
};

function tickTimer() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ---------- Microphone ----------
// MediaRecorder produces WebM/Opus chunks every 250 ms; they go straight to Deepgram via our server.

const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
const micMime = MIME_TYPES.find((m) => window.MediaRecorder?.isTypeSupported(m));
if (!micMime) {
  $("useMic").checked = false;
  $("useMic").disabled = true;
  $("micNote").textContent = "This browser can't stream the microphone (use Chrome, Edge or Firefox). It can still run the board camera.";
}

let micStream = null;
let recorder = null;
let teacherWs = null;
let micWanted = false;
let paused = false;
let stopLevelMeter = null;

async function startMic(deviceId) {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  micWanted = true;
  document.body.classList.add("mic-on");
  stopLevelMeter = startLevelMeter(micStream);
  if (teacherWs?.readyState === WebSocket.OPEN) startRecorder();
  else connectTeacher();
  return true;
}

function stopMic() {
  micWanted = false;
  stopRecorder();
  teacherWs?.close();
  teacherWs = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  stopLevelMeter?.();
  stopLevelMeter = null;
  paused = false;
  document.body.classList.remove("mic-on", "paused");
  $("pause").textContent = "Pause captions";
}

async function switchMic(deviceId) {
  stopRecorder();
  micStream?.getTracks().forEach((t) => t.stop());
  stopLevelMeter?.();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    return say(friendlyError(error, "microphone"));
  }
  stopLevelMeter = startLevelMeter(micStream);
  startRecorder(); // a fresh recording: the server opens a new Deepgram stream for it
  toast("Microphone switched");
}

function connectTeacher() {
  teacherWs = new WebSocket(`${wsBase}${withKey("/ws/teacher")}`);
  teacherWs.onopen = () => startRecorder();
  teacherWs.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "status") {
      if (msg.state === "open") say(paused ? "Paused: students won't see captions until you resume." : "Listening. Students see captions live.");
      else if (msg.state === "connecting") say("Connecting captions…");
      else if (msg.state === "closed") say("Captions reconnecting…");
      else if (msg.state === "error") say(`Captions are off: ${msg.message}`);
    } else if (msg.type === "audio-restart") {
      stopRecorder();
      startRecorder();
    }
  };
  teacherWs.onclose = () => {
    stopRecorder();
    if (micWanted) {
      say("Reconnecting…");
      setTimeout(() => micWanted && connectTeacher(), 1000);
    }
  };
}

function startRecorder() {
  if (!micStream || teacherWs?.readyState !== WebSocket.OPEN) return;
  // Tell the server a new recording starts: its first chunk carries the WebM header.
  teacherWs.send(JSON.stringify({ type: "start" }));
  recorder = new MediaRecorder(micStream, { mimeType: micMime, audioBitsPerSecond: 32000 });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0 && teacherWs?.readyState === WebSocket.OPEN) teacherWs.send(e.data);
  };
  recorder.start(250);
  if (paused) recorder.pause();
}

function stopRecorder() {
  if (!recorder) return;
  recorder.ondataavailable = null; // don't send the old recording's tail into a new stream
  if (recorder.state !== "inactive") recorder.stop();
  recorder = null;
}

// Pause stops sending audio without hanging up, so resuming is instant. The server keeps the
// Deepgram connection alive while it's quiet.
$("pause").onclick = () => {
  paused = !paused;
  if (paused && recorder?.state === "recording") recorder.pause();
  if (!paused && recorder?.state === "paused") recorder.resume();
  document.body.classList.toggle("paused", paused);
  $("pause").textContent = paused ? "Resume captions" : "Pause captions";
  say(paused ? "Paused: students won't see captions until you resume." : "Listening. Students see captions live.");
  toast(paused ? "Captions paused" : "Captions resumed");
};

// Live input level, so the teacher can see the mic is actually hearing them.
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

// ---------- Device pickers (only shown when there's more than one) ----------

async function fillDevicePickers() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (select, kind, current) => {
    const list = devices.filter((d) => d.kind === kind);
    select.replaceChildren(...list.map((d, i) => new Option(d.label || `${kind === "audioinput" ? "Microphone" : "Camera"} ${i + 1}`, d.deviceId, false, d.deviceId === current)));
    select.closest(".device").hidden = list.length < 2;
  };
  fill($("micDevice"), "audioinput", micStream?.getAudioTracks()[0]?.getSettings().deviceId);
  fill($("camDevice"), "videoinput", camStream?.getVideoTracks()[0]?.getSettings().deviceId);
  if (boardKind === "screen") $("camDevice").closest(".device").hidden = true;
}
navigator.mediaDevices?.addEventListener?.("devicechange", () => live && fillDevicePickers());

$("micDevice").onchange = () => micStream && switchMic($("micDevice").value);
$("camDevice").onchange = async () => {
  if (!camStream) return;
  stopCamera();
  await startCamera($("camDevice").value).catch((e) => boardSay(friendlyError(e, "camera")));
  showSourceText();
};

// ---------- Board: camera or screen share ----------
// Both feed the same <video>, so capture, auto-capture and the board reader work the same way.

const video = $("video");
let camStream = null;
let camOn = false;
let boardKind = null; // "camera" | "screen" while the board is on

const canShareScreen = Boolean(navigator.mediaDevices?.getDisplayMedia);
if (!canShareScreen) $("screenOption").hidden = true; // phones can't share their screen

const boardSource = () => document.querySelector('input[name="source"]:checked').value;
const boardDevice = () => (boardSource() === "screen" ? "screen share" : "camera");

function showSourceText() {
  const screen = boardSource() === "screen";
  $("camStart").textContent = screen ? "Share screen" : "Turn on camera";
  $("placeholderText").textContent = screen
    ? "Share your slides or a digital whiteboard. New content is captured when it stays still for 2 seconds."
    : "Point a phone or webcam at the board.";
  $("sourceHint").innerHTML = screen
    ? "Auto-capture picks up each new slide. Your key presses go to your slides, not this page."
    : "Capture: <kbd>Space</kbd> <kbd>→</kbd> or a presentation clicker";
}
showSourceText();

for (const radio of document.querySelectorAll('input[name="source"]')) {
  radio.onchange = async () => {
    showSourceText();
    if (!camOn) return;
    stopCamera();
    await startBoard().catch((e) => boardSay(friendlyError(e, boardDevice())));
    if (live) fillDevicePickers();
  };
}

function startBoard(deviceId) {
  return boardSource() === "screen" ? startScreen() : startCamera(deviceId);
}

async function startCamera(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  await showBoard(stream, "camera");
  boardSay("Camera on. Fill the frame with the board and avoid glare.");
  return true;
}

async function startScreen() {
  // A low frame rate is plenty for slides and keeps the teacher's computer cool.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5 } }, audio: false });
  stream.getVideoTracks()[0].addEventListener("ended", () => {
    stopCamera();
    boardSay("Screen sharing stopped. Press Share screen to start again.");
  });
  await showBoard(stream, "screen");
  // Key presses go to the slides app, not this page, so let auto-capture catch new slides.
  $("auto").checked = true;
  boardSay("Sharing your screen. Auto-capture is on: each new slide is read once it stays still for 2 seconds.");
  return true;
}

async function showBoard(stream, kind) {
  camStream = stream;
  boardKind = kind;
  video.srcObject = stream;
  video.hidden = false;
  await video.play();
  camOn = true;
  document.body.classList.add("cam-on");
  $("capture").disabled = false;
}

function stopCamera() {
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
  camOn = false;
  boardKind = null;
  video.srcObject = null;
  video.hidden = true;
  document.body.classList.remove("cam-on");
  $("capture").disabled = true;
}

$("camStart").onclick = async () => {
  if (!navigator.mediaDevices?.getUserMedia) return boardSay("Open this page through its https (tunnel) address to use the camera.");
  try {
    await startBoard();
    if (live) fillDevicePickers();
  } catch (error) {
    boardSay(friendlyError(error, boardDevice()));
  }
};

$("capture").onclick = () => captureBoard();

// Photos are resized before upload: 1280 px wide is enough to read marker on a whiteboard and
// keeps the image around ~1,200 Claude tokens; screen shares get 1600 px because slide text is smaller.
const maxWidth = () => (boardKind === "screen" ? 1600 : 1280);
const canvas = document.createElement("canvas");
let awaitingBoardSince = 0;
let noChangeTimer = null;

async function captureBoard(auto = false) {
  if (!camOn || !video.videoWidth) return;
  const scale = Math.min(1, maxWidth() / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  lastSentFrame = grayFrame();
  lastSentAt = Date.now();
  const flash = $("flash");
  flash.classList.remove("go");
  void flash.offsetWidth; // restart the animation
  flash.classList.add("go");
  try {
    const res = await fetch(withKey("/api/board"), { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
    const body = await res.json();
    if (body.claude === false) return boardSay("Photo sent, but AI notes are off (add ANTHROPIC_API_KEY), so it won't be read.");
    boardSay(`${auto ? "Auto-captured" : "Photo sent"}. Reading the board…`);
    if (!auto) toast("Board photo sent");
    awaitingBoardSince = Date.now();
    clearTimeout(noChangeTimer);
    noChangeTimer = setTimeout(() => {
      awaitingBoardSince = 0;
      boardSay(boardKind === "screen" ? "Nothing new on screen since the last capture." : "No new writing found in that photo.");
    }, 25_000);
  } catch (error) {
    boardSay(`Couldn't send the photo: ${error.message}`);
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
    captureBoard(true);
  }
}, TICK_MS);

// ---------- Feedback from the live feed ----------
// The console listens to the same feed as students (as a preview, so it isn't counted) to show
// what's being captioned and to confirm when a board photo has been read.

let boardContent = new Set();

function watchFeed() {
  const ws = new WebSocket(`${wsBase}/ws?role=preview`);
  ws.onopen = () => (boardContent = new Set());
  ws.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === "caption") {
      $("nowCaption").textContent = event.text;
      $("nowCaption").classList.toggle("partial", !event.final);
    } else if (event.type === "board") {
      const added = event.blocks.filter((b) => !boardContent.has(b.content)).length;
      boardContent = new Set(event.blocks.map((b) => b.content));
      if (!awaitingBoardSince) return; // history, or a photo from another device
      awaitingBoardSince = 0;
      clearTimeout(noChangeTimer);
      const lines = `${added} new line${added === 1 ? "" : "s"}`;
      boardSay(`Board read at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${lines}. Students can see it now.`);
      toast(`Board read ✓ ${lines}`);
    }
  };
  ws.onclose = () => setTimeout(watchFeed, 2000);
}
watchFeed();

// ---------- Keyboard and presentation clicker ----------
// Clickers send Page Down / arrow keys (and "b"), so the teacher can capture from across the room.

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, select, textarea, dialog")) return;
  if (["PageDown", "ArrowRight", " ", "b", "B"].includes(e.key)) {
    if (e.key === " " && e.target.closest("button")) return; // Space on a focused button presses it
    if (!camOn) return;
    e.preventDefault();
    captureBoard();
  } else if ((e.key === "p" || e.key === "P") && micStream) {
    $("pause").click();
  }
});

// ---------- Join code ----------

function studentUrl() {
  // Straight from the lecture server (port 3001) there's no student app, so share the test viewer.
  return location.port === "3001" ? `${location.origin}/teach/viewer.html` : `${location.origin}/?mode=live`;
}

$("joinBtn").onclick = () => {
  const url = studentUrl();
  $("joinUrl").textContent = url;
  $("joinUrl").href = url;
  $("qr").replaceChildren();
  if (window.QRCode) new QRCode($("qr"), { text: url, width: 240, height: 240, correctLevel: QRCode.CorrectLevel.M });
  else $("qr").textContent = "QR code unavailable offline: share the link below.";
  $("joinWarn").hidden = !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  $("joinDialog").showModal();
};
$("closeJoin").onclick = () => $("joinDialog").close();
$("copyJoin").onclick = async () => {
  try {
    await navigator.clipboard.writeText(studentUrl());
    toast("Link copied");
  } catch {
    toast("Copy failed: select the link instead");
  }
};

// ---------- Settings & tools ----------

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
    $("settingsStatus").textContent = res.error ? `Couldn't save: ${res.error}` : "Saved. Applies from the next sentence.";
    if (!res.error) toast("Explanation settings saved");
  };
}

// "session-2026-11-07T15-43-50-796Z.json" → "Nov 7, 3:43 PM"
function sessionLabel(name) {
  const m = name.match(/^session-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/);
  if (!m) return name;
  return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function loadSessions(select) {
  try {
    const { sessions } = await fetch(withKey("/api/sessions")).then((r) => r.json());
    $("sessions").replaceChildren(new Option("Saved lectures…", ""), ...sessions.map((n) => new Option(sessionLabel(n), n, false, n === select)));
  } catch {
    // Not fatal: the list just stays empty.
  }
}
loadSessions();

const toolsSay = (text) => ($("lectureStatus").textContent = text);

$("replayMock").onclick = async () => {
  await post("/api/replay");
  toolsSay("Replaying the demo lecture.");
  toast("Demo lecture playing");
};
$("replaySession").onclick = async () => {
  const session = $("sessions").value;
  if (!session) return toolsSay("Pick a saved lecture first.");
  const res = await post("/api/replay", { session });
  toolsSay(res.error ?? `Replaying the lecture from ${sessionLabel(session)}.`);
};
$("replayStop").onclick = async () => {
  await post("/api/replay/stop");
  toolsSay("Replay stopped.");
};
$("save").onclick = async () => {
  const { saved } = await post("/api/save");
  toolsSay(`Saved (${sessionLabel(saved)}).`);
  toast("Lecture saved");
  loadSessions(saved);
};
$("reset").onclick = async () => {
  if (!confirm("Clear the whole lecture for everyone? Students' screens will empty.")) return;
  await post("/api/reset");
  toolsSay("Cleared.");
  toast("Lecture cleared");
};
