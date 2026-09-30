/* depgraph UI — 層レーン既定で全ファイルを俯瞰。段階展開はオプション。
 * レイアウトは dagre(vendor 同梱)で自前計算し、cytoscape には preset 座標として渡す。 */
/* global cytoscape, dagre */
/* eslint-disable no-undef */

const NODE_BUDGET = 300; // 段階展開時の目安
const LABEL_ZOOM = 0.45; // このズーム以上でファイル名ラベルを表示
const FIT_MIN_ZOOM = 0.5; // fit 時の下限（これ未満に縮めない）
const IMPORTANT_DEGREE = 20;
const CARD_W = 540;
const CARD_H = 340;
const DIR_W = 220;
const DIR_H = 72;
const CL_PAD = 44;
const CL_HEADER = 86;
const DIR_PAD = 22;
const DIR_HEADER = 50;
const FILE_CELL_W = 72;
const LANE_PACK_GAP = 48; // 全文ラベル用の隣接間隔
const LANE_MAX_ROW_W = 1600; // 折り返し幅（高さ可変）
const UNCLASSIFIED_COMPACT_MAX = 12;

const KINDS = [
  { key: "circular_dependency", label: "循環", color: "#ff5252", prio: 5 },
  { key: "layer_violation", label: "レイヤー", color: "#ff80ab", prio: 4 },
  { key: "hub", label: "ハブ", color: "#ffa726", prio: 3 },
  { key: "bloated_file", label: "肥大", color: "#d05ce3", prio: 2 },
  { key: "orphan", label: "孤立", color: "#9aa5b1", prio: 1 },
];
const KIND_BY_KEY = Object.fromEntries(KINDS.map((k) => [k.key, k]));

const LANG_COLOR = { csharp: "#6a9f7a", dart: "#4fc3f7", python: "#ffd54f", unknown: "#8b9bb0" };
const CROSS_EDGE_COLOR = "#ff8a3d";
const EDGE_COLOR = "#8fa3b8";
const ACCENT = "#3db8a0";

const state = {
  data: null,
  model: null,
  cy: null,
  ui: {
    viewMode: "cluster", // cluster | layer | feature
    layerLanes: true, // 層レーン配置
    stagedExpand: false, // true=従来の段階展開(折りたたみ)。既定は全展開
    expandedClusters: new Set(),
    expandedDirs: new Set(), // `${cluster}|${unit}`
    expandedLayers: new Set(),
    expandedLayerFeatures: new Set(), // `${layer}|${feature}`
    expandedFeatures: new Set(),
    hiddenClusters: new Set(),
    hideIsolated: true,
    problemOnly: false,
    archOnly: false,
    kinds: { circular_dependency: true, layer_violation: true, hub: true, bloated_file: true, orphan: false },
    unit: "directory", // directory | file (段階展開時)
    noLimit: true, // 全展開既定のため上限解除
    matrixPair: null,
  },
  sel: { ids: [], mode: "none" },
  labelsOn: null,
  lastView: null,
  lastTap: { id: null, t: 0 },
  searchHits: [],
};

const $ = (id) => document.getElementById(id);
const el = {
  graph: $("graph"),
  issues: $("issues"),
  issuesEmpty: $("issues-empty"),
  selection: $("selection"),
  summary: $("summary"),
  status: $("status"),
  unit: $("unit"),
  viewMode: $("view-mode"),
  search: $("search"),
  searchResults: $("search-results"),
  reload: $("reload"),
  fit: $("fit"),
  overview: $("overview"),
  download: $("download"),
  clusters: $("clusters"),
  clusterStats: $("cluster-stats"),
  layerMatrix: $("layer-matrix"),
  layerLegend: $("layer-legend"),
  kinds: $("kinds"),
  problemOnly: $("problem-only"),
  hideIsolated: $("hide-isolated"),
  archOnly: $("arch-only"),
  layerLanes: $("layer-lanes"),
  stagedExpand: $("staged-expand"),
  noLimit: $("no-limit"),
  expanded: $("expanded"),
  counter: $("counter"),
  tip: $("tip"),
};

function setStatus(msg) {
  el.status.textContent = msg;
}
function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function estWidth(s, fs) {
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) > 255 ? fs : fs * 0.58;
  return w;
}

/** ファイルノードの表示サイズ（ラベル全文が収まる幅） */
function fileLayoutBox(f) {
  const size = fileSize(f);
  const label = f.name || "";
  const lw = Math.ceil(estWidth(label, 12) + 16);
  const w = Math.max(size, FILE_CELL_W, lw);
  return { size, w, h: size + 26, label };
}

/* ---------------- モデル ---------------- */

function dirOf(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}
const dkey = (f) => `${f.cluster}|${f.unit}`;

function shortNames(keys) {
  const segsOf = (k) => (k === "." ? ["(root)"] : k.split("/"));
  const suffix = (k, n) => segsOf(k).slice(-n).join("/");
  const res = new Map();
  for (const k of keys) {
    const len = segsOf(k).length;
    let n = Math.min(2, len);
    while (n < len) {
      const s = suffix(k, n);
      if (keys.some((o) => o !== k && suffix(o, n) === s)) n++;
      else break;
    }
    res.set(k, suffix(k, n));
  }
  return res;
}

