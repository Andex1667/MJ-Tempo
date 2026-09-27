const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'stealth-tempo-session-v1';
const PRESET_STORAGE_KEY = 'stealth-tempo-presets-v1';
const THEME_STORAGE_KEY = 'stealth-tempo-theme-v2';
const CIRC = 2 * Math.PI * 92;

const state = {
  audio: null,
  masterGain: null,
  schedulerTimer: null,
  nextNoteTime: 0,
  beatIndex: 0,
  subdivisionIndex: 0,
  running: false,
  paused: false,
  session: null,
  wakeLock: null,
  uiTimer: null,
  selectedPresetId: null,
  pendingPresetCheckpoint: null,
  lastAutosaveAt: 0,
};

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function rand(min, max) { return min + Math.random() * (max - min); }
function weightedStep() { return Math.random() < 0.76 ? 1 : 2; }

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function validateInputs() {
  const start = Number($('startBpm').value);
  const target = Number($('targetBpm').value);
  const hours = Number($('hours').value);
  const minutes = Number($('minutes').value);
  const totalMin = hours * 60 + minutes;

  let msg = '';
  if (!Number.isFinite(start) || !Number.isFinite(target)) msg = 'BPM 값을 확인해주세요.';
  else if (start < 30 || start > 300 || target < 30 || target > 300) msg = 'BPM은 30~300 사이로 설정해주세요.';
  else if (target < start) msg = '현재 버전에서는 목표 BPM이 시작 BPM보다 같거나 높아야 합니다.';
  else if (!Number.isFinite(totalMin) || totalMin <= 0) msg = '연습 시간을 1분 이상 설정해주세요.';
  $('validationMsg').textContent = msg;
  return !msg;
}

function generateSchedule(startBpm, targetBpm, totalMs) {
  if (targetBpm <= startBpm) return [];

  const warmupEnd = totalMs * 0.05;
  // 설정한 시간은 "타겟 BPM에 도달하기까지의 시간"으로 사용한다.
  const rampEnd = totalMs;
  const rampDuration = rampEnd - warmupEnd;
  let remaining = targetBpm - startBpm;

  const steps = [];
  let lastWasTwo = false;
  while (remaining > 0) {
    let step = weightedStep();
    if (lastWasTwo && step === 2) step = 1;
    step = Math.min(step, remaining);
    steps.push(step);
    remaining -= step;
    lastWasTwo = step === 2;
  }

  // Controlled randomness: generate jittered slots, then normalize spacing.
  const count = steps.length;
  const base = rampDuration / count;
  const raw = [];
  for (let i = 0; i < count; i++) {
    const progress = (i + 1) / count;
    const centerBias = 0.92 + 0.16 * Math.sin(progress * Math.PI); // slightly denser in middle
    raw.push(base * centerBias * rand(0.68, 1.32));
  }
  const rawSum = raw.reduce((a, b) => a + b, 0);
  const scaled = raw.map(v => v * (rampDuration / rawSum));

  // Guard against bursts by smoothing adjacent intervals.
  for (let i = 1; i < scaled.length; i++) {
    const prev = scaled[i - 1];
    const min = prev * 0.55;
    const max = prev * 1.8;
    scaled[i] = clamp(scaled[i], min, max);
  }
  const sum2 = scaled.reduce((a, b) => a + b, 0);
  const scale2 = rampDuration / sum2;

  let t = warmupEnd;
  let bpm = startBpm;
  return steps.map((step, i) => {
    t += scaled[i] * scale2;
    bpm += step;
    return { atMs: Math.min(t, rampEnd), bpm };
  });
}

function createSession() {
  const durationMs = (Number($('hours').value) * 60 + Number($('minutes').value)) * 60 * 1000;
  const startBpm = Number($('startBpm').value);
  const targetBpm = Number($('targetBpm').value);
  const ts = Number($('timeSignature').value);
  return {
    startBpm,
    targetBpm,
    durationMs,
    timeSignature: ts,
    accent: $('accentToggle').checked,
    volume: Number($('volume').value),
    clickSound: $('clickSound').value,
    subdivision: $('subdivision').value,
    songName: $('songName').value.trim(),
    presetId: state.selectedPresetId,
    schedule: generateSchedule(startBpm, targetBpm, durationMs),
    elapsedMs: 0,
    startedAt: Date.now(),
    pausedAt: null,
    pausedTotalMs: 0,
    currentBpm: startBpm,
    scheduleIndex: 0,
    isPaused: false,
    completed: false,
  };
}

