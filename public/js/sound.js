// 効果音（音声ファイルを使わず WebAudio で合成）

let ctx = null;
let enabled = true;

export function setSoundEnabled(on) {
  enabled = on;
}

/** ブラウザの自動再生制限があるので、ユーザー操作のタイミングで呼んで AudioContext を起こす */
export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume();
}

function tone(freq, start, dur, { type = "sine", gain = 0.18 } = {}) {
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export function playSnap(kind) {
  if (!enabled || !ctx) return;
  if (kind === "board") {
    tone(520, 0, 0.12, { type: "triangle", gain: 0.22 });
    tone(780, 0.05, 0.14, { type: "sine", gain: 0.12 });
  } else {
    tone(880, 0, 0.07, { type: "triangle", gain: 0.2 });
  }
}

export function playComplete() {
  if (!enabled || !ctx) return;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.11, 0.5, { type: "triangle", gain: 0.16 }));
  tone(1318.5, 0.5, 0.9, { type: "sine", gain: 0.1 });
}