function buildModel(data) {
  const files = new Map();
  for (const n of data.graph.nodes) {
    if (n.kind !== "file") continue;
    const p = n.path || n.label;
    files.set(n.id, {
      id: n.id, path: p, name: n.label, loc: n.loc || 1, lang: n.language || "unknown",
      cluster: n.clusterKey || "その他",
      layer: n.layerKey || "未分類",
      feature: n.featureKey || "(none)",
      layerReason: n.layerReason || "",
      dir: dirOf(p), unit: "",
      outs: new Set(), ins: new Set(), deg: 0, issues: new Map(),
    });
  }
  const seen = new Set();
  const edges = [];
  for (const e of data.graph.edges) {
    if (e.kind === "contains") continue;
    const a = files.get(e.source);
    const b = files.get(e.target);
    if (!a || !b || a === b) continue;
    const k = `${e.source}>${e.target}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ s: a.id, t: b.id });
    a.outs.add(b.id);
    b.ins.add(a.id);
  }
  for (const f of files.values()) f.deg = f.outs.size + f.ins.size;

  const issueCountByKind = {};
  for (const is of data.issues || []) {
    issueCountByKind[is.kind] = (issueCountByKind[is.kind] || 0) + 1;
    for (const loc of is.locations) {
      const f = files.get(loc);
      if (!f) continue;
      if (!f.issues.has(is.kind)) f.issues.set(is.kind, []);
      f.issues.get(is.kind).push(is);
    }
  }

  const clusters = [];
  const byKey = new Map();
  const ensure = (key, color) => {
    if (!byKey.has(key)) {
      const c = { key, color: color || "#b39ddb", files: [], dirs: new Map(), issues: [], summaryCount: 0 };
      byKey.set(key, c);
      clusters.push(c);
    }
    return byKey.get(key);
  };
  for (const c of data.summary.clusters || []) ensure(c.key, c.color).summaryCount = c.fileCount;
  for (const f of files.values()) ensure(f.cluster).files.push(f);
  for (const is of data.issues || []) {
    const f = files.get(is.locations[0]);
    if (f) byKey.get(f.cluster).issues.push(is);
  }

  // ディレクトリ単位(深さを必要なら丸めて、1クラスタあたり NODE_BUDGET 以下に)
  for (const c of clusters) {
    const dirs = [...new Set(c.files.map((f) => f.dir))];
    const depthOf = (d) => (d === "." ? 0 : d.split("/").length);
    const trunc = (d, k) => (d === "." ? "." : d.split("/").slice(0, k).join("/"));
    let k = Math.max(1, ...dirs.map(depthOf));
    while (k > 1 && new Set(dirs.map((d) => trunc(d, k))).size > NODE_BUDGET) k--;
    for (const f of c.files) {
      f.unit = trunc(f.dir, k);
      if (!c.dirs.has(f.unit)) c.dirs.set(f.unit, { key: f.unit, cluster: c.key, files: [], loc: 0, label: "" });
      const d = c.dirs.get(f.unit);
      d.files.push(f);
      d.loc += f.loc;
    }
    const names = shortNames([...c.dirs.keys()]);
    for (const d of c.dirs.values()) d.label = names.get(d.key);
  }

  // 検索インデックス
  const index = [];
  for (const f of files.values()) index.push({ type: "file", id: f.id, name: f.name, path: f.path, cluster: f.cluster });
  for (const c of clusters)
    for (const d of c.dirs.values())
      index.push({ type: "dir", cluster: c.key, unit: d.key, name: d.label, path: d.key === "." ? "(root)" : d.key });

  return { files, edges, clusters, byKey, issueCountByKind, index };
}

const isProblem = (f) => {
  for (const k of f.issues.keys()) {
    if (!state.ui.kinds[k]) continue;
    if (state.ui.archOnly) {
      const list = f.issues.get(k) || [];
      if (k === "layer_violation" && list.some((i) => String(i.title || "").includes("層の依存方向違反"))) return true;
      continue;
    }
    return true;
  }
  return false;
};

function isArchViolationIssue(is) {
  return is.kind === "layer_violation" && String(is.title || "").includes("層の依存方向違反");
}

function layerOrderList() {
  const layers = state.data?.summary?.layers || [];
  return [...layers].filter((l) => l.fileCount > 0 || l.key === "未分類").sort((a, b) => b.order - a.order);
}

function archViolationPairs() {
  const set = new Set();
  for (const is of state.data?.issues || []) {
    if (!isArchViolationIssue(is)) continue;
    const fl = is.details?.find((d) => d.startsWith("from_layer: "))?.slice(12);
    const tl = is.details?.find((d) => d.startsWith("to_layer: "))?.slice(10);
    if (fl && tl) set.add(`${fl}\t${tl}`);
  }
  return set;
}

function majorityLayerOf(files) {
  const c = new Map();
  let best = "未分類";
  for (const f of files) {
    const k = f.layer || "未分類";
    const v = (c.get(k) || 0) + 1;
    c.set(k, v);
    if (v > (c.get(best) || 0)) best = k;
  }
  return best;
}

function layerInfoMap() {
  const m = new Map();
  for (const l of state.data?.summary?.layers || []) m.set(l.key, l);
  return m;
}

/**
 * 水平レーン内配置。maxRowW を超えたら折り返し、行数に応じて高さが増える。
 * 件数少の帯は1行のまま低く、件数多の帯は多段で高くなる。
 */
function packLane(items, gap = LANE_PACK_GAP, opts = {}) {
  const maxRowW = opts.maxRowW ?? LANE_MAX_ROW_W;
  const rowGap = opts.rowGap ?? 16;
  if (!items.length) return { pos: new Map(), w: 0, h: 0, rows: 0 };
  const rows = [];
  let cur = [];
  let curW = 0;
  for (const it of items) {
    const next = cur.length ? curW + gap + it.w : it.w;
    if (cur.length && next > maxRowW) {
      rows.push(cur);
      cur = [];
      curW = 0;
    }
    cur.push(it);
    curW += (cur.length > 1 ? gap : 0) + it.w;
  }
  if (cur.length) rows.push(cur);

  const pos = new Map();
  let y = 0;
  let maxW = 0;
  for (const row of rows) {
    const rh = Math.max(...row.map((it) => it.h));
    let x = 0;
    for (const it of row) {
      pos.set(it.id, { x: x + it.w / 2, y: y + rh / 2 });
      x += it.w + gap;
    }
    maxW = Math.max(maxW, x - gap);
    y += rh + rowGap;
  }
  return { pos, w: maxW, h: y - rowGap, rows: rows.length };
}

/**
 * 展開クラスタを層レーンで配置。
 * 戻り: { label, w, h, lanes, placements, dirLayouts, filePlacements, groupPlacements }
 */
function layoutClusterByLayerLanes(cv, vedges, m, ui) {
  const LANE_PAD_X = 28;
  const LANE_PAD_Y = 14;
  const LANE_HEADER = 32;
  const LANE_GAP = 16;
  const GROUP_PAD = 16;
  const GROUP_HEADER = 28;
  const infos = layerInfoMap();
  const order = layerOrderList(); // archLayers の order 降順
  // archLayers 順を優先。フォールバック既定 → 実際に出現した層
  const fallback = ["プレゼンテーション", "アプリケーション", "ドメイン", "インフラ", "共通・基盤", "テスト・ツール・外部", "未分類"];
  const laneKeys = [];
  for (const l of order) if (!laneKeys.includes(l.key)) laneKeys.push(l.key);
  for (const k of fallback) if (!laneKeys.includes(k)) laneKeys.push(k);

  // --- レーンごとのコンテンツ収集 ---
  // groupKey = feature 優先、無ければ unit
  const laneGroups = new Map(); // layer -> Map(groupKey -> { files, dirCards, units })
  const ensureLane = (layer) => {
    if (!laneGroups.has(layer)) laneGroups.set(layer, new Map());
    return laneGroups.get(layer);
  };
  const ensureGroup = (layer, gkey) => {
    const lg = ensureLane(layer);
    if (!lg.has(gkey)) lg.set(gkey, { key: gkey, files: [], dirCards: [], units: new Set() });
    return lg.get(gkey);
  };

  for (const [unit, files] of cv.dirs) {
    // 全展開(段階展開OFF)では常にファイル単位。段階展開時は expandedDirs に従う
    const expanded = !ui.stagedExpand || ui.expandedDirs.has(`${cv.c.key}|${unit}`);
    if (expanded) {
      for (const f of files) {
        const layer = f.layer || "未分類";
        const gkey = f.feature && f.feature !== "(none)" ? f.feature : unit;
        const g = ensureGroup(layer, gkey);
        g.files.push(f);
        g.units.add(unit);
      }
    } else {
      const layer = majorityLayerOf(files);
      const gkey = unit;
      ensureGroup(layer, gkey).dirCards.push({ unit, files });
    }
  }

  for (const k of laneGroups.keys()) if (!laneKeys.includes(k)) laneKeys.push(k);
  // 0件の層（未分類含む）は帯を出さない
  const activeLanes = laneKeys.filter((k) => (laneGroups.get(k)?.size || 0) > 0);
  const lanes = [];
  let maxLaneInnerW = 0;

  for (const layerKey of activeLanes) {
    const groups = [...(laneGroups.get(layerKey)?.values() || [])];
    groups.sort((a, b) => (b.files.length + b.dirCards.length) - (a.files.length + a.dirCards.length) || a.key.localeCompare(b.key));

    const laneItems = [];
    const groupLayouts = new Map();
    const compact =
      layerKey === "未分類" &&
      groups.reduce((n, g) => n + g.files.length + g.dirCards.length, 0) <= UNCLASSIFIED_COMPACT_MAX;

    for (const g of groups) {
      if (g.files.length) {
        const nodes = g.files.map((f) => {
          const box = fileLayoutBox(f);
          return { id: f.id, w: box.w, h: box.h, size: box.size, label: box.label, file: f };
        });
        const innerEdges = vedges
          .filter((e) => {
            const a = m.files.get(e.s);
            const b = m.files.get(e.t);
            return a && b && nodes.some((n) => n.id === a.id) && nodes.some((n) => n.id === b.id);
          })
          .map((e) => ({ s: e.s, t: e.t }));
        const L = layoutNodes(
          nodes.map((n) => ({ id: n.id, w: n.w, h: n.h })),
          innerEdges,
          { aspect: 2.4, nodesep: 28, ranksep: 48 },
        );
        const label = `${g.key} (${g.files.length})`;
        const iw = Math.max(L.w, estWidth(label, 15) + 20);
        const w = iw + GROUP_PAD * 2;
        const h = L.h + GROUP_HEADER + GROUP_PAD;
        const id = `lg:${cv.c.key}|${layerKey}|${g.key}`;
        groupLayouts.set(g.key, {
          L, nodes, label, w, h, ox: (iw - L.w) / 2, files: g.files,
          units: [...g.units],
        });
        laneItems.push({ id, w, h, kind: "group", gkey: g.key });
      }
      for (const dc of g.dirCards) {
        const dirInfo = cv.c.dirs.get(dc.unit);
        const np = dc.files.filter(isProblem).length;
        const tk = topKind(dc.files);
        const nameLine = dirInfo?.label || dc.unit || "(root)";
        const meta = `${dc.files.length}ファイル${np ? `・問題${np}` : ""}`;
        const label = `${nameLine}\n${meta}`;
        const labelW = Math.ceil(Math.max(estWidth(nameLine, 14), estWidth(meta, 12)) + 36);
        const w = Math.max(DIR_W, labelW);
        const h = compact ? 56 : DIR_H;
        laneItems.push({
          id: `d:${cv.c.key}|${dc.unit}`,
          w,
          h,
          kind: "dir",
          unit: dc.unit,
          files: dc.files,
          label,
          tk,
          fullPath: dc.unit === "." ? "(root)" : dc.unit,
        });
      }
    }

    const maxRowW = compact
      ? Math.min(LANE_MAX_ROW_W, Math.max(560, laneItems.length * 120))
      : laneItems.length <= 4
        ? Infinity
        : LANE_MAX_ROW_W;
    const packed = packLane(laneItems, compact ? 32 : LANE_PACK_GAP, { maxRowW, rowGap: compact ? 10 : 18 });
    const info = infos.get(layerKey) || { key: layerKey, color: "#64748b", short: layerKey.slice(0, 4) };
    const header = compact ? 22 : LANE_HEADER;
    const padY = compact ? 6 : LANE_PAD_Y;
    const padX = compact ? 16 : LANE_PAD_X;
    const innerW = Math.max(packed.w, estWidth(layerKey, compact ? 14 : 20) + 32);
    const laneW = innerW + padX * 2;
    const laneH = Math.max(packed.h, compact ? 28 : 40) + header + padY * 2;
    maxLaneInnerW = Math.max(maxLaneInnerW, laneW);
    lanes.push({
      key: layerKey,
      info,
      items: laneItems,
      packed,
      groupLayouts,
      w: laneW,
      h: laneH,
      innerW,
      compact,
      header,
      padY,
      padX,
    });
  }

  // 全レーン幅を揃える（未分類コンパクト帯も同じ幅の枠だが中身は上寄せ）
  for (const lane of lanes) lane.w = maxLaneInnerW;

  const label = `${cv.c.key} ・ ${cv.vfiles.length}ファイル / 層レーン`;
  const contentH = lanes.reduce((s, l) => s + l.h, 0) + Math.max(0, lanes.length - 1) * LANE_GAP;
  const contentW = maxLaneInnerW;
  const w = contentW + CL_PAD * 2;
  const h = contentH + CL_HEADER + CL_PAD;

  return { label, w, h, lanes, LANE_PAD_X, LANE_PAD_Y, LANE_HEADER, LANE_GAP, GROUP_PAD, GROUP_HEADER };
}
function topKind(files) {
  let best = null;
  for (const f of files) for (const k of f.issues.keys()) if (state.ui.kinds[k] && (!best || KIND_BY_KEY[k].prio > best.prio)) best = KIND_BY_KEY[k];
  return best;
}
function fileSize(f) {
  return Math.round(clamp(14 + Math.sqrt(f.loc) * 0.9 + Math.min(f.deg, 24) * 0.9, 16, 54));
}

/* ---------------- レイアウト(dagre + グリッド) ---------------- */

function layoutNodes(nodes, edges, o) {
  if (nodes.length === 0) return { pos: new Map(), w: 0, h: 0 };
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set();
  const es = [];
  for (const e of edges) {
    if (e.s === e.t || !ids.has(e.s) || !ids.has(e.t)) continue;
    const k = `${e.s}>${e.t}`;
    if (seen.has(k)) continue;
    seen.add(k);
    es.push(e);
  }
  const linked = new Set();
  es.forEach((e) => {
    linked.add(e.s);
    linked.add(e.t);
  });
  const conn = nodes.filter((n) => linked.has(n.id));
  const iso = nodes.filter((n) => !linked.has(n.id));

  // 連結ノード: dagre でランク付け → ランクを折り返し + 帯(バンド)分割して目標アスペクトに近づける
  const connCands = [];
  if (!conn.length) connCands.push({ pos: new Map(), cw: 0, ch: 0 });
  else {
    for (const rd of ["TB", "LR"]) {
      const tb = rd === "TB";
      const g = new dagre.graphlib.Graph();
      g.setGraph({ rankdir: rd, nodesep: o.nodesep, ranksep: o.ranksep, marginx: 0, marginy: 0 });
      g.setDefaultEdgeLabel(() => ({}));
      conn.forEach((n) => g.setNode(n.id, { width: n.w, height: n.h }));
      es.forEach((e) => g.setEdge(e.s, e.t));
      dagre.layout(g);
      const R = (n) => (tb ? n.h : n.w); // ランク軸方向の厚み
      const C = (n) => (tb ? n.w : n.h); // 直交軸方向の幅
      const area = conn.reduce((a, n) => a + (n.w + o.nodesep) * (n.h + o.nodesep), 0);
      const target = tb ? o.aspect : 1 / o.aspect;
      const limit = Math.max(Math.max(...conn.map(C)), Math.sqrt(area * target) * 1.1);
      const ranks = new Map();
      for (const n of conn) {
        const p = g.node(n.id);
        const rk = Math.round(tb ? p.y : p.x);
        if (!ranks.has(rk)) ranks.set(rk, []);
        ranks.get(rk).push({ n, c: tb ? p.x : p.y });
      }
      const lines = []; // {items:[{id,c}], ext, thick, gapAfter}
      for (const rk of [...ranks.keys()].sort((a, b) => a - b)) {
        const items = ranks.get(rk).sort((a, b) => a.c - b.c);
        const groups = [];
        let cur = [];
        let ext = 0;
        for (const it of items) {
          const sz = C(it.n);
          if (cur.length && ext + o.nodesep + sz > limit) {
            groups.push(cur);
            cur = [];
            ext = 0;
          }
          ext += (cur.length ? o.nodesep : 0) + sz;
          cur.push(it);
        }
        if (cur.length) groups.push(cur);
        groups.forEach((grp, gi) => {
          let c0 = 0;
          const its = grp.map((it) => {
            const r = { id: it.n.id, c: c0 + C(it.n) / 2 };
            c0 += C(it.n) + o.nodesep;
            return r;
          });
          lines.push({ items: its, ext: c0 - o.nodesep, thick: Math.max(...grp.map((it) => R(it.n))), gap: gi < grp.length - 1 || gi < groups.length - 1 ? o.nodesep : o.ranksep });
        });
      }
      for (let k = 1; k <= 8; k++) {
        if (k > 1 && lines.length < k * 2) break;
        const total = lines.reduce((a, l) => a + l.thick + l.gap, 0);
        const per = total / k;
        const bands = [];
        let cur = [];
        let acc = 0;
        for (const l of lines) {
          if (cur.length && acc >= per && bands.length < k - 1) {
            bands.push(cur);
            cur = [];
            acc = 0;
          }
          cur.push(l);
          acc += l.thick + l.gap;
        }
        bands.push(cur);
        const pos = new Map();
        let coff = 0;
        let rmax = 0;
        bands.forEach((band) => {
          const bext = Math.max(...band.map((l) => l.ext));
          let r0 = 0;
          for (const l of band) {
            const off = (bext - l.ext) / 2;
            for (const it of l.items) {
              const rc = r0 + l.thick / 2;
              const cc = coff + off + it.c;
              pos.set(it.id, tb ? { x: cc, y: rc } : { x: rc, y: cc });
            }
            r0 += l.thick + l.gap;
          }
          rmax = Math.max(rmax, r0 - band[band.length - 1].gap);
          coff += bext + o.ranksep;
        });
        const cext = coff - o.ranksep;
        connCands.push({ pos, cw: tb ? cext : rmax, ch: tb ? rmax : cext });
      }
    }
  }
  const candidates = [];
  for (const cc of connCands) {
    const { cw, ch, pos } = cc;
    let W = cw;
    let H = ch;
    let grid = null;
    if (iso.length) {
      const cellW = Math.max(...iso.map((n) => n.w)) + o.nodesep;
      const cellH = Math.max(...iso.map((n) => n.h)) + o.nodesep;
      const byAspect = Math.ceil(Math.sqrt(iso.length * o.aspect * (cellH / cellW)));
      const byWidth = Math.floor((cw + o.nodesep) / cellW);
      const cols = clamp(Math.max(byAspect, byWidth), 1, iso.length);
      const rows = Math.ceil(iso.length / cols);
      const gw = cols * cellW - o.nodesep;
      const gh = rows * cellH - o.nodesep;
      grid = { cols, cellW, cellH, gw, gh };
      W = Math.max(cw, gw);
      H = ch + (conn.length ? o.ranksep : 0) + gh;
    }
    const offC = (W - cw) / 2;
    const all = new Map();
    for (const [id, p] of pos) all.set(id, { x: p.x + offC, y: p.y });
    if (grid) {
      const offG = (W - grid.gw) / 2;
      const y0 = ch + (conn.length ? o.ranksep : 0);
      iso.forEach((n, i) => {
        const r = Math.floor(i / grid.cols);
        const c = i % grid.cols;
        all.set(n.id, { x: offG + c * grid.cellW + (grid.cellW - o.nodesep) / 2, y: y0 + r * grid.cellH + (grid.cellH - o.nodesep) / 2 });
      });
    }
    candidates.push({ pos: all, w: W, h: H, cost: Math.abs(Math.log(W / Math.max(1, H) / o.aspect)) + (W * H) / 1e9 });
  }
  candidates.sort((a, b) => a.cost - b.cost);
  return candidates[0];
}

/* ---------------- ビュー構築 ---------------- */

function buildView() {
  if (state.ui.viewMode === "layer") return buildLayerView();
  if (state.ui.viewMode === "feature") return buildFeatureView();
  const m = state.model;
  const ui = state.ui;
  const ar = Math.max(0.8, el.graph.clientWidth / Math.max(1, el.graph.clientHeight));
  const vis = (f) => {
    if (ui.hiddenClusters.has(f.cluster)) return false;
    if (ui.problemOnly && !isProblem(f)) return false;
    if (ui.hideIsolated && f.deg === 0) return false;
    return true;
  };

  const visSet = new Set();
  const cvs = [];
  const cvBy = new Map();
  for (const c of m.clusters) {
    if (ui.hiddenClusters.has(c.key)) continue;
    // 全展開モードでは空クラスタカードを出さない
    if (!ui.stagedExpand && ui.layerLanes && c.files.length === 0) continue;
    const vfiles = c.files.filter(vis);
    vfiles.forEach((f) => visSet.add(f.id));
    const dirs = new Map();
    for (const f of vfiles) {
      if (!dirs.has(f.unit)) dirs.set(f.unit, []);
      dirs.get(f.unit).push(f);
    }
    const cv = { c, vfiles, dirs, expanded: ui.expandedClusters.has(c.key) };
    cvs.push(cv);
    cvBy.set(c.key, cv);
  }
  const vedges = m.edges.filter((e) => visSet.has(e.s) && visSet.has(e.t));

  // 代表ノード(表示される粒度)への集約エッジ
  const rep = (f) => {
    const cv = cvBy.get(f.cluster);
    if (!cv.expanded) return `c:${f.cluster}`;
    return ui.expandedDirs.has(dkey(f)) ? f.id : `d:${dkey(f)}`;
  };
  const edgeMap = new Map();
  for (const e of vedges) {
    const a = m.files.get(e.s);
    const b = m.files.get(e.t);
    const rs = rep(a);
    const rt = rep(b);
    if (rs === rt) continue;
    const id = `e:${rs}->${rt}`;
    const cur = edgeMap.get(id);
    if (cur) cur.data.weight++;
    else edgeMap.set(id, { group: "edges", data: { id, source: rs, target: rt, weight: 1, cross: a.cluster !== b.cluster, kind: "edge" } });
  }
  const crossTotal = [...edgeMap.values()].filter((e) => e.data.cross).length;

  // 展開クラスタ内レイアウト
  const nExp = cvs.filter((x) => x.expanded).length;
  const layouts = new Map();
  const violPairs = archViolationPairs();
  for (const cv of cvs) {
    if (!cv.expanded) continue;
    if (ui.layerLanes) {
      layouts.set(cv.c.key, { mode: "lanes", ...layoutClusterByLayerLanes(cv, vedges, m, ui) });
      continue;
    }
    const dirLayouts = new Map();
    for (const [unit, files] of cv.dirs) {
      if (!ui.expandedDirs.has(`${cv.c.key}|${unit}`)) continue;
      const nodes = files.map((f) => ({ id: f.id, w: Math.max(fileSize(f), FILE_CELL_W), h: fileSize(f) + 34, size: fileSize(f) }));
      const inner = vedges.filter((e) => m.files.get(e.s).unit === unit && m.files.get(e.t).unit === unit && m.files.get(e.s).cluster === cv.c.key && m.files.get(e.t).cluster === cv.c.key);
      const L = layoutNodes(nodes, inner, { aspect: 1.5, nodesep: 20, ranksep: 46 });
      const label = `${cv.c.dirs.get(unit).label} (${files.length})`;
      const iw = Math.max(L.w, estWidth(label, 20) + 20);
      dirLayouts.set(unit, { L, nodes, label, w: iw + DIR_PAD * 2, h: L.h + DIR_HEADER + DIR_PAD, ox: (iw - L.w) / 2 });
    }
    const dnodes = [];
    for (const [unit] of cv.dirs) {
      const dl = dirLayouts.get(unit);
      dnodes.push(dl ? { id: unit, w: dl.w, h: dl.h } : { id: unit, w: DIR_W, h: DIR_H });
    }
    const dseen = new Set();
    const dedges = [];
    for (const e of vedges) {
      const a = m.files.get(e.s);
      const b = m.files.get(e.t);
      if (a.cluster !== cv.c.key || b.cluster !== cv.c.key || a.unit === b.unit) continue;
      const k = `${a.unit}>${b.unit}`;
      if (dseen.has(k)) continue;
      dseen.add(k);
      dedges.push({ s: a.unit, t: b.unit });
    }
    const L2 = layoutNodes(dnodes, dedges, { aspect: (ar * 0.85) / Math.max(1, nExp), nodesep: 36, ranksep: 84 });
    const label = `${cv.c.key} ・ ${cv.vfiles.length}ファイル / ${cv.dirs.size}ディレクトリ`;
    const iw = Math.max(L2.w, estWidth(label, 34) + 40);
    layouts.set(cv.c.key, { mode: "dirs", L2, dirLayouts, label, w: iw + CL_PAD * 2, h: L2.h + CL_HEADER + CL_PAD, ox: (iw - L2.w) / 2 });
  }

  // エッジに層違反フラグ
  for (const e of edgeMap.values()) {
    const resolveLayer = (id) => {
      if (m.files.has(id)) return m.files.get(id).layer;
      if (id.startsWith("d:")) {
        const rest = id.slice(2);
        const bar = rest.indexOf("|");
        if (bar < 0) return null;
        const d = m.byKey.get(rest.slice(0, bar))?.dirs.get(rest.slice(bar + 1));
        return d ? majorityLayerOf(d.files) : null;
      }
      return null;
    };
    const la = resolveLayer(e.data.source);
    const lb = resolveLayer(e.data.target);
    if (la && lb && la !== lb) {
      e.data.crossLayer = true;
      if (violPairs.has(`${la}\t${lb}`)) e.data.viol = true;
    }
  }
  if (ui.archOnly) {
    for (const [id, e] of [...edgeMap.entries()]) {
      if (!e.data.viol && !e.data.source.startsWith("c:") && !e.data.target.startsWith("c:")) edgeMap.delete(id);
    }
  }

  // トップレベル配置
  const placements = new Map();
  const collapsed = cvs.filter((x) => !x.expanded);
  const expandedCv = cvs.filter((x) => x.expanded);
  const flatLanes = ui.layerLanes && !ui.stagedExpand;
  if (expandedCv.length === 0) {
    let x = 0;
    for (const cv of collapsed) {
      placements.set(cv.c.key, { x, y: 0, w: CARD_W, h: CARD_H });
      x += CARD_W + 90;
    }
  } else if (flatLanes) {
    // 全展開: クラスタを縦に積み、パンで辿る
    let y = 0;
    for (const cv of collapsed) {
      placements.set(cv.c.key, { x: 0, y, w: CARD_W, h: CARD_H });
      y += CARD_H + 40;
    }
    for (const cv of expandedCv) {
      const l = layouts.get(cv.c.key);
      placements.set(cv.c.key, { x: collapsed.length ? CARD_W + 80 : 0, y, w: l.w, h: l.h });
      y += l.h + 90;
    }
  } else {
    let y = 0;
    for (const cv of collapsed) {
      placements.set(cv.c.key, { x: 0, y, w: CARD_W, h: CARD_H });
      y += CARD_H + 40;
    }
    let x = collapsed.length ? CARD_W + 130 : 0;
    for (const cv of expandedCv) {
      const l = layouts.get(cv.c.key);
      placements.set(cv.c.key, { x, y: 0, w: l.w, h: l.h });
      x += l.w + 130;
    }
  }

  const elements = [];
  const stat = { cards: 0, dirs: 0, files: 0, frames: 0 };
  const issueBreak = (issues) => {
    const cnt = {};
    for (const is of issues) if (ui.kinds[is.kind]) cnt[is.kind] = (cnt[is.kind] || 0) + 1;
    return cnt;
  };

  for (const cv of cvs) {
    const p = placements.get(cv.c.key);
    const color = cv.c.color;
    if (!cv.expanded) {
      const cnt = issueBreak(cv.c.issues);
      const total = Object.values(cnt).reduce((a, b) => a + b, 0);
      const breakdown = KINDS.filter((k) => cnt[k.key]).map((k) => `${k.label}${cnt[k.key]}`).join("・");
      const crossOut = [...edgeMap.values()].filter((e) => e.data.cross && (e.data.source === `c:${cv.c.key}` || e.data.target === `c:${cv.c.key}`)).reduce((a, e) => a + e.data.weight, 0);
      const label = `${cv.c.key}\n${cv.vfiles.length}ファイル・${cv.dirs.size}ディレクトリ\n問題 ${total}件${breakdown ? `\n(${breakdown})` : ""}\nクラスタ間依存 ${crossOut}本`;
      elements.push({
        group: "nodes", selectable: true, grabbable: false,
        data: { id: `c:${cv.c.key}`, kind: "cluster", ckey: cv.c.key, label, w: CARD_W, h: CARD_H, fill: color, border: color, bw: 4, path: cv.c.key },
        position: { x: p.x + CARD_W / 2, y: p.y + CARD_H / 2 },
      });
      stat.cards++;
      continue;
    }
    const l = layouts.get(cv.c.key);
    const fid = `cf:${cv.c.key}`;
    elements.push({
      group: "nodes", selectable: false, grabbable: false, classes: "frame cframe",
      data: { id: fid, kind: "clusterframe", ckey: cv.c.key, label: l.label, w: l.w, h: l.h, fill: color, border: color, bw: 3, fs: 34, lm: 44, path: cv.c.key },
      position: { x: p.x + l.w / 2, y: p.y + l.h / 2 },
    });
    stat.frames++;

    if (l.mode === "lanes") {
      let ly = p.y + CL_HEADER;
      for (const lane of l.lanes) {
        const laneId = `lane:${cv.c.key}|${lane.key}`;
        const fill = lane.info.color || "#64748b";
        const header = lane.header ?? l.LANE_HEADER;
        const padY = lane.padY ?? l.LANE_PAD_Y;
        const padX = lane.padX ?? l.LANE_PAD_X;
        const compact = !!lane.compact;
        elements.push({
          group: "nodes", selectable: false, grabbable: false,
          classes: compact ? "frame laneframe lane-compact" : "frame laneframe",
          data: {
            id: laneId, kind: "laneframe", ckey: cv.c.key, layer: lane.key,
            label: compact ? `${lane.key} · ${lane.items.length}` : `${lane.key} · ${lane.items.length}`,
            w: lane.w, h: lane.h, fill, border: fill, bw: compact ? 1 : 2,
            fs: compact ? 14 : 20, lm: compact ? 16 : 26, path: lane.key,
          },
          position: { x: p.x + CL_PAD + lane.w / 2, y: ly + lane.h / 2 },
        });
        stat.frames++;
        const ox = p.x + CL_PAD + padX + (lane.w - padX * 2 - lane.packed.w) / 2;
        const oy = ly + header + padY;
        for (const it of lane.items) {
          const ip = lane.packed.pos.get(it.id);
          if (it.kind === "dir") {
            elements.push({
              group: "nodes", selectable: true, grabbable: false,
              data: {
                id: it.id, kind: "dir", ckey: cv.c.key, unit: it.unit, label: it.label,
                w: it.w, h: it.h, frame: laneId,
                fill: "#2c3e50", border: it.tk ? it.tk.color : fill, bw: it.tk ? 6 : 2,
                path: it.fullPath || (it.unit === "." ? "(root)" : it.unit), layer: lane.key,
              },
              position: { x: ox + ip.x, y: oy + ip.y },
            });
            stat.dirs++;
          } else if (it.kind === "group") {
            const gl = lane.groupLayouts.get(it.gkey);
            elements.push({
              group: "nodes", selectable: false, grabbable: false, classes: "frame dframe",
              data: {
                id: it.id, kind: "dirframe", ckey: cv.c.key, unit: it.gkey, units: gl.units || [],
                label: gl.label, w: gl.w, h: gl.h, frame: laneId, fill: "#1e293b", border: "#94a3b8",
                bw: 2, fs: 16, lm: 22, path: it.gkey, layer: lane.key,
              },
              position: { x: ox + ip.x, y: oy + ip.y },
            });
            stat.frames++;
            const fx = ox + ip.x - gl.w / 2 + l.GROUP_PAD + gl.ox;
            const fy = oy + ip.y - gl.h / 2 + l.GROUP_HEADER;
            for (const n of gl.nodes) {
              const f = m.files.get(n.id);
              const pp = gl.L.pos.get(n.id);
              const tkf = topKind([f]);
              const important = f.deg >= IMPORTANT_DEGREE || (tkf && tkf.prio >= 4);
              elements.push({
                group: "nodes", selectable: true, grabbable: false, classes: important ? "imp" : "",
                data: {
                  id: f.id, kind: "file", label: n.label || f.name, w: n.size, h: n.size, frame: it.id, cell: n.w,
                  fill: LANG_COLOR[f.lang] || LANG_COLOR.unknown, border: tkf ? tkf.color : "#0f1419", bw: tkf ? 5 : 1,
                  path: f.path, ckey: f.cluster, layer: f.layer,
                },
                position: { x: fx + pp.x, y: fy + pp.y - 13 },
              });
              stat.files++;
            }
          }
        }
        ly += lane.h + l.LANE_GAP;
      }
      continue;
    }

    const ox = p.x + CL_PAD + (l.ox || 0);
    const oy = p.y + CL_HEADER;
    for (const [unit, files] of cv.dirs) {
      const dl = l.dirLayouts.get(unit);
      const pos = l.L2.pos.get(unit);
      const dirInfo = cv.c.dirs.get(unit);
      if (!dl) {
        const np = files.filter(isProblem).length;
        const tk = topKind(files);
        const nameLine = dirInfo.label || unit;
        const label = `${nameLine}\n${files.length}ファイル${np ? `・問題${np}` : ""}`;
        const dw = Math.max(DIR_W, Math.ceil(estWidth(nameLine, 14) + 36));
        elements.push({
          group: "nodes", selectable: true, grabbable: false,
          data: {
            id: `d:${cv.c.key}|${unit}`, kind: "dir", ckey: cv.c.key, unit, label, w: dw, h: DIR_H, frame: fid,
            fill: "#2c3e50", border: tk ? tk.color : color, bw: tk ? 6 : 2, path: unit === "." ? "(root)" : unit,
          },
          position: { x: ox + pos.x, y: oy + pos.y },
        });
        stat.dirs++;
      } else {
        const dfid = `df:${cv.c.key}|${unit}`;
        const tk = topKind(files);
        elements.push({
          group: "nodes", selectable: false, grabbable: false, classes: "frame dframe",
          data: { id: dfid, kind: "dirframe", ckey: cv.c.key, unit, label: dl.label, w: dl.w, h: dl.h, frame: fid, fill: "#2c3e50", border: tk ? tk.color : "#6f8ba8", bw: 2, fs: 20, lm: 26, path: unit },
          position: { x: ox + pos.x, y: oy + pos.y },
        });
        stat.frames++;
        const fx = ox + pos.x - dl.w / 2 + DIR_PAD + dl.ox;
        const fy = oy + pos.y - dl.h / 2 + DIR_HEADER;
        for (const n of dl.nodes) {
          const f = m.files.get(n.id);
          const pp = dl.L.pos.get(n.id);
          const tkf = topKind([f]);
          const important = f.deg >= IMPORTANT_DEGREE || (tkf && tkf.prio >= 4);
          elements.push({
            group: "nodes", selectable: true, grabbable: false, classes: important ? "imp" : "",
            data: {
              id: f.id, kind: "file", label: f.name, w: n.size, h: n.size, frame: dfid, cell: Math.max(n.w, estWidth(f.name, 12) + 16),
              fill: LANG_COLOR[f.lang] || LANG_COLOR.unknown, border: tkf ? tkf.color : "#0f1419", bw: tkf ? 5 : 1,
              path: f.path, ckey: f.cluster,
            },
            position: { x: fx + pp.x, y: fy + pp.y - 17 + 0 },
          });
          stat.files++;
        }
      }
    }
  }
  for (const e of edgeMap.values()) {
    const isCard = e.data.source.startsWith("c:") || e.data.target.startsWith("c:");
    e.data.card = isCard;
    elements.push(e);
  }
  const leaf = stat.cards + stat.dirs + stat.files;
  return { elements, stat, leaf, edges: edgeMap.size, crossTotal, visFiles: visSet.size, vedges: vedges.length, placements, layouts };
}

/* ---------------- 描画 ---------------- */

function styleSheet() {
  return [
    {
      selector: "node",
      style: {
        "background-color": "data(fill)", "border-color": "data(border)", "border-width": "data(bw)",
        width: "data(w)", height: "data(h)", color: "#e7eef7", "font-size": 13,
        "font-family": '"Segoe UI","Yu Gothic UI","Meiryo",sans-serif',
        "z-index-compare": "manual", "z-index": 10, "text-outline-color": "#0f1419", "text-outline-width": 2,
        "min-zoomed-font-size": 6, "overlay-opacity": 0,
      },
    },
    {
      selector: "node.frame",
      style: {
        shape: "round-rectangle", "background-opacity": 0.07, "border-style": "dashed", label: "data(label)",
        color: "data(border)", "font-size": "data(fs)", "font-weight": "bold", "text-valign": "top", "text-halign": "center",
        "text-margin-y": "data(lm)", "text-wrap": "none", "text-outline-width": 0, "z-index": 1, "min-zoomed-font-size": 0,
      },
    },
    { selector: "node.dframe", style: { "background-opacity": 0.35, "z-index": 2, "border-width": "data(bw)" } },
    {
      selector: "node.laneframe",
      style: {
        "background-opacity": 0.14, "border-style": "solid", "z-index": 1,
        "font-size": 22, "font-weight": "bold", color: "data(border)",
      },
    },
    {
      selector: "node.lane-compact",
      style: {
        "background-opacity": 0.07, "border-opacity": 0.45, "font-size": 13, "font-weight": 600,
      },
    },
    {
      selector: 'node[kind = "cluster"]',
      style: {
        shape: "round-rectangle", "background-opacity": 0.22, label: "data(label)", "font-size": 28, "font-weight": "bold",
        "text-valign": "center", "text-halign": "center", "text-wrap": "wrap", "text-max-width": CARD_W - 30, "line-height": 1.35,
        color: "#ffffff", "min-zoomed-font-size": 0,
      },
    },
    {
      selector: 'node[kind = "dir"]',
      style: {
        shape: "round-rectangle", label: "data(label)", "font-size": 14, "text-valign": "center", "text-halign": "center",
        "text-wrap": "wrap", "text-max-width": 420, "line-height": 1.2, "min-zoomed-font-size": 4,
      },
    },
    {
      selector: 'node[kind = "file"]',
      style: {
        shape: "ellipse", label: "", "text-valign": "bottom", "text-halign": "center", "text-margin-y": 4, "text-wrap": "wrap",
        "text-max-width": "data(cell)", "min-zoomed-font-size": 6, "font-size": 12,
      },
    },
    { selector: "node.lbl", style: { label: "data(label)" } },
    { selector: "node.imp", style: { label: "data(label)", "font-size": 13, "min-zoomed-font-size": 6 } },
    {
      selector: "edge",
      style: {
        width: 1.1, "curve-style": "bezier", "line-color": EDGE_COLOR, "target-arrow-color": EDGE_COLOR, "target-arrow-shape": "triangle",
        "arrow-scale": 0.85, opacity: 0.12, "z-index-compare": "manual", "z-index": 5,
        "font-size": 14, color: "#ffe2cf", "text-background-color": "#0f1419", "text-background-opacity": 0.85, "text-background-padding": 3,
      },
    },
    { selector: "edge[weight > 1]", style: { width: "mapData(weight, 1, 30, 1.4, 4)", opacity: 0.18 } },
    { selector: "edge[?cross]", style: { "line-color": CROSS_EDGE_COLOR, "target-arrow-color": CROSS_EDGE_COLOR, opacity: 0.35 } },
    {
      selector: "edge[?crossLayer]",
      style: { "curve-style": "taxi", "taxi-direction": "vertical", "taxi-turn": "40%" },
    },
    {
      selector: "edge[?viol]",
      style: {
        "line-color": "#ff5252", "target-arrow-color": "#ff5252", opacity: 0.4,
        "curve-style": "taxi", "taxi-direction": "vertical", "taxi-turn": "50%", width: 2,
      },
    },
    {
      selector: "edge.viol-focus",
      style: {
        "line-color": "#ff5252", "target-arrow-color": "#ff5252", opacity: 0.95,
        width: 3.6, "arrow-scale": 1.35, "z-index": 28,
        label: (e) => (e.data("weight") > 1 ? `${e.data("weight")}` : ""),
        "font-size": 16, color: "#ffcdd2",
      },
    },
    { selector: "node.viol-end", style: { "border-color": "#ff8a80", "border-width": 6, "z-index": 36, opacity: 1 } },
    { selector: "node.arch-dim", style: { opacity: 0.18 } },
    { selector: "edge.arch-dim", style: { opacity: 0.04 } },
    {
      selector: "edge.hover-hl",
      style: {
        "line-color": "#7ee0d0", "target-arrow-color": "#7ee0d0", opacity: 0.95,
        width: 3.2, "arrow-scale": 1.3, "z-index": 32,
      },
    },
    { selector: "node.hover-end", style: { "border-color": "#7ee0d0", "border-width": 4, "z-index": 38 } },
    { selector: "edge.hover-dim", style: { opacity: 0.04 } },
    { selector: "node.hover-dim", style: { opacity: 0.35 } },
    {
      selector: 'node[kind = "layer"], node[kind = "feature"], node[kind = "layer-feature"]',
      style: {
        shape: "round-rectangle", label: "data(label)", "text-valign": "center", "text-halign": "center",
        "text-wrap": "wrap", "text-max-width": 880, "font-size": 22, "font-weight": "bold", "min-zoomed-font-size": 0,
        "background-opacity": 0.55, color: "#fff",
      },
    },
    {
      selector: 'node[kind = "feature"]',
      style: { "text-max-width": 230, "font-size": 18, "background-opacity": 0.85 },
    },
    {
      selector: 'node[kind = "layer-feature"]',
      style: { "text-max-width": 180, "font-size": 16, "background-opacity": 0.9 },
    },
    {
      selector: "edge[?card]",
      style: { width: "mapData(weight, 1, 60, 5, 18)", opacity: 0.8, label: (e) => `${e.data("weight")}本`, "font-size": 22, "arrow-scale": 1.4 },
    },
    { selector: "edge.dim", style: { opacity: 0.04 } },
    { selector: "node.dim", style: { opacity: 0.3 } },
    {
      selector: "edge.hl",
      style: { "line-color": ACCENT, "target-arrow-color": ACCENT, opacity: 0.95, width: 2.6, "z-index": 30, label: (e) => (e.data("weight") > 1 ? String(e.data("weight")) : "") },
    },
    { selector: "node.sel", style: { "border-color": "#ffffff", "border-width": 5, "z-index": 40 } },
    { selector: "node.search-hit", style: { "border-color": "#ffe082", "border-width": 6 } },
  ];
}

function ensureCy() {
  if (state.cy) return state.cy;
  if (typeof cytoscape !== "function") {
    setStatus("Cytoscape の読み込みに失敗しました");
    return null;
  }
  const cy = cytoscape({
    container: el.graph, elements: [], style: styleSheet(), layout: { name: "preset" },
    minZoom: 0.02, maxZoom: 4, wheelSensitivity: 0.25, autoungrabify: true, boxSelectionEnabled: false,
  });
  state.cy = cy;
  cy.on("zoom", () => {
    updateLabels(false);
    updateCounter();
  });
  cy.on("tap", "node", (evt) => {
    const n = evt.target;
    const kind = n.data("kind");
    const now = Date.now();
    if (kind === "cluster") return expandCluster(n.data("ckey"));
    if (kind === "dir") return toggleDir(n.data("ckey"), n.data("unit"), true);
    if (kind === "file") return selectNodes([n.id()], "neighborhood");
    if (kind === "layer") return toggleLayerBand(n.data("layer"));
    if (kind === "layer-feature") return toggleLayerFeature(n.data("layer"), n.data("feature"));
    if (kind === "feature") return toggleFeatureCard(n.data("featureKey"));
    // 枠: ダブルクリックで折りたたみ
    if (kind === "clusterframe" || kind === "dirframe" || kind === "layerframe" || kind === "featureframe") {
      if (state.lastTap.id === n.id() && now - state.lastTap.t < 420) {
        state.lastTap = { id: null, t: 0 };
        if (kind === "clusterframe") collapseCluster(n.data("ckey"));
        else if (kind === "dirframe") {
          const units = n.data("units");
          if (Array.isArray(units) && units.length) collapseDirs(n.data("ckey"), units);
          else toggleDir(n.data("ckey"), n.data("unit"), false);
        } else if (kind === "layerframe") toggleLayerBand(n.data("layer"), false);
        else if (kind === "featureframe") toggleFeatureCard(n.data("featureKey"), false);
      } else state.lastTap = { id: n.id(), t: now };
    }
  });
  cy.on("tap", (evt) => {
    if (evt.target === cy) clearSelection();
  });
  cy.on("mouseover", "node", (evt) => {
    const n = evt.target;
    if (n.hasClass("frame")) return;
    const k = n.data("kind");
    const p = n.data("path");
    el.tip.textContent = k === "cluster" ? `${n.data("ckey")}(クリックで展開)` : k === "dir" ? `${p}(クリックでファイル表示)` : p;
    el.tip.classList.remove("hidden");
    if (!state.sel.ids.length) applyHoverHighlight(n);
  });
  cy.on("mousemove", "node", (evt) => {
    const r = el.graph.getBoundingClientRect();
    el.tip.style.left = `${evt.originalEvent.clientX - r.left + 14}px`;
    el.tip.style.top = `${evt.originalEvent.clientY - r.top + 14}px`;
  });
  cy.on("mouseout", "node", () => {
    el.tip.classList.add("hidden");
    clearHoverHighlight();
  });
  return cy;
}

function updateLabels(force) {
  const cy = state.cy;
  if (!cy) return;
  const z = cy.zoom();
  const fileOn = z >= LABEL_ZOOM;
  const key = String(fileOn);
  if (!force && key === state.labelsOn) return;
  state.labelsOn = key;
  cy.batch(() => {
    cy.nodes('[kind = "file"]').toggleClass("lbl", fileOn);
  });
}

/** 段階展開OFF時: 表示中クラスタをファイル単位まで全展開 */
function applyFlatExpansion() {
  const ui = state.ui;
  const m = state.model;
  if (!m || ui.stagedExpand || !ui.layerLanes || ui.viewMode !== "cluster") return false;
  ui.noLimit = true;
  let changed = false;
  // 非表示クラスタは展開セットから外す
  for (const k of [...ui.expandedClusters]) {
    if (ui.hiddenClusters.has(k)) {
      ui.expandedClusters.delete(k);
      for (const d of [...ui.expandedDirs]) if (d.startsWith(`${k}|`)) ui.expandedDirs.delete(d);
      changed = true;
    }
  }
  for (const c of m.clusters) {
    if (ui.hiddenClusters.has(c.key) || !c.files.length) continue;
    if (!ui.expandedClusters.has(c.key)) {
      ui.expandedClusters.add(c.key);
      changed = true;
    }
    for (const u of c.dirs.keys()) {
      const k = `${c.key}|${u}`;
      if (!ui.expandedDirs.has(k)) {
        ui.expandedDirs.add(k);
        changed = true;
      }
    }
  }
  return changed;
}

function updateCounter() {
  const v = state.lastView;
  if (!v || !state.cy) return;
  const over = v.leaf > NODE_BUDGET && !state.ui.noLimit;
  el.counter.classList.toggle("warn", v.leaf > NODE_BUDGET);
  el.counter.innerHTML = `表示中: <b>ノード ${v.leaf}</b>(クラスタ ${v.stat.cards}・ディレクトリ ${v.stat.dirs}・ファイル ${v.stat.files}) / <b>エッジ ${v.edges}</b> / 枠 ${v.stat.frames} · 目安上限 ${NODE_BUDGET}${v.leaf > NODE_BUDGET ? (over ? "(超過)" : "(超過・解除中)") : ""} · ズーム ${Math.round(state.cy.zoom() * 100)}%${state.ui.hideIsolated ? " · 孤立ノード非表示" : ""}${state.ui.problemOnly ? " · 問題のみ" : ""}${state.ui.archOnly ? " · 違反のみ" : ""}`;
}

/**
 * 読める縮尺を下限にした fit。どの操作経路から呼んでも FIT_MIN_ZOOM 未満にしない。
 * 収まらない場合は対象の左上(最上位レーン側)を表示し、残りはパンで辿る。
 */
function fitReadable(eles, opts = {}) {
  const cy = state.cy;
  if (!cy) return;
  const pad = opts.pad ?? 48;
  const maxZoom = opts.maxZoom ?? 1.2;
  const minZoom = opts.minZoom ?? FIT_MIN_ZOOM;
  const preferTopLeft = opts.preferTop !== false;
  let target = eles && typeof eles.nonempty === "function" && eles.nonempty() ? eles : null;
  if (!target || target.empty()) target = cy.elements();
  if (!target || target.empty()) return;

  const bb = target.boundingBox({ includeLabels: false });
  if (!(bb.w > 0 && bb.h > 0) || !Number.isFinite(bb.w) || !Number.isFinite(bb.h)) return;

  const vw = Math.max(1, cy.width());
  const vh = Math.max(1, cy.height());
  let z = Math.min((vw - pad * 2) / bb.w, (vh - pad * 2) / bb.h);
  if (!Number.isFinite(z) || z <= 0) z = minZoom;
  z = Math.min(z, maxZoom);
  const clipped = z < minZoom;
  if (clipped) z = minZoom;

  // アニメーション中の上書きを防ぐ
  if (typeof cy.stop === "function") cy.stop();
  cy.zoom(z);
  // 左上基準（最上位レーンが見える）。横にはみ出す場合も左端揃え。
  if (clipped || preferTopLeft) {
    const panX = pad - bb.x1 * z;
    const panY = pad - bb.y1 * z;
    cy.pan({ x: panX, y: panY });
  } else {
    cy.center(target);
  }
  // 最終防衛: 何らかの副作用で下回っていたら戻す
  if (cy.zoom() < minZoom - 1e-6) cy.zoom(minZoom);

  updateLabels(true);
  updateCounter();
}

/** 表示中コンテンツを左上基準で fit（クラスタ絞り込み後など共通入口） */
function fitCurrentView(opts = {}) {
  const cy = state.cy;
  if (!cy) return;
  fitReadable(cy.elements(), { preferTop: true, ...opts });
}

function fitExpandedCluster(ckey) {
  const cy = state.cy;
  if (!cy) return;
  const frame = cy.getElementById(`cf:${ckey}`);
  if (frame.empty()) {
    fitCurrentView();
    return;
  }
  // 巨大クラスタでも下限を守る。上位レーンから見せる。
  fitReadable(frame, { preferTop: true });
}

function render(opts = {}) {
  if (!state.model) return;
  applyFlatExpansion();
  const cy = ensureCy();
  if (!cy) return;
  const view = buildView();
  state.lastView = view;
  cy.batch(() => {
    cy.elements().remove();
    cy.add(view.elements);
  });
  updateLabels(true);
  applyHighlight();
  updateCounter();
  renderClusters();
  renderLayerMatrix();
  renderExpanded();
  renderIssues();
  if (opts.fitCluster) fitExpandedCluster(opts.fitCluster);
  else if (opts.fitTo) fitToIds(opts.fitTo);
  else if (opts.fit !== false) fitCurrentView();
  cy.resize();
  // resize 後も下限を再適用（コンテナ寸法が変わった場合のズレ防止）
  if (opts.fitCluster || opts.fitTo || opts.fit !== false) {
    if (cy.zoom() < FIT_MIN_ZOOM - 1e-6) cy.zoom(FIT_MIN_ZOOM);
  }
}

function fitToIds(ids, maxZoom = 1.2) {
  const cy = state.cy;
  const eles = cy.nodes().filter((n) => ids.includes(n.id()));
  if (eles.empty()) return;
  fitReadable(eles, { preferTop: true, maxZoom, pad: 50 });
}

/* ---------------- 操作 ---------------- */

function currentLeaf() {
  return state.lastView ? state.lastView.leaf : 0;
}

function dirVisibleFiles(cluster, unit) {
  const ui = state.ui;
  return state.model.byKey.get(cluster).dirs.get(unit).files.filter((f) => (!ui.hideIsolated || f.deg > 0) && (!ui.problemOnly || isProblem(f)));
}

function expandCluster(key) {
  const ui = state.ui;
  // 段階展開+層レーン時のみ、見やすさのため1クラスタに絞る
  if (ui.stagedExpand && ui.layerLanes && ui.viewMode === "cluster") {
    for (const k of [...ui.expandedClusters]) {
      if (k !== key) {
        ui.expandedClusters.delete(k);
        for (const d of [...ui.expandedDirs]) if (d.startsWith(`${k}|`)) ui.expandedDirs.delete(d);
      }
    }
  }
  ui.expandedClusters.add(key);
  if (!ui.stagedExpand || ui.unit === "file") {
    const c = state.model.byKey.get(key);
    const files = [...c.dirs.keys()].reduce((a, u) => a + dirVisibleFiles(key, u).length, 0);
    const others = state.lastView ? state.lastView.leaf - 1 : 0;
    if (!ui.stagedExpand || ui.noLimit || others + files <= NODE_BUDGET) {
      for (const u of c.dirs.keys()) ui.expandedDirs.add(`${key}|${u}`);
    } else {
      setStatus(`ファイル単位の全展開は約${files}ノードで目安${NODE_BUDGET}を超えるため、ディレクトリ単位で表示します(ディレクトリをクリックでファイル表示)`);
    }
  }
  clearSelectionState();
  render({ fitCluster: key });
  showClusterInfo(key);
}

function collapseCluster(key) {
  const ui = state.ui;
  ui.expandedClusters.delete(key);
  for (const k of [...ui.expandedDirs]) if (k.startsWith(`${key}|`)) ui.expandedDirs.delete(k);
  clearSelectionState();
  render();
}

function toggleDir(cluster, unit, wantExpand) {
  const ui = state.ui;
  const k = `${cluster}|${unit}`;
  if (wantExpand && !ui.expandedDirs.has(k)) {
    const n = dirVisibleFiles(cluster, unit).length;
    const after = currentLeaf() - 1 + n;
    if (after > NODE_BUDGET && !ui.noLimit) {
      setStatus(`「${unit}」を展開すると約${after}ノードになり目安(${NODE_BUDGET})を超えます。他のディレクトリを閉じるか、サイドバーの「上限を解除」をONにしてください。`);
      el.counter.classList.add("warn");
      return;
    }
    ui.expandedDirs.add(k);
    clearSelectionState();
    render({ fit: false, fitCluster: ui.layerLanes ? cluster : undefined, fitTo: ui.layerLanes ? undefined : [`df:${k}`] });
    showDirInfo(cluster, unit);
  } else if (!wantExpand && ui.expandedDirs.has(k)) {
    ui.expandedDirs.delete(k);
    clearSelectionState();
    render({ fit: false });
  }
}

/** 層レーンの feature グループ枠から、元ディレクトリ群をまとめて折りたたむ */
function collapseDirs(cluster, units) {
  const ui = state.ui;
  let changed = false;
  for (const unit of units) {
    const k = `${cluster}|${unit}`;
    if (ui.expandedDirs.has(k)) {
      ui.expandedDirs.delete(k);
      changed = true;
    }
  }
  if (!changed) return;
  clearSelectionState();
  render({ fit: false, fitTo: ui.layerLanes ? [`cf:${cluster}`] : undefined });
}

function collapseAll() {
  state.ui.expandedClusters.clear();
  state.ui.expandedDirs.clear();
  clearSelectionState();
  render();
}

/** 指定ファイルが表示されるようクラスタ/ディレクトリ展開とフィルタを調整する */
function revealFiles(ids) {
  const ui = state.ui;
  for (const id of ids) {
    const f = state.model.files.get(id);
    if (!f) continue;
    ui.hiddenClusters.delete(f.cluster);
    ui.expandedClusters.add(f.cluster);
    ui.expandedDirs.add(dkey(f));
    if (f.deg === 0 && ui.hideIsolated) ui.hideIsolated = false;
    if (ui.problemOnly && !isProblem(f)) ui.problemOnly = false;
  }
  syncFilterUi();
}

/* ---------------- 選択 / ハイライト ---------------- */

function clearSelectionState() {
  state.sel = { ids: [], mode: "none" };
}

function clearHoverHighlight() {
  const cy = state.cy;
  if (!cy) return;
  cy.elements().removeClass("hover-hl hover-dim hover-end");
}

/** ホバー中ノードに接続する辺だけ強調 */
function applyHoverHighlight(node) {
  const cy = state.cy;
  if (!cy || !node || node.empty?.()) return;
  clearHoverHighlight();
  if (node.hasClass("frame")) return;
  const nb = node.closedNeighborhood();
  const edges = nb.edges();
  if (edges.empty()) return;
  cy.edges().not(edges).addClass("hover-dim");
  cy.nodes().filter((n) => !n.hasClass("frame")).not(nb.nodes()).addClass("hover-dim");
  edges.addClass("hover-hl");
  nb.nodes().filter((n) => !n.hasClass("frame")).addClass("hover-end");
}

function applyHighlight() {
  const cy = state.cy;
  if (!cy) return;
  clearHoverHighlight();
  cy.elements().removeClass("dim hl sel viol-focus viol-end arch-dim");
  const ids = state.sel.ids.filter((id) => !cy.getElementById(id).empty());
  if (ids.length) {
    const sel = cy.nodes().filter((n) => ids.includes(n.id()));
    const nb = state.sel.mode === "neighborhood" ? sel.closedNeighborhood() : sel.union(sel.edgesWith(sel));
    cy.elements().not(nb).not(".frame").addClass("dim");
    nb.edges().addClass("hl");
    sel.addClass("sel");
    return;
  }
  // 違反のみ: 端点を強調し、違反エッジを太く追いやすくする
  if (state.ui.archOnly) {
    const viol = cy.edges().filter((e) => e.data("viol"));
    if (viol.nonempty()) {
      const ends = viol.connectedNodes().filter((n) => !n.hasClass("frame"));
      cy.nodes().filter((n) => !n.hasClass("frame")).not(ends).addClass("arch-dim");
      cy.edges().not(viol).addClass("arch-dim");
      viol.addClass("viol-focus");
      ends.addClass("viol-end");
    }
  }
}

function selectNodes(ids, mode, panel = true) {
  state.sel = { ids, mode };
  applyHighlight();
  if (panel && ids.length === 1) showNodeInfo(ids[0]);
}

function clearSelection() {
  clearSelectionState();
  applyHighlight();
  el.selection.textContent = "ノードをクリックすると依存元・依存先をハイライトします。";
}

function jumpLink(id, text, cls = "") {
  return `<a href="#" class="jump ${cls}" data-jump="${escapeHtml(id)}">${escapeHtml(text)}</a>`;
}

function bindJumps() {
  el.selection.querySelectorAll("a.jump").forEach((a) =>
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      jumpToFile(a.dataset.jump);
    }),
  );
}

function issueBadges(f) {
  return [...f.issues.keys()]
    .map((k) => `<span class="badge" style="border-color:${KIND_BY_KEY[k].color};color:${KIND_BY_KEY[k].color}">${KIND_BY_KEY[k].label}</span>`)
    .join(" ");
}

function showNodeInfo(id) {
  const f = state.model.files.get(id);
  if (!f) return;
  const list = (set) => [...set].slice(0, 40).map((x) => jumpLink(x, state.model.files.get(x).path)).join("<br>") + (set.size > 40 ? `<br><span class="muted">…他${set.size - 40}件</span>` : "");
  el.selection.innerHTML = `
    <strong>${escapeHtml(f.path)}</strong>
    <div class="muted" style="margin-top:6px">LOC ${f.loc} · ${escapeHtml(f.lang)} · ${escapeHtml(f.cluster)} · 次数 ${f.deg}(入 ${f.ins.size} / 出 ${f.outs.size})</div>
    <div style="margin-top:6px"><span class="muted">層</span> ${escapeHtml(f.layer)} · <span class="muted">機能</span> ${escapeHtml(f.feature)}</div>
    <div class="muted" style="margin-top:4px;font-size:0.78rem">${escapeHtml(f.layerReason || "")}</div>
    <div style="margin-top:6px">${issueBadges(f) || '<span class="muted">指摘なし</span>'}</div>
    <div style="margin-top:8px"><span class="muted">依存元 (${f.ins.size})</span><br>${list(f.ins) || "—"}</div>
    <div style="margin-top:8px"><span class="muted">依存先 (${f.outs.size})</span><br>${list(f.outs) || "—"}</div>`;
  bindJumps();
}

function showDirInfo(cluster, unit) {
  const d = state.model.byKey.get(cluster).dirs.get(unit);
  const np = d.files.filter(isProblem).length;
  el.selection.innerHTML = `<strong>${escapeHtml(unit === "." ? "(root)" : unit)}</strong>
    <div class="muted" style="margin-top:6px">${escapeHtml(cluster)} · ${d.files.length}ファイル · LOC ${d.loc} · 問題ファイル ${np}</div>
    <div style="margin-top:8px" class="muted">ファイルを表示中。枠をダブルクリックで折りたたみ。</div>`;
}

function showClusterInfo(key) {
  const c = state.model.byKey.get(key);
  el.selection.innerHTML = `<strong>${escapeHtml(key)}</strong>
    <div class="muted" style="margin-top:6px">${c.files.length}ファイル · ${c.dirs.size}ディレクトリ · 指摘 ${c.issues.length}件</div>
    <div style="margin-top:8px" class="muted">ディレクトリをクリックすると、その中のファイルを表示します。枠をダブルクリックでクラスタを折りたたみ。</div>`;
}

function focusIds(ids) {
  const cy = state.cy;
  const present = ids.filter((id) => !cy.getElementById(id).empty());
  if (present.length) fitToIds(present, 1.3);
}

function jumpToFile(id) {
  if (!state.model.files.has(id)) return;
  revealFiles([id]);
  render({ fit: false });
  selectNodes([id], "neighborhood");
  focusIds([id]);
}

function jumpToDir(cluster, unit) {
  const ui = state.ui;
  ui.hiddenClusters.delete(cluster);
  ui.expandedClusters.add(cluster);
  const d = state.model.byKey.get(cluster).dirs.get(unit);
  if (d.files.every((f) => f.deg === 0)) ui.hideIsolated = false;
  ui.problemOnly = ui.problemOnly && d.files.some(isProblem);
  syncFilterUi();
  render({ fit: false });
  focusIds([`d:${cluster}|${unit}`]);
  selectNodes([`d:${cluster}|${unit}`], "neighborhood", false);
  showDirInfo(cluster, unit);
}

/* ---------------- サイドバー ---------------- */

function renderClusters() {
  const m = state.model;
  if (!m) return;
  const ui = state.ui;
  el.clusters.innerHTML = m.clusters
    .map((c) => {
      const hidden = ui.hiddenClusters.has(c.key);
      const exp = ui.expandedClusters.has(c.key);
      const n = c.issues.filter((i) => ui.kinds[i.kind]).length;
      return `<li class="cluster-item ${hidden ? "off" : ""}" data-key="${escapeHtml(c.key)}">
        <label class="cluster-toggle"><input type="checkbox" class="cl-vis" ${hidden ? "" : "checked"} />
          <span class="swatch" style="background:${escapeHtml(c.color)}"></span><span class="cl-name">${escapeHtml(c.key)}</span></label>
        <span class="cl-count">${c.files.length}f · ⚠${n}</span>
        <button type="button" class="chip cl-collapse ${exp ? "active" : ""}">${exp ? "折りたたみ" : "展開"}</button></li>`;
    })
    .join("");
  el.clusterStats.textContent = `クラスタ間依存: ${state.lastView ? state.lastView.crossTotal : 0} 組(オレンジの線)`;
  el.clusters.querySelectorAll(".cluster-item").forEach((item) => {
    const key = item.dataset.key;
    item.querySelector(".cl-vis").addEventListener("change", (ev) => {
      if (ev.target.checked) ui.hiddenClusters.delete(key);
      else ui.hiddenClusters.add(key);
      clearSelectionState();
      render({ fit: true });
    });
    item.querySelector(".cl-collapse").addEventListener("click", () => {
      if (ui.expandedClusters.has(key)) collapseCluster(key);
      else expandCluster(key);
    });
  });
}

function renderExpanded() {
  const ui = state.ui;
  const items = [];
  for (const k of ui.expandedClusters) items.push(`<li data-t="c" data-k="${escapeHtml(k)}"><span>クラスタ ${escapeHtml(k)}</span><button class="chip x">閉じる</button></li>`);
  for (const k of ui.expandedDirs) {
    const [c, u] = k.split("|");
    items.push(`<li data-t="d" data-c="${escapeHtml(c)}" data-u="${escapeHtml(u)}"><span title="${escapeHtml(u)}">${escapeHtml(truncate(u === "." ? "(root)" : u, 34))}</span><button class="chip x">閉じる</button></li>`);
  }
  el.expanded.innerHTML = items.join("") || '<li class="muted">なし(クラスタ概要)</li>';
  el.expanded.querySelectorAll("li[data-t]").forEach((li) =>
    li.querySelector(".x").addEventListener("click", () => {
      if (li.dataset.t === "c") collapseCluster(li.dataset.k);
      else toggleDir(li.dataset.c, li.dataset.u, false);
    }),
  );
}

function renderKinds() {
  const m = state.model;
  const ui = state.ui;
  el.kinds.innerHTML = KINDS.map((k) => {
    const on = ui.kinds[k.key];
    return `<button type="button" class="chip kind ${on ? "active" : ""}" data-k="${k.key}" style="${on ? `border-color:${k.color};color:${k.color}` : ""}">
      <span class="dot" style="background:${k.color}"></span>${k.label} ${m.issueCountByKind[k.key] || 0}</button>`;
  }).join("");
  el.kinds.querySelectorAll(".kind").forEach((b) =>
    b.addEventListener("click", () => {
      ui.kinds[b.dataset.k] = !ui.kinds[b.dataset.k];
      renderKinds();
      clearSelectionState();
      render({ fit: ui.problemOnly });
    }),
  );
}

function syncFilterUi() {
  el.problemOnly.checked = state.ui.problemOnly;
  el.hideIsolated.checked = state.ui.hideIsolated;
  el.noLimit.checked = state.ui.noLimit;
  el.unit.value = state.ui.unit;
  if (el.archOnly) el.archOnly.checked = state.ui.archOnly;
  if (el.layerLanes) el.layerLanes.checked = state.ui.layerLanes;
  if (el.stagedExpand) el.stagedExpand.checked = state.ui.stagedExpand;
  if (el.viewMode) el.viewMode.value = state.ui.viewMode;
}

function renderIssues() {
  const m = state.model;
  if (!m) return;
  const ui = state.ui;
  const issues = state.data.issues.filter((i) => {
    if (!ui.kinds[i.kind]) return false;
    if (ui.archOnly && !isArchViolationIssue(i)) return false;
    return true;
  });
  const CAP = 300;
  el.issues.innerHTML =
    issues
      .slice(0, CAP)
      .map(
        (issue, i) => `
      <li class="issue-item ${issue.severity}" data-i="${i}">
        <div class="kind">${escapeHtml(issue.severity)} · ${escapeHtml(KIND_BY_KEY[issue.kind]?.label || issue.kind)}</div>
        <div class="title">${escapeHtml(issue.title)}</div>
        <div class="reason">${escapeHtml(issue.reason)}</div>
      </li>`,
      )
      .join("") + (issues.length > CAP ? `<li class="muted">…他 ${issues.length - CAP} 件(種類トグルで絞り込み)</li>` : "");
  el.issuesEmpty.classList.toggle("hidden", issues.length > 0);
  el.issues.querySelectorAll(".issue-item").forEach((item) =>
    item.addEventListener("click", () => {
      const issue = issues[Number(item.dataset.i)];
      const ids = issue.locations.filter((id) => m.files.has(id));
      if (!ids.length) return;
      revealFiles(ids);
      render({ fit: false });
      selectNodes(ids, "set", false);
      focusIds(ids);
      el.selection.innerHTML = `<strong>${escapeHtml(issue.title)}</strong><div style="margin-top:8px">${escapeHtml(issue.reason)}</div>
        <div style="margin-top:8px">${ids.map((id) => jumpLink(id, m.files.get(id).path)).join("<br>")}</div>`;
      bindJumps();
    }),
  );
}

function updateSummary() {
  const s = state.data.summary;
  const langs = Object.entries(s.languages || {}).map(([k, v]) => `${k}:${v}`).join(" ");
  const unc = s.unclassifiedRate != null ? ` · 未分類 ${(s.unclassifiedRate * 100).toFixed(0)}%` : "";
  const lv = s.layerViolations?.count != null ? ` · 層違反 ${s.layerViolations.count}` : "";
  el.summary.textContent = `${s.fileCount} ファイル · ${s.edgeCount} 依存 · ${s.issueCount} 指摘${lv}${unc} · ${langs}`;
}

/* ---------------- 検索 ---------------- */

function runSearch() {
  const q = el.search.value.trim().toLowerCase();
  const box = el.searchResults;
  if (!q || !state.model) {
    box.classList.add("hidden");
    state.searchHits = [];
    return;
  }
  const score = (e) => {
    const n = e.name.toLowerCase();
    const p = e.path.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    if (p.includes(q)) return 3;
    return 9;
  };
  const hits = state.model.index
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || (a.e.type === b.e.type ? 0 : a.e.type === "dir" ? -1 : 1))
    .slice(0, 30)
    .map((x) => x.e);
  state.searchHits = hits;
  box.innerHTML = hits.length
    ? hits.map((h, i) => `<li data-i="${i}"><span class="tag">${h.type === "dir" ? "DIR" : "FILE"}</span> <b>${escapeHtml(h.name)}</b><br><span class="muted">${escapeHtml(h.path)}</span></li>`).join("")
    : '<li class="muted">見つかりません</li>';
  box.classList.remove("hidden");
  box.querySelectorAll("li[data-i]").forEach((li) => li.addEventListener("click", () => pickSearch(Number(li.dataset.i))));
}

function pickSearch(i) {
  const h = state.searchHits[i];
  if (!h) return;
  el.searchResults.classList.add("hidden");
  if (h.type === "file") jumpToFile(h.id);
  else jumpToDir(h.cluster, h.unit);
}

/* ---------------- 読み込み / イベント ---------------- */

function updateDownload() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: "application/json" });
  el.download.href = URL.createObjectURL(blob);
}

async function loadAnalysis() {
  setStatus("解析中…");
  try {
    const res = await fetch(`/api/analysis?${new URLSearchParams({ granularity: "file" })}`, { cache: "no-store" });
    if (!res.ok) throw new Error(await res.text());
    state.data = await res.json();
    state.model = buildModel(state.data);
    clearSelectionState();
    updateSummary();
    renderKinds();
    syncFilterUi();
    render();
    updateDownload();
    setStatus(`更新 ${new Date().toLocaleTimeString()} · ${state.data.graph.root}`);
  } catch (err) {
    setStatus(`エラー: ${err.message || err}`);
    el.issuesEmpty.classList.remove("hidden");
    el.issuesEmpty.textContent = "解析に失敗しました。";
  }
}

el.unit.addEventListener("change", () => {
  state.ui.unit = el.unit.value;
  state.ui.expandedDirs.clear();
  const open = [...state.ui.expandedClusters];
  state.ui.expandedClusters.clear();
  clearSelectionState();
  render();
  for (const k of open) expandCluster(k);
});
el.viewMode?.addEventListener("change", () => {
  state.ui.viewMode = el.viewMode.value;
  state.ui.expandedLayers.clear();
  state.ui.expandedLayerFeatures.clear();
  state.ui.expandedFeatures.clear();
  state.ui.matrixPair = null;
  clearSelectionState();
  render();
});
el.archOnly?.addEventListener("change", () => {
  state.ui.archOnly = el.archOnly.checked;
  clearSelectionState();
  render({ fit: true });
});
el.layerLanes?.addEventListener("change", () => {
  state.ui.layerLanes = el.layerLanes.checked;
  clearSelectionState();
  if (!state.ui.stagedExpand && state.ui.layerLanes) applyFlatExpansion();
  render({ fit: true });
});
el.stagedExpand?.addEventListener("change", () => {
  state.ui.stagedExpand = el.stagedExpand.checked;
  if (state.ui.stagedExpand) {
    state.ui.expandedClusters.clear();
    state.ui.expandedDirs.clear();
  } else {
    state.ui.noLimit = true;
    applyFlatExpansion();
  }
  syncFilterUi();
  clearSelectionState();
  render({ fit: true });
});
el.problemOnly.addEventListener("change", () => {
  state.ui.problemOnly = el.problemOnly.checked;
  clearSelectionState();
  render({ fit: true });
});
el.hideIsolated.addEventListener("change", () => {
  state.ui.hideIsolated = el.hideIsolated.checked;
  clearSelectionState();
  render({ fit: true });
});
el.noLimit.addEventListener("change", () => {
  state.ui.noLimit = el.noLimit.checked;
  updateCounter();
});
el.reload.addEventListener("click", async () => {
  setStatus("再解析中…");
  await fetch("/api/reload", { method: "POST" });
  await loadAnalysis();
});
el.fit.addEventListener("click", () => {
  fitCurrentView();
});
el.overview.addEventListener("click", () => {
  if (state.ui.viewMode === "layer") {
    state.ui.expandedLayers.clear();
    state.ui.expandedLayerFeatures.clear();
  } else if (state.ui.viewMode === "feature") {
    state.ui.expandedFeatures.clear();
  } else if (state.ui.stagedExpand) {
    collapseAll();
  } else {
    applyFlatExpansion();
    clearSelectionState();
    render({ fit: true });
    return;
  }
  clearSelectionState();
  render();
});

let searchTimer;
el.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
});
el.search.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    if (!state.searchHits.length) runSearch();
    pickSearch(0);
  } else if (ev.key === "Escape") el.searchResults.classList.add("hidden");
});
document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".search")) el.searchResults.classList.add("hidden");
});

/* ---------------- 層 / 機能ビュー ---------------- */

function fileVis(f) {
  const ui = state.ui;
  return !ui.hiddenClusters.has(f.cluster) && (!ui.hideIsolated || f.deg > 0) && (!ui.problemOnly || isProblem(f));
}

function toggleLayerBand(layer, wantExpand) {
  const ui = state.ui;
  const open = wantExpand !== false && !ui.expandedLayers.has(layer);
  if (open) ui.expandedLayers.add(layer);
  else {
    ui.expandedLayers.delete(layer);
    for (const k of [...ui.expandedLayerFeatures]) if (k.startsWith(`${layer}|`)) ui.expandedLayerFeatures.delete(k);
  }
  clearSelectionState();
  render({ fit: false, fitTo: open ? [`layer:${layer}`] : undefined });
}

function toggleLayerFeature(layer, feature, wantExpand) {
  const key = `${layer}|${feature}`;
  const ui = state.ui;
  ui.expandedLayers.add(layer);
  const open = wantExpand !== false && !ui.expandedLayerFeatures.has(key);
  if (open) {
    if (!ui.noLimit && currentLeaf() >= NODE_BUDGET) {
      setStatus(`表示ノードが ${NODE_BUDGET} を超えるため展開を抑止しました(目安オフで続行可)`);
      return;
    }
    ui.expandedLayerFeatures.add(key);
  } else ui.expandedLayerFeatures.delete(key);
  clearSelectionState();
  render({ fit: false });
}

function toggleFeatureCard(featureKey, wantExpand) {
  const ui = state.ui;
  const open = wantExpand !== false && !ui.expandedFeatures.has(featureKey);
  if (open) ui.expandedFeatures.add(featureKey);
  else ui.expandedFeatures.delete(featureKey);
  clearSelectionState();
  render({ fit: false });
}

function buildLayerView() {
  const m = state.model;
  const ui = state.ui;
  const layers = layerOrderList();
  const violPairs = archViolationPairs();
  const matrix = state.data.summary.layerMatrix || { cells: {} };
  const elements = [];
  const BAND_W = 920;
  const BAND_H = 110;
  const GAP = 36;
  let y = 0;
  const bandPos = new Map();
  const stat = { cards: 0, dirs: 0, files: 0, frames: 0 };

  for (const layer of layers) {
    const files = [...m.files.values()].filter((f) => f.layer === layer.key && fileVis(f));
    const expanded = ui.expandedLayers.has(layer.key);
    const id = `layer:${layer.key}`;
    if (!expanded) {
      const viol = layer.violationsOut || 0;
      const label = `${layer.key}\n${files.length}ファイル · 違反出 ${viol}`;
      elements.push({
        group: "nodes", selectable: true, grabbable: false,
        data: {
          id, kind: "layer", layer: layer.key, label, w: BAND_W, h: BAND_H,
          fill: layer.color || "#64748b", border: viol ? "#ff5252" : "#e7eef7", bw: viol ? 5 : 2, path: layer.key,
        },
        position: { x: BAND_W / 2, y: y + BAND_H / 2 },
      });
      bandPos.set(layer.key, { x: BAND_W / 2, y: y + BAND_H / 2, id });
      y += BAND_H + GAP;
      stat.cards++;
      continue;
    }

    // expanded: features inside layer
    const byFeat = new Map();
    for (const f of files) {
      if (!byFeat.has(f.feature)) byFeat.set(f.feature, []);
      byFeat.get(f.feature).push(f);
    }
    const featKeys = [...byFeat.keys()].sort((a, b) => byFeat.get(b).length - byFeat.get(a).length);
    const innerNodes = [];
    const innerLayouts = new Map();
    for (const fk of featKeys) {
      const flist = byFeat.get(fk);
      const fkey = `${layer.key}|${fk}`;
      if (ui.expandedLayerFeatures.has(fkey)) {
        const nodes = flist.slice(0, ui.noLimit ? flist.length : NODE_BUDGET).map((f) => ({
          id: f.id, w: Math.max(fileSize(f), 72), h: fileSize(f) + 28, size: fileSize(f),
        }));
        const L = layoutNodes(nodes, [], { aspect: 1.6, nodesep: 18, ranksep: 36 });
        innerLayouts.set(fk, { L, nodes, w: L.w + 40, h: L.h + 56, files: flist });
        innerNodes.push({ id: fk, w: L.w + 40, h: L.h + 56 });
      } else {
        innerNodes.push({ id: fk, w: 200, h: 64 });
      }
    }
    const L2 = layoutNodes(innerNodes, [], { aspect: 2.2, nodesep: 28, ranksep: 48 });
    const frameLabel = `${layer.key} · ${files.length}ファイル / ${featKeys.length}機能`;
    const fw = Math.max(L2.w + 80, BAND_W);
    const fh = L2.h + 90;
    const fid = `lf:${layer.key}`;
    elements.push({
      group: "nodes", selectable: false, grabbable: false, classes: "frame",
      data: {
        id: fid, kind: "layerframe", layer: layer.key, label: frameLabel, w: fw, h: fh,
        fill: layer.color || "#64748b", border: layer.color || "#64748b", bw: 3, fs: 28, lm: 36, path: layer.key,
      },
      position: { x: fw / 2, y: y + fh / 2 },
    });
    bandPos.set(layer.key, { x: fw / 2, y: y + fh / 2, id: fid });
    stat.frames++;
    for (const fk of featKeys) {
      const pos = L2.pos.get(fk);
      const px = 40 + pos.x;
      const py = y + 70 + pos.y;
      const flist = byFeat.get(fk);
      if (ui.expandedLayerFeatures.has(`${layer.key}|${fk}`)) {
        const il = innerLayouts.get(fk);
        const dfid = `lff:${layer.key}|${fk}`;
        elements.push({
          group: "nodes", selectable: false, grabbable: false, classes: "frame",
          data: {
            id: dfid, kind: "layerframe", layer: layer.key, feature: fk, label: `${fk} (${flist.length})`,
            w: il.w, h: il.h, fill: "#1e293b", border: "#94a3b8", bw: 2, fs: 16, lm: 22, path: fk,
          },
          position: { x: px, y: py },
        });
        for (const n of il.nodes) {
          const f = m.files.get(n.id);
          const pp = il.L.pos.get(n.id);
          const tkf = topKind([f]);
          elements.push({
            group: "nodes", selectable: true, grabbable: false,
            data: {
              id: f.id, kind: "file", label: f.name, w: n.size, h: n.size,
              fill: LANG_COLOR[f.lang] || LANG_COLOR.unknown, border: tkf ? tkf.color : "#0f1419", bw: tkf ? 5 : 1,
              path: f.path, ckey: f.cluster,
            },
            position: { x: px - il.w / 2 + 20 + pp.x, y: py - il.h / 2 + 40 + pp.y },
          });
          stat.files++;
        }
      } else {
        elements.push({
          group: "nodes", selectable: true, grabbable: false,
          data: {
            id: `lfat:${layer.key}|${fk}`, kind: "layer-feature", layer: layer.key, feature: fk,
            label: `${fk}\n${flist.length}f`, w: 200, h: 64,
            fill: "#334155", border: layer.color || "#94a3b8", bw: 2, path: fk,
          },
          position: { x: px, y: py },
        });
        stat.dirs++;
      }
    }
    y += fh + GAP;
  }

  // inter-layer edges
  let edges = 0;
  let crossTotal = 0;
  for (let i = 0; i < layers.length; i++) {
    for (let j = 0; j < layers.length; j++) {
      if (i === j) continue;
      const a = layers[i].key;
      const b = layers[j].key;
      const w = matrix.cells?.[a]?.[b] || 0;
      if (!w) continue;
      const sa = bandPos.get(a);
      const sb = bandPos.get(b);
      if (!sa || !sb) continue;
      const viol = violPairs.has(`${a}\t${b}`);
      if (ui.archOnly && !viol) continue;
      elements.push({
        group: "edges",
        data: {
          id: `le:${a}->${b}`, source: sa.id, target: sb.id, weight: w, kind: "edge",
          cross: viol, card: true, viol,
        },
      });
      edges++;
      if (viol) crossTotal++;
    }
  }

  return { elements, stat, leaf: stat.cards + stat.dirs + stat.files, edges, crossTotal, visFiles: [...m.files.values()].filter(fileVis).length, vedges: edges };
}

function buildFeatureView() {
  const m = state.model;
  const ui = state.ui;
  const features = state.data.summary.features || [];
  const byKey = new Map(features.map((f) => [f.key, f]));
  // aggregate edges feature→feature
  const featEdge = new Map();
  for (const e of m.edges) {
    const a = m.files.get(e.s);
    const b = m.files.get(e.t);
    if (!a || !b || !fileVis(a) || !fileVis(b)) continue;
    const ak = `${a.cluster}|${a.feature}`;
    const bk = `${b.cluster}|${b.feature}`;
    if (ak === bk) continue;
    const id = `${ak}>${bk}`;
    featEdge.set(id, (featEdge.get(id) || 0) + 1);
  }
  const violPairs = new Set();
  for (const is of state.data.issues || []) {
    if (!isArchViolationIssue(is)) continue;
    const from = m.files.get(is.locations[0]);
    const to = m.files.get(is.locations[1]);
    if (from && to) violPairs.add(`${from.cluster}|${from.feature}\t${to.cluster}|${to.feature}`);
  }

  const cards = features.filter((f) => f.fileCount > 0);
  const elements = [];
  const stat = { cards: 0, dirs: 0, files: 0, frames: 0 };
  const CARD = 260;
  const cols = Math.max(1, Math.ceil(Math.sqrt(cards.length)));
  const placements = new Map();

  cards.forEach((f, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    placements.set(f.key, { x: col * (CARD + 70), y: row * (CARD + 70) });
  });

  for (const f of cards) {
    const p = placements.get(f.key);
    const expanded = ui.expandedFeatures.has(f.key);
    const layerBits = Object.entries(f.layers || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k.slice(0, 4)}${n}`)
      .join(" ");
    if (!expanded) {
      const label = `${f.feature}\n${f.cluster}\n${f.fileCount}ファイル\n${layerBits}`;
      elements.push({
        group: "nodes", selectable: true, grabbable: false,
        data: {
          id: `feat:${f.key}`, kind: "feature", featureKey: f.key, label, w: CARD, h: CARD,
          fill: "#1e293b", border: "#3db8a0", bw: 3, path: f.key,
        },
        position: { x: p.x + CARD / 2, y: p.y + CARD / 2 },
      });
      placements.set(f.key, { ...p, id: `feat:${f.key}`, w: CARD, h: CARD });
      stat.cards++;
      continue;
    }
    const files = [...m.files.values()].filter(
      (x) => `${x.cluster}|${x.feature}` === f.key && fileVis(x),
    );
    const nodes = files.slice(0, ui.noLimit ? files.length : NODE_BUDGET).map((file) => ({
      id: file.id, w: Math.max(fileSize(file), 70), h: fileSize(file) + 28, size: fileSize(file),
    }));
    const L = layoutNodes(nodes, [], { aspect: 1.4, nodesep: 16, ranksep: 34 });
    const fw = Math.max(L.w + 60, CARD);
    const fh = L.h + 80;
    const fid = `ff:${f.key}`;
    elements.push({
      group: "nodes", selectable: false, grabbable: false, classes: "frame",
      data: {
        id: fid, kind: "featureframe", featureKey: f.key, label: `${f.feature} · ${files.length}f`,
        w: fw, h: fh, fill: "#0f172a", border: "#3db8a0", bw: 3, fs: 20, lm: 28, path: f.key,
      },
      position: { x: p.x + fw / 2, y: p.y + fh / 2 },
    });
    placements.set(f.key, { x: p.x, y: p.y, id: fid, w: fw, h: fh });
    stat.frames++;
    for (const n of nodes) {
      const file = m.files.get(n.id);
      const pp = L.pos.get(n.id);
      const layerColor = (state.data.summary.layers || []).find((l) => l.key === file.layer)?.color;
      elements.push({
        group: "nodes", selectable: true, grabbable: false,
        data: {
          id: file.id, kind: "file", label: file.name, w: n.size, h: n.size,
          fill: layerColor || LANG_COLOR[file.lang] || LANG_COLOR.unknown,
          border: "#0f1419", bw: 1, path: file.path, ckey: file.cluster,
        },
        position: { x: p.x + 30 + pp.x, y: p.y + 50 + pp.y },
      });
      stat.files++;
    }
  }

  let edges = 0;
  let crossTotal = 0;
  for (const [id, w] of featEdge) {
    const [a, b] = id.split(">");
    const pa = placements.get(a);
    const pb = placements.get(b);
    if (!pa?.id || !pb?.id) continue;
    const viol = violPairs.has(`${a}\t${b}`);
    if (ui.archOnly && !viol) continue;
    elements.push({
      group: "edges",
      data: { id: `fe:${id}`, source: pa.id, target: pb.id, weight: w, kind: "edge", cross: viol, card: true, viol },
    });
    edges++;
    if (viol) crossTotal++;
  }

  return { elements, stat, leaf: stat.cards + stat.files, edges, crossTotal, visFiles: [...m.files.values()].filter(fileVis).length, vedges: edges };
}