function saveSession() {
  if (!state.session) return;
  const snap = { ...state.session, savedAt: Date.now() };
  if (state.running && !state.paused) snap.elapsedMs = getElapsedMs();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || s.completed) return null;
    return s;
  } catch { return null; }
}

function clearSession() { localStorage.removeItem(STORAGE_KEY); }

function getElapsedMs() {
  if (!state.session) return 0;
  if (state.paused) return state.session.elapsedMs;
  return Math.max(0, state.session.elapsedMs + (Date.now() - state.session.startedAt));
}

function currentBpmFromElapsed(elapsed) {
  const s = state.session;
  let bpm = s.startBpm;
  let index = 0;
  while (index < s.schedule.length && elapsed >= s.schedule[index].atMs) {
    bpm = s.schedule[index].bpm;
    index++;
  }
  s.currentBpm = bpm;
  s.scheduleIndex = index;
  return bpm;
}

async function ensureAudio() {
  if (!state.audio) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    state.audio = new AudioCtx();
    state.masterGain = state.audio.createGain();
    state.masterGain.connect(state.audio.destination);
  }
  if (state.audio.state === 'suspended') await state.audio.resume();
}

function setMasterVolume(value) {
  if (!state.masterGain) return;
  // 메트로놈은 짧은 트랜지언트라 일반 음원보다 작게 느껴질 수 있어
  // UI 볼륨 값에 여유 게인을 더해 최대 볼륨을 확실히 키운다.
  const boosted = clamp(Number(value || 0) * 2.15, 0, 2.75);
  state.masterGain.gain.value = boosted;
}

function clickAt(time, accented, soundType = 'classic', intensity = 1) {
  const ctx = state.audio;
  const output = ctx.createGain();
  output.connect(state.masterGain);

  const level = (accented ? 1.24 : 1.08) * intensity;

  if (soundType === 'wood') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(accented ? 980 : 720, time);
    osc.frequency.exponentialRampToValueAtTime(accented ? 560 : 420, time + 0.045);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.30 * level, time + 0.0015);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.075);
    osc.connect(gain);
    gain.connect(output);
    osc.start(time);
    osc.stop(time + 0.085);
    return;
  }

  if (soundType === 'soft') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(accented ? 1120 : 820, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.19 * level, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.085);
    osc.connect(gain);
    gain.connect(output);
    osc.start(time);
    osc.stop(time + 0.095);
    return;
  }

  if (soundType === 'digital') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(accented ? 1900 : 1320, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.145 * level, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.025);
    osc.connect(gain);
    gain.connect(output);
    osc.start(time);
    osc.stop(time + 0.032);
    return;
  }

  // Classic Click
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(accented ? 1450 : 980, time);
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime((accented ? 0.32 : 0.22) * level, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  osc.connect(gain);
  gain.connect(output);
  osc.start(time);
  osc.stop(time + 0.06);
}

function subdivisionPattern(type) {
  if (type === 'eighth') return [0.5, 0.5];
  if (type === 'shuffle') return [2 / 3, 1 / 3];
  if (type === 'sixteenth') return [0.25, 0.25, 0.25, 0.25];
  return [1];
}

function scheduler() {
  if (!state.running || state.paused || !state.audio || !state.session) return;
  const lookahead = 0.12;
  while (state.nextNoteTime < state.audio.currentTime + lookahead) {
    const elapsed = getElapsedMs();
    const bpm = currentBpmFromElapsed(elapsed);
    const pattern = subdivisionPattern(state.session.subdivision || 'quarter');
    const isDownbeatPulse = state.subdivisionIndex === 0;
    const accented = state.session.accent && state.beatIndex === 0 && isDownbeatPulse;
    const intensity = isDownbeatPulse ? 1 : 0.72;

    clickAt(state.nextNoteTime, accented, state.session.clickSound || 'classic', intensity);

    const secPerBeat = 60 / bpm;
    state.nextNoteTime += secPerBeat * pattern[state.subdivisionIndex];
    state.subdivisionIndex++;

    if (state.subdivisionIndex >= pattern.length) {
      state.subdivisionIndex = 0;
      state.beatIndex = (state.beatIndex + 1) % state.session.timeSignature;
    }
  }
}

function startScheduler() {
  clearInterval(state.schedulerTimer);
  state.schedulerTimer = setInterval(scheduler, 25);
}

