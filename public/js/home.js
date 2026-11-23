// ホーム画面：グループ → ジャンル → ジャケ写を選び、設定パネルでピース数・難易度を決める

import { PIECE_PRESETS, DIFFICULTIES, OTHER_GROUP, gridFor, formatDate, formatTime } from "./data.js";
import { configKey, getBest, loadSave, getSetting, setSetting } from "./storage.js";

const PAGE = 48;
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) if (c != null) e.append(c);
  return e;
}

export function createHome(data, { onStart }) {
  const today = new Date().toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

  const state = {
    group: getSetting("group", String(data.groups[0]?.id ?? OTHER_GROUP)),
    category: "",
    artist: "",
    query: "",
  };
  if (state.group !== OTHER_GROUP && !data.groups.some((g) => String(g.id) === state.group)) {
    state.group = String(data.groups[0]?.id ?? OTHER_GROUP);
  }

  let filtered = [];
  let shown = 0;

  // ------------------------------------------------------------ 絞り込み

  function inGroup(r, group) {
    return group === OTHER_GROUP ? r.groups.length === 0 : r.groups.includes(Number(group));
  }

  function groupItems() {
    return data.releases.filter((r) => inGroup(r, state.group));
  }

  function applyFilters() {
    const q = state.query.trim().toLowerCase();
    filtered = groupItems().filter(
      (r) =>
        (!state.category || r.category === state.category) &&
        (!state.artist || r.artist === state.artist) &&
        (!q || r.title.toLowerCase().includes(q) || r.artist.toLowerCase().includes(q)),
    );
  }

  // ------------------------------------------------------------ 描画

  function renderGroupTabs() {
    const tabs = [
      ...data.groups.map((g) => ({ key: String(g.id), label: g.name })),
      { key: OTHER_GROUP, label: "OG・ユニット・その他" },
    ];
    $("group-tabs").replaceChildren(
      ...tabs.map((t) =>
        el("button", {
          type: "button",
          className: "chip chip--group" + (t.key === state.group ? " is-active" : ""),
          textContent: t.label,
          role: "tab",
          ariaSelected: String(t.key === state.group),
          onclick: () => {
            if (state.group === t.key) return;
            state.group = t.key;
            state.category = "";
            state.artist = "";
            setSetting("group", t.key);
            renderAll();
          },
        }),
      ),
    );
    $("group-tabs").querySelector(".is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function renderCategoryChips() {
    const items = groupItems().filter((r) => !state.artist || r.artist === state.artist);
    const counts = {};
    for (const r of items) counts[r.category] = (counts[r.category] ?? 0) + 1;
    const cats = Object.keys(data.categories).filter((c) => counts[c]);
    if (state.category && !counts[state.category]) state.category = "";
    const chips = [{ key: "", label: "すべて", n: items.length }, ...cats.map((c) => ({ key: c, label: data.categories[c], n: counts[c] }))];
    $("category-chips").replaceChildren(
      ...chips.map((c) =>
        el("button", {
          type: "button",
          className: "chip" + (c.key === state.category ? " is-active" : ""),
          onclick: () => {
            state.category = c.key;
            renderCategoryChips();
            renderGrid();
          },
        }, [c.label, el("span", { className: "chip__count", textContent: c.n })]),
      ),
    );
  }

  function renderArtistSelect() {
    const sel = $("artist-select");
    if (state.group !== OTHER_GROUP) {
      sel.hidden = true;
      return;
    }
    const counts = new Map();
    for (const r of groupItems()) counts.set(r.artist, (counts.get(r.artist) ?? 0) + 1);
    const artists = [...counts].sort((a, b) => b[1] - a[1]);
    sel.replaceChildren(
      el("option", { value: "", textContent: "すべてのアーティスト" }),
      ...artists.map(([a, n]) => el("option", { value: a, textContent: `${a}（${n}）` })),
    );
    sel.value = state.artist;
    sel.hidden = false;
  }

  function card(r) {
    const img = el("img", { alt: "", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer", src: r.image });
    img.addEventListener("error", () => img.closest(".card")?.classList.add("card--noimg"), { once: true });
    const badges = [el("span", { className: "badge", textContent: r.categoryLabel || data.categories[r.category] || "" })];
    if (r.date > today) badges.push(el("span", { className: "badge badge--soon", textContent: "発売予定" }));
    else if (r.date >= recent) badges.push(el("span", { className: "badge badge--new", textContent: "NEW" }));
    return el("button", { type: "button", className: "card", onclick: () => openSetup(r) }, [
      el("div", { className: "card__img" }, [img, el("div", { className: "card__badges" }, badges)]),
      el("div", { className: "card__body" }, [
        el("p", { className: "card__title", textContent: r.title }),
        el("p", { className: "card__meta", textContent: `${formatDate(r.date)}${state.group === OTHER_GROUP ? " ・ " + r.artist : ""}` }),
      ]),
    ]);
  }

  function renderMore() {
    const next = filtered.slice(shown, shown + PAGE);
    $("release-grid").append(...next.map(card));
    shown += next.length;
    $("home-status").textContent = filtered.length === 0 ? "該当するリリースがありません" : "";
  }

  function renderGrid() {
    applyFilters();
    shown = 0;
    $("release-grid").replaceChildren();
    $("result-count").textContent = `${filtered.length} 件`;
    renderMore();
  }

  function renderAll() {
    renderGroupTabs();
    renderArtistSelect();
    renderCategoryChips();
    renderGrid();
  }

  // 無限スクロール
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && shown < filtered.length) renderMore();
  }, { rootMargin: "600px" }).observe($("grid-sentinel"));

  $("artist-select").addEventListener("change", (e) => {
    state.artist = e.target.value;
    renderCategoryChips();
    renderGrid();
  });
  let searchTimer = 0;
  $("search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value;
      renderGrid();
    }, 150);
  });
  $("random-btn").addEventListener("click", () => {
    const pool = filtered.length ? filtered : data.releases;
    openSetup(pool[Math.floor(Math.random() * pool.length)]);
  });

  // ------------------------------------------------------------ 設定パネル

  const dialog = $("setup");
  const setup = {
    release: null,
    aspect: 1,
    pieces: getSetting("pieces", 48),
    diff: getSetting("diff", "normal"),
  };
  if (!PIECE_PRESETS.includes(setup.pieces)) setup.pieces = 48;

  function renderPieceOptions() {
    $("piece-options").replaceChildren(
      ...PIECE_PRESETS.map((n) => {
        const g = gridFor(n, setup.aspect);
        return el("button", {
          type: "button",
          className: "opt" + (n === setup.pieces ? " is-active" : ""),
          onclick: () => { setup.pieces = n; renderSetupState(); },
        }, [el("strong", { textContent: g.count }), el("small", { textContent: `${g.cols}×${g.rows}` })]);
      }),
    );
  }

  function renderDifficultyOptions() {
    $("difficulty-options").replaceChildren(
      ...DIFFICULTIES.map((d) =>
        el("button", {
          type: "button",
          className: `opt opt--diff opt--${d.id}` + (d.id === setup.diff ? " is-active" : ""),
          onclick: () => { setup.diff = d.id; renderSetupState(); },
        }, [el("strong", { textContent: d.label }), el("small", { textContent: d.desc })]),
      ),
    );
  }

  function renderSetupState() {
    renderPieceOptions();
    renderDifficultyOptions();
    const key = configKey(setup.release.id, setup.pieces, setup.diff);
    const best = getBest(key);
    $("setup-best").textContent = best != null ? `🏆 この設定の自己ベスト: ${formatTime(best)}` : "";
    const save = loadSave(key);
    $("resume-btn").hidden = !save;
    if (save) $("resume-btn").textContent = `続きから（${save.percent ?? 0}%・${formatTime(save.elapsed ?? 0)}）`;
  }

  function openSetup(r) {
    setup.release = r;
    setup.aspect = 1;
    const img = $("setup-img");
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      if (setup.release !== r) return;
      setup.aspect = img.naturalWidth / img.naturalHeight || 1;
      renderPieceOptions();
    };
    img.src = r.image;
    img.alt = r.title;
    $("setup-meta").textContent = `${r.categoryLabel} ・ ${formatDate(r.date)}${r.date > today ? " 発売予定" : ""}`;
    $("setup-title").textContent = r.title;
    $("setup-artist").textContent = r.artist;
    $("setup-link").href = r.link;
    renderSetupState();
    if (!dialog.open) dialog.showModal();
  }

  function start(fresh) {
    setSetting("pieces", setup.pieces);
    setSetting("diff", setup.diff);
    dialog.close();
    onStart(setup.release, setup.pieces, setup.diff, fresh);
  }

  $("start-btn").addEventListener("click", () => start(true));
  $("resume-btn").addEventListener("click", () => start(false));
  // 背景（ダイアログの外側）クリックで閉じる
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  renderAll();

  return {
    openSetup,
    /** ゲームから戻ったときに「続きから」表示などを更新 */
    refresh() {
      if (dialog.open && setup.release) renderSetupState();
    },
  };
}
