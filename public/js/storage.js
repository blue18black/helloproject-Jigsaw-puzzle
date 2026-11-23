// localStorage まわり（自己ベスト・途中保存・設定）。
// プライベートブラウズ等で使えない場合も落ちないよう、すべて try/catch で包む。

const PREFIX = "hpjig:";
const MAX_SAVES = 12;

function read(key, fallback = null) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* 容量オーバー等は無視 */
  }
}

export const configKey = (releaseId, pieces, diff) => `${releaseId}:${pieces}:${diff}`;

export const getSetting = (name, fallback) => read(`set:${name}`, fallback);
export const setSetting = (name, value) => write(`set:${name}`, value);

export const getBest = (key) => read(`best:${key}`);

/** @returns {boolean} 自己ベスト更新なら true */
export function recordBest(key, ms) {
  const prev = getBest(key);
  if (prev == null || ms < prev) {
    write(`best:${key}`, ms);
    return true;
  }
  return false;
}

export const loadSave = (key) => read(`save:${key}`);

export function storeSave(key, data) {
  write(`save:${key}`, data);
  const index = read("saves", []).filter((k) => k !== key);
  index.unshift(key);
  for (const old of index.splice(MAX_SAVES)) write(`save:${old}`, null);
  write("saves", index);
}

export function clearSave(key) {
  write(`save:${key}`, null);
  write("saves", read("saves", []).filter((k) => k !== key));
}
