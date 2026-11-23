// helloproject.com からグループ一覧とリリース一覧（ジャケ写URL付き）を取得し、
// public/data/releases.json に書き出すスクリプト。
//
// 仕組み:
//   1. トップページのナビゲーションから現役グループ（slug と表示名）を取得
//   2. 各グループのリリースページに埋め込まれた props から groupId / versionDir / 年一覧を取得
//   3. /json/{versionDir}/{year}_releases.json を年ごとに取得して結合
//
// 使い方: node scripts/fetch-releases.mjs

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://helloproject.com";
const UA = "Mozilla/5.0 (compatible; helloproject-jigsaw-fetcher/1.0)";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/data/releases.json");

const CATEGORY_LABELS = {
  single: "シングル",
  album: "アルバム",
  ep: "EP",
  video: "映像",
  distribution: "配信",
  photoBook: "写真集",
  book: "書籍",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, { json = false, allow404 = false } = {}) {
  const url = path.startsWith("http") ? path : BASE + path;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (allow404 && res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (err) {
      if (attempt === 3) throw new Error(`${url}: ${err.message}`);
      await sleep(1000 * attempt);
    }
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function fetchGroups() {
  const html = await get("/");
  const re = /<a href="\/([a-z0-9-]+)\/"[^>]*class="NavigationLink NavigationLink--group"[^>]*>([^<]+)<\/a>/g;
  const groups = new Map();
  for (const m of html.matchAll(re)) {
    if (!groups.has(m[1])) groups.set(m[1], decodeEntities(m[2]).trim());
  }
  if (groups.size === 0) throw new Error("トップページからグループ一覧を取得できませんでした（サイト構造が変わった可能性）");
  return [...groups].map(([slug, name]) => ({ slug, name }));
}

// Astro の <astro-island props="..."> は [型, 値] 形式でシリアライズされているので元に戻す
function reviveAstro(v) {
  if (!Array.isArray(v)) return v;
  const [type, val] = v;
  if (type === 1) return val.map(reviveAstro);
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return Object.fromEntries(Object.entries(val).map(([k, x]) => [k, reviveAstro(x)]));
  }
  return val;
}

// リリース一覧ページから、Release コンポーネントの props を取り出す
async function fetchReleaseProps(path) {
  const html = await get(path);
  const tag = html.match(/<astro-island[^>]*component-url="[^"]*\/Release\.[^"]*"[^>]*>/)?.[0];
  const raw = tag?.match(/\sprops="([^"]*)"/)?.[1];
  if (!raw) return null;
  const obj = JSON.parse(decodeEntities(raw));
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, reviveAstro(v)]));
}

async function fetchGroupMeta(slug) {
  const props = await fetchReleaseProps(`/${slug}/release/`);
  const id = Number(props?.fixedFilterProps?.selectedGroupIds?.[0]);
  return {
    versionDir: props?.versionDir ?? null,
    id: Number.isFinite(id) ? id : null,
    years: props?.years ?? [],
    newRelease: props?.newRelease ?? [],
  };
}

async function main() {
  console.log("グループ一覧を取得中...");
  const groupList = await fetchGroups();

  let versionDir = null;
  const years = new Set();
  const groups = [];
  // 発売前の新譜は年別 JSON に入っていないことがあるので、各ページの newRelease も集める
  const upcoming = [];
  for (const g of groupList) {
    const meta = await fetchGroupMeta(g.slug);
    await sleep(300);
    if (meta.id == null) {
      console.warn(`  ! ${g.name} (${g.slug}) の groupId が取れなかったのでスキップ`);
      continue;
    }
    versionDir ??= meta.versionDir;
    meta.years.forEach((y) => years.add(String(y)));
    upcoming.push(...meta.newRelease);
    groups.push({ id: meta.id, slug: g.slug, name: g.name });
    console.log(`  ${g.name} -> id ${meta.id}`);
  }
  const allProps = await fetchReleaseProps("/release/").catch(() => null);
  if (allProps) {
    versionDir ??= allProps.versionDir;
    (allProps.years ?? []).forEach((y) => years.add(String(y)));
    upcoming.push(...(allProps.newRelease ?? []));
  }
  if (!versionDir) throw new Error("versionDir を取得できませんでした（サイト構造が変わった可能性）");

  // 年一覧が取れなかったときの保険
  if (years.size === 0) {
    for (let y = 1997; y <= new Date().getFullYear() + 1; y++) years.add(String(y));
  }

  const groupIds = new Set(groups.map((g) => g.id));
  const releases = [];
  const seen = new Set();
  const add = (it) => {
    if (!it?.image?.url || it.id == null || seen.has(it.id)) return false;
    seen.add(it.id);
    const artistIds = (it.artistsSearch ?? []).map(Number);
    releases.push({
      id: it.id,
      title: it.title,
      artist: it.releaseName ?? "",
      date: it.date ?? "",
      category: it.category?.[0] ?? "other",
      categoryLabel: it.categoryLabel ?? "",
      image: new URL(it.image.url, BASE).href,
      // グループページ配下のリンク (/morningmusume/release/7716/) も /release/7716/ に正規化
      link: `${BASE}/release/${it.id}/`,
      groups: artistIds.filter((id) => groupIds.has(id)),
    });
    return true;
  };

  for (const year of [...years].sort()) {
    const data = await get(`/json/${versionDir}/${year}_releases.json`, { json: true, allow404: true });
    await sleep(200);
    if (!data) continue;
    const n = (data.items ?? []).filter(add).length;
    console.log(`  ${year}: ${n} 件`);
  }
  const nUpcoming = upcoming.filter(add).length;
  console.log(`  新譜（年別データ未掲載分）: ${nUpcoming} 件`);

  releases.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));

  const out = {
    source: BASE,
    categories: CATEGORY_LABELS,
    groups,
    releases,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out) + "\n", "utf8");
  console.log(`\n${releases.length} 件のリリースを ${OUT} に保存しました`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