function stopScheduler() {
  clearInterval(state.schedulerTimer);
  state.schedulerTimer = null;
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}
function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch {}
  state.wakeLock = null;
}

function updateUI() {
  if (!state.session) return;
  const elapsed = getElapsedMs();
  const remaining = Math.max(0, state.session.durationMs - elapsed);
  const progress = clamp(elapsed / state.session.durationMs, 0, 1);
  const targetReached = elapsed >= state.session.durationMs;
  $('elapsedText').textContent = formatTime(elapsed);
  $('remainingText').textContent = targetReached ? '00:00:00' : formatTime(remaining);
  $('progressPercent').textContent = `${Math.floor(progress * 100)}%`;
  $('orbitProgress').style.strokeDasharray = `${CIRC}`;
  $('orbitProgress').style.strokeDashoffset = `${CIRC * (1 - progress)}`;
  currentBpmFromElapsed(elapsed);

  // 타겟 BPM에 도달해도 세션을 종료하지 않는다.
  // 사용자가 직접 종료할 때까지 목표 BPM을 유지하며 계속 연습한다.
  if (targetReached) {
    state.session.currentBpm = state.session.targetBpm;
    state.session.scheduleIndex = state.session.schedule.length;
    $('sessionStateLabel').textContent = state.paused ? '일시정지' : '연습 진행 중';
    $('targetReachedNotice').classList.remove('hidden');
    $('statusChip').textContent = state.paused ? 'PAUSED' : 'TARGET';
  } else if (!state.paused) {
    $('sessionStateLabel').textContent = '연습 진행 중';
  if ($('targetReachedNotice')) $('targetReachedNotice').classList.add('hidden');
    $('targetReachedNotice').classList.add('hidden');
    $('statusChip').textContent = 'LIVE';
  }

  // 일반 세션 + 저장된 곡의 체크포인트를 약 5초마다 자동 저장한다.
  // 종료 버튼을 누르지 않아도 마지막 연습 지점을 최대한 보존한다.
  const now = Date.now();
  if (now - state.lastAutosaveAt >= 5000) {
    state.lastAutosaveAt = now;
    saveSession();
    savePresetCheckpoint(state.session, elapsed, false);
  }
}

function startUITimer() {
  clearInterval(state.uiTimer);
  state.uiTimer = setInterval(updateUI, 250);
}

async function beginSession(session, isResume = false) {
  state.session = session;
  state.running = true;
  state.paused = !!session.isPaused;
  state.lastAutosaveAt = 0;

  if (isResume) {
    state.session.elapsedMs = Number(session.elapsedMs || 0);
    state.session.startedAt = Date.now();
    state.paused = false;
    state.session.isPaused = false;
  } else {
    state.session.startedAt = Date.now();
  }

  $('setupView').classList.add('hidden');
  $('completeView').classList.add('hidden');
  $('sessionView').classList.remove('hidden');
  $('sessionVolume').value = state.session.volume ?? 0.72;
  $('sessionClickSound').value = state.session.clickSound || 'classic';
  $('sessionSubdivision').value = state.session.subdivision || 'quarter';
  $('pauseBtn').textContent = '일시정지';
  $('sessionStateLabel').textContent = '연습 진행 중';
  $('statusChip').textContent = 'LIVE';

  await ensureAudio();
  setMasterVolume(state.session.volume ?? 0.72);
  state.nextNoteTime = state.audio.currentTime + 0.08;
  state.beatIndex = 0;
  state.subdivisionIndex = 0;
  startScheduler();
  startUITimer();
  requestWakeLock();
  updateUI();
  saveSession();
  savePresetCheckpoint(state.session, getElapsedMs(), false);
}

function pauseSession() {
  if (!state.session || state.paused) return;
  state.session.elapsedMs = getElapsedMs();
  state.session.isPaused = true;
  state.paused = true;
  $('pauseBtn').textContent = '재개';
  $('sessionStateLabel').textContent = '일시정지';
  $('statusChip').textContent = 'PAUSED';
  stopScheduler();
  releaseWakeLock();
  saveSession();
  savePresetCheckpoint(state.session, state.session.elapsedMs, true);
}

async function resumeSession() {
  if (!state.session || !state.paused) return;
  state.session.startedAt = Date.now();
  state.session.isPaused = false;
  state.paused = false;
  $('pauseBtn').textContent = '일시정지';
  $('sessionStateLabel').textContent = '연습 진행 중';
  $('statusChip').textContent = 'LIVE';
  await ensureAudio();
  state.nextNoteTime = state.audio.currentTime + 0.08;
  state.beatIndex = 0;
  state.subdivisionIndex = 0;
  startScheduler();
  requestWakeLock();
  saveSession();
}

