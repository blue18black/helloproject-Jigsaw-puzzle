// リリースデータの読み込みと、ゲーム設定の定義

export const PIECE_PRESETS = [12, 24, 48, 70, 100, 150, 200, 300];

export const DIFFICULTIES = [
  { id: "easy", label: "かんたん", desc: "ボードに見本がうっすら表示", ghost: true, rotate: false },
  { id: "normal", label: "ふつう", desc: "見本なし", ghost: false, rotate: false },
  { id: "hard", label: "むずかしい", desc: "見本なし＋ピースが回転（タップで90°回転）", ghost: false, rotate: true },
];
export const difficultyById = (id) => DIFFICULTIES.find((d) => d.id === id) ?? DIFFICULTIES[1];

export const OTHER_GROUP = "other";

/** 目標ピース数と画像の縦横比から、ピースがなるべく正方形になる列×行を決める */
export function gridFor(target, aspect) {
  const cols = Math.max(2, Math.round(Math.sqrt(target * aspect)));
  const rows = Math.max(2, Math.round(target / cols));
  return { cols, rows, count: cols * rows };
}

export async function loadData() {
  const res = await fetch("data/releases.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`データを読み込めませんでした (HTTP ${res.status})`);
  const data = await res.json();
  data.byId = new Map(data.releases.map((r) => [r.id, r]));
  return data;
}

export function formatDate(iso) {
  return iso ? iso.replaceAll("-", ".") : "";
}

export function formatTime(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
