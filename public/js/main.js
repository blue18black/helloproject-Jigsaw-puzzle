// 画面の切り替え（URL の # でホーム／ゲームを切り替えるので、ブラウザの戻るボタンも使える）
//   #/                         ホーム
//   #/play/{releaseId}/{ピース数}/{easy|normal|hard}   ゲーム

import { loadData, PIECE_PRESETS, DIFFICULTIES } from "./data.js";
import { createHome } from "./home.js";
import { createGame } from "./game.js";

const $ = (id) => document.getElementById(id);

let data;
try {
  data = await loadData();
} catch (err) {
  $("home-status").textContent = `データを読み込めませんでした: ${err.message}`;
  throw err;
}

let pendingFresh = false;
let homeScroll = 0;

const playHash = (r, pieces, diff) => `#/play/${r.id}/${pieces}/${diff}`;

const home = createHome(data, {
  onStart(release, pieces, diff, fresh) {
    pendingFresh = fresh;
    location.hash = playHash(release, pieces, diff);
  },
});

const game = createGame({
  onExit: () => (location.hash = "#/"),
  onChangeSettings(release) {
    location.hash = "#/";
    home.openSetup(release);
  },
});

function showHome() {
  game.stop();
  if (!$("home").hidden) return;
  $("game").hidden = true;
  $("home").hidden = false;
  document.body.classList.remove("in-game");
  document.title = "ハロプロ ジャケ写パズル";
  window.scrollTo(0, homeScroll);
  home.refresh();
}

function route() {
  const m = location.hash.match(/^#\/play\/(\d+)\/(\d+)\/(\w+)/);
  const release = m && data.byId.get(Number(m[1]));
  const pieces = m && Number(m[2]);
  if (!release || !PIECE_PRESETS.includes(pieces) || !DIFFICULTIES.some((d) => d.id === m[3])) {
    showHome();
    return;
  }
  if ($("game").hidden) homeScroll = window.scrollY;
  $("home").hidden = true;
  $("game").hidden = false;
  document.body.classList.add("in-game");
  document.title = `${release.title} - ハロプロ ジャケ写パズル`;
  const fresh = pendingFresh;
  pendingFresh = false;
  game.start(release, pieces, m[3], fresh);
}

window.addEventListener("hashchange", route);
route();