function completeSession() {
  if (!state.session || state.session.completed) return;
  state.session.completed = true;
  state.running = false;
  state.paused = false;
  stopScheduler();
  clearInterval(state.uiTimer);
  releaseWakeLock();
  clearSession();
  savePresetCheckpoint(state.session, state.session.durationMs);
  $('sessionView').classList.add('hidden');
  $('completeView').classList.remove('hidden');
  $('revealBox').classList.add('hidden');
  $('revealBox').textContent = '';
}

function backToSetup() {
  if (!state.session) return;
  if (!state.paused) pauseSession();
  state.running = false;
  stopScheduler();
  clearInterval(state.uiTimer);
  releaseWakeLock();
  saveSession();
  savePresetCheckpoint(state.session, state.session.elapsedMs, true);
  $('sessionView').classList.add('hidden');
  $('completeView').classList.add('hidden');
  $('setupView').classList.remove('hidden');
  $('resumeBtn').classList.remove('hidden');
}

function endSession() {
  if (state.session) {
    const elapsed = state.paused ? state.session.elapsedMs : getElapsedMs();
    savePresetCheckpoint(state.session, elapsed);
  }
  state.running = false;
  state.paused = false;
  stopScheduler();
  clearInterval(state.uiTimer);
  releaseWakeLock();
  clearSession();
  state.session = null;
  $('sessionView').classList.add('hidden');
  $('completeView').classList.add('hidden');
  $('setupView').classList.remove('hidden');
  $('resumeBtn').classList.add('hidden');
}

$('startBtn').addEventListener('click', async () => {
  if (!validateInputs()) return;
  if (state.pendingPresetCheckpoint) {
    const checkpoint = JSON.parse(JSON.stringify(state.pendingPresetCheckpoint));
    checkpoint.presetId = state.selectedPresetId;
    checkpoint.songName = $('songName').value.trim();
    await beginSession(checkpoint, true);
    state.pendingPresetCheckpoint = null;
    $('startBtn').textContent = '연습 시작';
    return;
  }
  await beginSession(createSession(), false);
});

$('pauseBtn').addEventListener('click', () => state.paused ? resumeSession() : pauseSession());
$('backBtn').addEventListener('click', backToSetup);
$('endBtn').addEventListener('click', endSession);
$('newSessionBtn').addEventListener('click', endSession);
$('revealBtn').addEventListener('click', () => {
  if (!state.session) return;
  $('revealBox').classList.remove('hidden');
  $('revealBox').textContent = `Target ${state.session.targetBpm} BPM`;
});

$('clickSound').addEventListener('change', () => {
  $('sessionClickSound').value = $('clickSound').value;
});

$('sessionClickSound').addEventListener('change', () => {
  const sound = $('sessionClickSound').value;
  $('clickSound').value = sound;
  if (state.session) state.session.clickSound = sound;
  saveSession();
});

$('subdivision').addEventListener('change', () => {
  $('sessionSubdivision').value = $('subdivision').value;
});

$('sessionSubdivision').addEventListener('change', () => {
  const subdivision = $('sessionSubdivision').value;
  $('subdivision').value = subdivision;
  if (state.session) state.session.subdivision = subdivision;
  state.subdivisionIndex = 0;
  state.beatIndex = 0;
  saveSession();
});

$('volume').addEventListener('input', () => {
  $('sessionVolume').value = $('volume').value;
  setMasterVolume(Number($('volume').value));
});
$('sessionVolume').addEventListener('input', () => {
  const v = Number($('sessionVolume').value);
  if (state.session) state.session.volume = v;
  $('volume').value = v;
  setMasterVolume(v);
  saveSession();
});

$('soundPreviewBtn').addEventListener('click', async () => {
  await ensureAudio();
  setMasterVolume(Number($('volume').value));
  clickAt(state.audio.currentTime + 0.03, true, $('clickSound').value);
});

$('resumeBtn').addEventListener('click', async () => {
  const s = loadSession();
  if (!s) return;
  await beginSession(s, true);
});

['startBpm','targetBpm','hours','minutes'].forEach(id => $(id).addEventListener('input', () => { validateInputs(); markPresetSettingsEdited(); }));
['timeSignature','accentToggle','clickSound','subdivision','volume'].forEach(id => {
  const el = $(id);
  el.addEventListener(el.type === 'range' ? 'input' : 'change', markPresetSettingsEdited);
});