function renderLayerMatrix() {
  if (!el.layerMatrix || !state.data?.summary?.layerMatrix) return;
  const mx = state.data.summary.layerMatrix;
  const layers = mx.layers.filter((k) => (state.data.summary.layers || []).find((l) => l.key === k && l.fileCount > 0) || k === "未分類");
  const max = Math.max(1, ...layers.flatMap((a) => layers.map((b) => mx.cells?.[a]?.[b] || 0)));
  const viol = archViolationPairs();
  let html = `<table><thead><tr><th></th>${layers.map((l) => `<th title="${escapeHtml(l)}">${escapeHtml((state.data.summary.layers.find((x) => x.key === l)?.short) || l.slice(0, 3))}</th>`).join("")}</tr></thead><tbody>`;
  for (const a of layers) {
    html += `<tr><th title="${escapeHtml(a)}">${escapeHtml((state.data.summary.layers.find((x) => x.key === a)?.short) || a.slice(0, 3))}</th>`;
    for (const b of layers) {
      const n = mx.cells?.[a]?.[b] || 0;
      const intensity = n ? 0.15 + 0.75 * (n / max) : 0;
      const bad = viol.has(`${a}\t${b}`);
      const active = state.ui.matrixPair && state.ui.matrixPair.from === a && state.ui.matrixPair.to === b;
      html += `<td class="mx-cell ${bad ? "bad" : ""} ${active ? "active" : ""}" data-from="${escapeHtml(a)}" data-to="${escapeHtml(b)}" style="background:rgba(${bad ? "255,82,82" : "61,184,160"},${intensity})" title="${escapeHtml(a)} → ${escapeHtml(b)}: ${n}">${n || ""}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  el.layerMatrix.innerHTML = html;
  if (el.layerLegend) {
    const rate = ((state.data.summary.unclassifiedRate || 0) * 100).toFixed(0);
    el.layerLegend.innerHTML = `未分類率 ${rate}% · 期待: プレゼン→アプリ→ドメイン←インフラ · 共通は参照可`;
  }
  el.layerMatrix.querySelectorAll(".mx-cell").forEach((td) => {
    td.addEventListener("click", () => {
      const from = td.dataset.from;
      const to = td.dataset.to;
      state.ui.matrixPair = { from, to };
      const ids = [];
      for (const e of state.model.edges) {
        const a = state.model.files.get(e.s);
        const b = state.model.files.get(e.t);
        if (a?.layer === from && b?.layer === to) {
          ids.push(a.id, b.id);
        }
      }
      const uniq = [...new Set(ids)];
      if (uniq.length) {
        if (state.ui.viewMode === "cluster") revealFiles(uniq);
        render({ fit: false });
        selectNodes(uniq, "set", false);
        focusIds(uniq.filter((id) => state.cy && !state.cy.getElementById(id).empty()));
        el.selection.innerHTML = `<strong>${escapeHtml(from)} → ${escapeHtml(to)}</strong><div class="muted" style="margin-top:6px">${uniq.length} ファイルが関係</div>
          <div style="margin-top:8px">${uniq.slice(0, 30).map((id) => jumpLink(id, state.model.files.get(id).path)).join("<br>")}</div>`;
        bindJumps();
      }
      renderLayerMatrix();
    });
  });
}

function styleSheetArchExtras() {
  // edges marked viol use cross styling already
}

window.depgraph = {
  state, fitToIds, fitReadable, fitCurrentView, fitExpandedCluster, expandCluster, collapseAll, toggleDir,
  jumpToFile, jumpToDir, toggleLayerBand, toggleFeatureCard, applyFlatExpansion, render, FIT_MIN_ZOOM,
};
loadAnalysis();
