// ゲーム画面とリザルト画面

import { PuzzleEngine } from "./puzzle/engine.js";
import { gridFor, difficultyById, formatTime } from "./data.js";
import { configKey, loadSave, storeSave, clearSave, getBest, recordBest, getSetting, setSetting } from "./storage.js";
import { unlockAudio, playSnap, playComplete, setSoundEnabled } from "./sound.js";

const $ = (id) => document.getElementById(id);

const BACKGROUNDS = [
  { color: "#2b2e35", light: false },
  { color: "#4b3a2e", light: false },
  { color: "#21443a", light: false },
  { color: "#35294a", light: false },
  { color: "#e8e4db", light: true },
];

export function createGame({ onExit, onChangeSettings }) {
  let engine = null;
  let session = null; // { release, pieces, diff, key, seed }
  let elapsed = 0;
  let lastTick = 0;
  let timer = 0;
  let saveTimer = 0;
  let dirty = false;
  let paused = false;
  let finished = false;
  let loadToken = 0;
  let bgIndex = clampIndex(getSetting("bg", 0));
  let sound = getSetting("sound", true);
  setSoundEnabled(sound);

  function clampIndex(i) {
    return Number.isInteger(i) && i >= 0 && i < BACKGROUNDS.length ? i : 0;
  }

  // ------------------------------------------------------------ 時間・保存

  function running() {
    return engine && !paused && !finished && document.visibilityState === "visible";
  }

  function tick() {
    const now = performance.now();
    if (running()) elapsed += now - lastTick;
    lastTick = now;
    $("g-timer").textContent = formatTime(elapsed);
  }

  function save() {
    if (!engine || finished || !session) return;
    storeSave(session.key, {
      ...engine.serialize(),
      elapsed: Math.round(elapsed),
      percent: engine.progress().percent,
      savedAt: Date.now(),
    });
    dirty = false;
  }

  function onVisibility() {
    tick();
    if (document.visibilityState === "hidden") save();
  }

  // ------------------------------------------------------------ 開始・終了

  async function start(release, pieces, diff, fresh = false) {
    stop();
    const token = ++loadToken;
    const d = difficultyById(diff);
    const key = configKey(release.id, pieces, diff);
    if (fresh) clearSave(key);
    const saved = loadSave(key);

    finished = false;
    paused = false;
    $("result").hidden = true;
    $("r-back").hidden = true;
    $("g-paused").hidden = true;
    $("g-error").hidden = true;
    $("g-loading").hidden = false;
    $("g-preview-panel").hidden = true;
    $("g-edges").classList.remove("is-on");
    $("g-preview").classList.remove("is-on");
    $("g-title").textContent = release.title;
    $("g-progress").textContent = "0%";
    $("g-timer").textContent = "0:00";
    updateSoundButton();

    let img;
    try {
      img = await loadImage(release.image);
    } catch {
      if (token !== loadToken) return;
      $("g-loading").hidden = true;
      $("g-error-msg").textContent = "ジャケ写を読み込めませんでした。時間をおいて試してください。";
      $("g-error").hidden = false;
      return;
    }
    if (token !== loadToken) return;

    const grid = gridFor(pieces, img.naturalWidth / img.naturalHeight);
    const seed = saved?.seed ?? Math.floor(Math.random() * 2 ** 31);
    session = { release, pieces, diff, key, seed, grid, d };
    $("g-sub").textContent = `${grid.count}ピース ・ ${d.label}`;
    $("g-preview-img").src = img.src;

    engine = new PuzzleEngine($("board"), {
      image: img,
      cols: grid.cols,
      rows: grid.rows,
      rotate: d.rotate,
      ghost: d.ghost,
      seed,
      state: saved,
      topInset: $("board").getBoundingClientRect().top < 1 ? document.querySelector(".game-bar").offsetHeight : 0,
      onChange: (p) => {
        $("g-progress").textContent = `${p.percent}%`;
        dirty = true;
      },
      onSnap: (kind) => playSnap(kind),
      onInteract: () => {
        unlockAudio();
        dirty = true;
      },
      onComplete: complete,
    });
    applyBackground();
    if (new URLSearchParams(location.search).has("debug")) window.__engine = engine;

    elapsed = saved?.elapsed ?? 0;
    lastTick = performance.now();
    timer = setInterval(tick, 250);
    saveTimer = setInterval(() => dirty && save(), 4000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", save);
    $("g-loading").hidden = true;
    showHint(saved ? "前回の続きから再開しました" : hintText(d));
  }

  function stop() {
    loadToken++;
    if (!engine) return;
    tick();
    save();
    clearInterval(timer);
    clearInterval(saveTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", save);
    engine.destroy();
    engine = null;
    stopConfetti();
  }

  function complete() {
    if (finished) return;
    tick();
    finished = true;
    clearSave(session.key);
    const isBest = recordBest(session.key, elapsed);
    playComplete();

    const { release, grid, d } = session;
    $("r-img").src = release.image;
    $("r-img").referrerPolicy = "no-referrer";
    $("r-title").textContent = release.title;
    $("r-time").textContent = formatTime(elapsed);
    $("r-pieces").textContent = `${grid.count}`;
    $("r-diff").textContent = d.label;
    const best = getBest(session.key);
    $("r-best").textContent = isBest ? "🏆 自己ベスト更新！" : best != null ? `自己ベスト ${formatTime(best)}` : "";
    $("r-best").classList.toggle("is-new", isBest);
    $("result").hidden = false;
    startConfetti();
  }

  // ------------------------------------------------------------ ツールバー

  function hintText(d) {
    const touch = matchMedia("(pointer: coarse)").matches;
    const base = touch
      ? "空いている所をなぞって範囲選択 ・ 2本指で画面移動／ズーム"
      : "空いている所をドラッグで範囲選択 ・ 右ドラッグで画面移動 ・ ホイールでズーム";
    return d.rotate ? base + (touch ? " ・ タップで回転" : " ・ クリックで回転") : base;
  }

  let hintTimer = 0;
  function showHint(text) {
    const h = $("g-hint");
    h.textContent = text;
    h.classList.add("is-visible");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => h.classList.remove("is-visible"), 5000);
  }

  function applyBackground() {
    const bg = BACKGROUNDS[bgIndex];
    engine?.setBackground(bg.color, bg.light);
    $("game").classList.toggle("game--light", bg.light);
  }

  function updateSoundButton() {
    $("g-sound").classList.toggle("is-off", !sound);
    $("g-sound").title = sound ? "効果音: オン" : "効果音: オフ";
  }

  function setPaused(p) {
    if (!engine || finished) return;
    tick();
    paused = p;
    engine.setPaused(p);
    $("g-paused").hidden = !p;
    if (p) save();
  }

  function togglePreview() {
    const panel = $("g-preview-panel");
    panel.hidden = !panel.hidden;
    $("g-preview").classList.toggle("is-on", !panel.hidden);
  }

  function toggleEdges() {
    if (!engine) return;
    const on = !$("g-edges").classList.contains("is-on");
    $("g-edges").classList.toggle("is-on", on);
    engine.setEdgesOnly(on);
    showHint(on ? "端のピースだけを表示中" : "すべてのピースを表示中");
  }

  $("g-home").addEventListener("click", () => onExit());
  $("g-preview").addEventListener("click", togglePreview);
  $("g-preview-panel").addEventListener("click", togglePreview);
  $("g-edges").addEventListener("click", toggleEdges);
  $("g-scatter").addEventListener("click", () => {
    engine?.scatterLoose();
    dirty = true;
  });
  $("g-fit").addEventListener("click", () => engine?.fit());
  $("g-bg").addEventListener("click", () => {
    bgIndex = (bgIndex + 1) % BACKGROUNDS.length;
    setSetting("bg", bgIndex);
    applyBackground();
  });
  $("g-sound").addEventListener("click", () => {
    sound = !sound;
    setSoundEnabled(sound);
    setSetting("sound", sound);
    if (sound) unlockAudio();
    updateSoundButton();
  });
  $("g-full").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  $("g-pause").addEventListener("click", () => setPaused(true));
  $("g-resume").addEventListener("click", () => setPaused(false));
  $("g-error-home").addEventListener("click", () => onExit());

  $("r-retry").addEventListener("click", () => {
    const s = session;
    start(s.release, s.pieces, s.diff, true);
  });
  $("r-change").addEventListener("click", () => onChangeSettings(session.release));
  $("r-home").addEventListener("click", () => onExit());
  $("r-view").addEventListener("click", () => {
    $("result").hidden = true;
    $("r-back").hidden = false;
    stopConfetti();
  });
  $("r-back").addEventListener("click", () => {
    $("result").hidden = false;
    $("r-back").hidden = true;
  });

  document.addEventListener("keydown", (e) => {
    if (!engine || $("game").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (k === "escape") {
      if (!$("g-preview-panel").hidden) togglePreview();
      else if (paused) setPaused(false);
      else engine.clearSelection();
      return;
    }
    if (finished || paused) return;
    if (k === "p") togglePreview();
    else if (k === "e") toggleEdges();
    else if (k === "f") engine.fit();
    else if (k === "+" || k === ";" || k === "=") engine.zoomBy(1.25);
    else if (k === "-") engine.zoomBy(0.8);
    else if (k === " ") { e.preventDefault(); setPaused(true); }
  });

  return { start, stop };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    img.onload = () => (img.naturalWidth ? resolve(img) : reject(new Error("empty image")));
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

// ------------------------------------------------------------ 紙吹雪

let confettiRaf = 0;
function startConfetti() {
  const c = $("confetti");
  c.hidden = false;
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  const ctx = c.getContext("2d");
  const colors = ["#ff5c8a", "#ffd166", "#06d6a0", "#4cc9f0", "#b388ff", "#ffffff"];
  const parts = Array.from({ length: 160 }, () => ({
    x: Math.random() * c.width,
    y: -Math.random() * c.height * 0.6,
    vx: (Math.random() - 0.5) * 2 * dpr,
    vy: (2 + Math.random() * 3) * dpr,
    w: (6 + Math.random() * 6) * dpr,
    h: (3 + Math.random() * 4) * dpr,
    a: Math.random() * Math.PI,
    va: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  cancelAnimationFrame(confettiRaf);
  const frame = (now) => {
    ctx.clearRect(0, 0, c.width, c.height);
    const fade = Math.min(1, Math.max(0, 1 - (now - t0 - 3500) / 1500));
    ctx.globalAlpha = fade;
    for (const p of parts) {
      p.x += p.vx + Math.sin((now / 400) + p.a) * 0.6 * dpr;
      p.y += p.vy;
      p.a += p.va;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.a)));
      ctx.restore();
    }
    if (fade > 0) confettiRaf = requestAnimationFrame(frame);
    else stopConfetti();
  };
  confettiRaf = requestAnimationFrame(frame);
}

function stopConfetti() {
  cancelAnimationFrame(confettiRaf);
  const c = $("confetti");
  c.hidden = true;
  c.getContext("2d").clearRect(0, 0, c.width, c.height);
}