function savePresetCheckpoint(session, elapsedMs, shouldRender = true) {
  if (!session?.presetId) return;
  const presets = getPresets();
  const index = presets.findIndex(p => p.id === session.presetId);
  if (index < 0) return;

  const safeElapsed = Math.max(0, Number(elapsedMs || 0));
  presets[index].checkpoint = {
    ...session,
    elapsedMs: safeElapsed,
    startedAt: Date.now(),
    pausedAt: null,
    isPaused: true,
    completed: false,
    savedAt: Date.now(),
  };
  presets[index].progressMs = safeElapsed;
  presets[index].durationMs = session.durationMs;
  savePresets(presets);
  if (shouldRender) renderPresets();
}

function clearPresetSelection() {
  state.selectedPresetId = null;
  state.pendingPresetCheckpoint = null;
  $('startBtn').textContent = '연습 시작';
}

function markPresetSettingsEdited() {
  if (!state.selectedPresetId) return;
  state.pendingPresetCheckpoint = null;
  $('startBtn').textContent = '연습 시작';
}

function getPresets() {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function savePresets(list) {
  localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(list));
}

function currentSettingsAsPreset(name) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    startBpm: Number($('startBpm').value),
    targetBpm: Number($('targetBpm').value),
    hours: Number($('hours').value),
    minutes: Number($('minutes').value),
    timeSignature: $('timeSignature').value,
    accent: $('accentToggle').checked,
    clickSound: $('clickSound').value,
    subdivision: $('subdivision').value,
    volume: Number($('volume').value),
    savedAt: Date.now(),
  };
}

function loadPreset(preset) {
  state.selectedPresetId = preset.id;
  state.pendingPresetCheckpoint = preset.checkpoint || null;
  $('songName').value = preset.name || '';
  $('startBpm').value = preset.startBpm ?? 80;
  $('targetBpm').value = preset.targetBpm ?? 130;
  $('hours').value = preset.hours ?? 2;
  $('minutes').value = preset.minutes ?? 0;
  $('timeSignature').value = preset.timeSignature || '4';
  $('accentToggle').checked = preset.accent !== false;
  $('clickSound').value = preset.clickSound || 'classic';
  $('sessionClickSound').value = preset.clickSound || 'classic';
  $('subdivision').value = preset.subdivision || 'quarter';
  $('sessionSubdivision').value = preset.subdivision || 'quarter';
  $('volume').value = preset.volume ?? 0.72;
  $('sessionVolume').value = preset.volume ?? 0.72;
  validateInputs();
  $('startBtn').textContent = state.pendingPresetCheckpoint ? '저장 지점부터 시작' : '연습 시작';
}

function renderPresets() {
  const root = $('presetList');
  const presets = getPresets();
  root.innerHTML = '';
  if (!presets.length) {
    root.classList.add('hidden');
    return;
  }
  root.classList.remove('hidden');

  presets.forEach((preset) => {
    const row = document.createElement('div');
    row.className = 'preset-item';

    const info = document.createElement('button');
    info.className = 'preset-load';
    info.type = 'button';
    const title = document.createElement('strong');
    title.textContent = preset.name;
    const meta = document.createElement('span');
    const totalMin = (Number(preset.hours || 0) * 60) + Number(preset.minutes || 0);
    const timeText = totalMin >= 60
      ? `${Math.floor(totalMin / 60)}시간 ${totalMin % 60 ? `${totalMin % 60}분` : ''}`.trim()
      : `${totalMin}분`;
    const progressMs = clamp(Number(preset.progressMs || 0), 0, Math.max(1, Number(preset.durationMs || totalMin * 60 * 1000)));
    const durationMs = Math.max(1, Number(preset.durationMs || totalMin * 60 * 1000));
    const percent = Math.floor((progressMs / durationMs) * 100);
    meta.textContent = progressMs > 0
      ? `${formatTime(progressMs)} / ${formatTime(durationMs)} · ${percent}%`
      : `${timeText} · 0%`;
    info.append(title, meta);
    info.addEventListener('click', async () => {
      // 저장된 곡은 클릭 한 번으로 바로 연습을 시작한다.
      // 종료 체크포인트가 있으면 그 지점과 기존 랜덤 BPM 스케줄을 그대로 복원한다.
      loadPreset(preset);
      if (!validateInputs()) return;

      if (state.pendingPresetCheckpoint) {
        const checkpoint = JSON.parse(JSON.stringify(state.pendingPresetCheckpoint));
        checkpoint.presetId = state.selectedPresetId;
        checkpoint.songName = preset.name || '';
        state.pendingPresetCheckpoint = null;
        $('startBtn').textContent = '연습 시작';
        await beginSession(checkpoint, true);
        return;
      }

      // 아직 종료 지점이 없는 새 프리셋은 처음부터 즉시 시작한다.
      await beginSession(createSession(), false);
    });

    const del = document.createElement('button');
    del.className = 'preset-delete';
    del.type = 'button';
    del.setAttribute('aria-label', `${preset.name} 삭제`);
    del.textContent = '×';
    del.addEventListener('click', () => {
      savePresets(getPresets().filter(p => p.id !== preset.id));
      if (state.selectedPresetId === preset.id) clearPresetSelection();
      renderPresets();
    });

    row.append(info, del);
    root.append(row);
  });
}

$('savePresetBtn').addEventListener('click', () => {
  const name = $('songName').value.trim();
  if (!name) {
    $('validationMsg').textContent = '곡 이름을 입력한 뒤 저장해주세요.';
    $('songName').focus();
    return;
  }
  if (!validateInputs()) return;

  const presets = getPresets();
  const existingIndex = presets.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
  const preset = currentSettingsAsPreset(name);
  if (existingIndex >= 0) {
    const oldPreset = presets[existingIndex];
    preset.id = oldPreset.id;
    const sameCoreSettings =
      Number(oldPreset.startBpm) === Number(preset.startBpm) &&
      Number(oldPreset.targetBpm) === Number(preset.targetBpm) &&
      Number(oldPreset.hours) === Number(preset.hours) &&
      Number(oldPreset.minutes) === Number(preset.minutes) &&
      String(oldPreset.timeSignature) === String(preset.timeSignature);
    if (sameCoreSettings) {
      preset.checkpoint = oldPreset.checkpoint || null;
      preset.progressMs = Number(oldPreset.progressMs || 0);
      preset.durationMs = Number(oldPreset.durationMs || ((preset.hours * 60 + preset.minutes) * 60 * 1000));
    }
    presets[existingIndex] = preset;
    state.selectedPresetId = preset.id;
    state.pendingPresetCheckpoint = preset.checkpoint || null;
  } else {
    preset.progressMs = 0;
    preset.durationMs = (preset.hours * 60 + preset.minutes) * 60 * 1000;
    preset.checkpoint = null;
    state.selectedPresetId = preset.id;
    presets.unshift(preset);
  }
  savePresets(presets.slice(0, 30));
  renderPresets();
  $('startBtn').textContent = state.pendingPresetCheckpoint ? '저장 지점부터 시작' : '연습 시작';
  $('validationMsg').textContent = '곡 설정을 저장했습니다.';
  setTimeout(() => {
    if ($('validationMsg').textContent === '곡 설정을 저장했습니다.') validateInputs();
  }, 1400);
});

window.addEventListener('beforeunload', () => {
  if (state.session && state.running) {
    if (!state.paused) state.session.elapsedMs = getElapsedMs();
    state.session.isPaused = true;
    saveSession();
    savePresetCheckpoint(state.session, state.session.elapsedMs, false);
  }
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.running && !state.paused) {
    requestWakeLock();
    if (state.audio?.state === 'suspended') await state.audio.resume();
  }
});

function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  $('themeToggle').checked = isDark;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark ? '#111318' : '#ffffff');
}

function initTheme() {
  // 새 버전의 첫 실행은 OS 설정과 무관하게 항상 화이트 모드로 시작한다.
  // 사용자가 토글한 이후부터는 선택한 테마를 기억한다.
  let savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  if (savedTheme !== 'dark' && savedTheme !== 'light') savedTheme = 'light';
  applyTheme(savedTheme);
  $('themeToggle').addEventListener('change', () => {
    const theme = $('themeToggle').checked ? 'dark' : 'light';
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    applyTheme(theme);
  });
}

(function init() {
  initTheme();
  $('orbitProgress').style.strokeDasharray = `${CIRC}`;
  $('orbitProgress').style.strokeDashoffset = `${CIRC}`;
  validateInputs();
  renderPresets();
  const saved = loadSession();
  if (saved) $('resumeBtn').classList.remove('hidden');
})();
