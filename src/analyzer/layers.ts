import type {
  AnalysisRules,
  ArchLayerRule,
  DesignIssue,
  DependencyGraph,
  FeatureRootRule,
  FeatureSummary,
  GraphNode,
  Language,
  LayerMatrix,
  LayerMatrixScopes,
  LayerScopeSummary,
  LayerSummary,
  LayerViolationSummary,
  SourceFile,
  UnclassifiedDirStat,
} from "./types.js";
import { computeFileEdges } from "./graph.js";
import { majorityKey, summarizeClusters } from "./cluster.js";

/* ------------------------------------------------------------------ *
 * アーキテクチャ層(ドメイン / アプリケーション / インフラ / プレゼンテーション …)
 * ------------------------------------------------------------------ */

export const LAYER_PRESENTATION = "プレゼンテーション";
export const LAYER_APPLICATION = "アプリケーション";
export const LAYER_DOMAIN = "ドメイン";
export const LAYER_INFRA = "インフラ";
export const LAYER_COMMON = "共通・基盤";
export const LAYER_TOOLS = "テスト・ツール・外部";
export const LAYER_UNCLASSIFIED = "未分類";

export type LayerBasis = "dir" | "file" | "none";

export interface ResolvedLayer {
  name: string;
  short: string;
  color: string;
  /** 大きいほど上位(表示は上)。ドメインを中心に「小さいほど内側/下位」。 */
  order: number;
  /** 依存方向のチェック対象外(テスト等)。 */
  neutral: boolean;
  match: string[];
  /** 未指定なら既定の期待(下記 DEFAULT_ALLOWED)を使う。既定に無い名前は制限なし。 */
  mayDependOn?: string[];
  compiled: CompiledPattern[];
}

/**
 * 既定の層定義。ルールの並びは「ファイル名だけで一致した場合の優先順」にも使う。
 * パターンは大文字小文字を区別しない。`**` は 0 個以上のディレクトリ。
 * 末尾が `**` のものはディレクトリ規則、末尾がファイル名 glob のものは補助規則(ディレクトリ規則が無い時だけ採用)。
 */
/**
 * 既定の層ヒューリスティック。一般的な命名規約のみ(プロジェクト固有名は入れない)。
 * リポジトリ固有の上書きは archLayers / examples/*.json で行う。
 */
export const DEFAULT_ARCH_LAYERS: ArchLayerRule[] = [
  {
    name: LAYER_PRESENTATION,
    color: "#e879c6",
    order: 40,
    match: [
      "**/Presentation/**",
      "**/UI/**",
      "**/Views/**",
      "**/View/**",
      "**/Widgets/**",
      "**/Screens/**",
      "**/Pages/**",
      "**/*View.cs",
      "**/*Presenter.cs",
      "**/*_screen.dart",
      "**/*_page.dart",
      "**/*_view.dart",
      "**/*_widget.dart",
    ],
  },
  {
    name: LAYER_APPLICATION,
    color: "#4da3ff",
    order: 30,
    match: [
      "**/Application/**",
      "**/Command/**",
      "**/Commands/**",
      "**/Handlers/**",
      "**/Handler/**",
      "**/Services/**",
      "**/UseCases/**",
      "**/UseCase/**",
      "**/*Service.cs",
      "**/*UseCase.cs",
      "**/*Handler.cs",
      "**/*Handlers.cs",
      "**/lambda_function.py",
    ],
  },
  {
    name: LAYER_DOMAIN,
    color: "#f5c542",
    order: 20,
    match: [
      "**/Domain/**",
      "**/Models/**",
      "**/Model/**",
      "**/Entities/**",
      "**/Entity/**",
      "**/ValueObjects/**",
    ],
  },
  {
    name: LAYER_INFRA,
    color: "#4cc38a",
    order: 10,
    match: [
      "**/Infrastructure/**",
      "**/Persistence/**",
      "**/Repositories/**",
      "**/Repository/**",
      "**/storage/**",
      "**/platform/**",
      "**/auth/**",
      "**/*Repository.cs",
      "**/*_repository.dart",
      "**/*Gateway.cs",
      "**/*_gateway.dart",
      "**/*ApiClient.cs",
      "**/*_api.dart",
    ],
  },
  {
    name: LAYER_COMMON,
    color: "#a78bfa",
    order: 0,
    match: [
      "**/Util/**",
      "**/Utils/**",
      "**/Utility/**",
      "**/Core/**",
      "**/Common/**",
      "**/Extensions/**",
      "**/config/**",
      "**/theme/**",
      "**/l10n/**",
      "**/Diagnostics/**",
    ],
  },
  {
    name: LAYER_TOOLS,
    color: "#7f8ea3",
    order: -10,
    match: [
      "**/tests/**",
      "**/test/**",
      "**/integration_test/**",
      "**/scripts/**",
      "**/Editor/**",
      "**/Sample/**",
      "**/Samples/**",
      "**/test_*.py",
      "**/*_test.py",
      "**/*_test.dart",
      "**/*Tests.cs",
      "**/*Test.cs",
    ],
  },
];

const DEFAULT_SHORT: Record<string, string> = {
  [LAYER_PRESENTATION]: "プレゼン",
  [LAYER_APPLICATION]: "アプリ",
  [LAYER_DOMAIN]: "ドメイン",
  [LAYER_INFRA]: "インフラ",
  [LAYER_COMMON]: "共通",
  [LAYER_TOOLS]: "テスト等",
  [LAYER_UNCLASSIFIED]: "未分類",
};

/** 既定の「期待する依存の向き」(from → 依存してよい層)。 */
export const DEFAULT_ALLOWED: Record<string, string[]> = {
  [LAYER_PRESENTATION]: [LAYER_APPLICATION, LAYER_DOMAIN, LAYER_INFRA, LAYER_COMMON],
  [LAYER_APPLICATION]: [LAYER_DOMAIN, LAYER_INFRA, LAYER_COMMON],
  [LAYER_DOMAIN]: [LAYER_COMMON],
  [LAYER_INFRA]: [LAYER_DOMAIN, LAYER_COMMON],
  [LAYER_COMMON]: [],
};

const UNCLASSIFIED_COLOR = "#4b5563";
const NEUTRAL_NAMES = new Set([LAYER_TOOLS, LAYER_UNCLASSIFIED]);

/* ---- パターン ---- */

interface CompiledPattern {
  raw: string;
  /** null = `**` */
  tokens: (RegExp | null)[];
}

function compilePattern(p: string): CompiledPattern {
  let s = p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (!s.includes("/")) s = /[*?.]/.test(s) ? `**/${s}` : `**/${s}/**`;
  const tokens = s
    .split("/")
    .filter((t) => t !== "")
    .map((t) =>
      t === "**"
        ? null
        : new RegExp(
            "^" +
              t
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, "[^/]*")
                .replace(/\?/g, "[^/]") +
              "$",
          ),
    );
  return { raw: p, tokens };
}

/**
 * パスのセグメント列にパターンを当て、最後のリテラルトークンが一致したセグメント位置(1 始まり)の最大値を返す。
 * 一致しなければ 0。位置 = segs.length ならファイル名で一致(補助規則)。
 */
export function matchAnchor(tokens: (RegExp | null)[], segs: string[]): number {
  const T = tokens.length;
  const S = segs.length;
  const rec = (ti: number, si: number, last: number): number => {
    if (ti === T) return si === S ? last : -1;
    const tok = tokens[ti]!;
    if (tok === null) {
      let best = -1;
      for (let k = si; k <= S; k++) best = Math.max(best, rec(ti + 1, k, last));
      return best;
    }
    if (si < S && tok.test(segs[si]!)) return rec(ti + 1, si + 1, si + 1);
    return -1;
  };
  const r = rec(0, 0, 0);
  return r > 0 ? r : 0;
}

export function resolveArchLayers(custom?: ArchLayerRule[]): ResolvedLayer[] {
  const byName = new Map<string, ArchLayerRule>();
  for (const l of DEFAULT_ARCH_LAYERS) byName.set(l.name, { ...l });
  for (const c of custom ?? []) {
    const base = byName.get(c.name);
    byName.set(c.name, {
      ...base,
      ...c,
      match: c.match ?? base?.match ?? [],
      color: c.color ?? base?.color,
      order: c.order ?? base?.order ?? 25,
    });
  }
  return [...byName.values()].map((r) => ({
    name: r.name,
    short: DEFAULT_SHORT[r.name] ?? r.name.slice(0, 4),
    color: r.color ?? "#94a3b8",
    order: r.order ?? 25,
    neutral: r.neutral ?? NEUTRAL_NAMES.has(r.name),
    match: r.match,
    mayDependOn: r.mayDependOn,
    compiled: r.match.map(compilePattern),
  }));
}

export interface LayerClassification {
  layerKey: string;
  layerReason: string;
  layerBasis: LayerBasis;
}

/**
 * 層判定。優先順位:
 *  1. テスト/ツール等の中立層のディレクトリ規則(深さに関係なく優先)
 *  2. それ以外のディレクトリ規則のうち「最も深いセグメント」に一致したもの(同じ深さならルール定義順)
 *  3. パス付きファイル規則(例: Shared/AR 配下の *Presenter*) — 親ディレクトリ規則と同じ深さ以上なら上書き可
 *  4. 素のファイル名規則(例: *View.cs) — ディレクトリ規則が無いときだけ
 *  5. 未分類
 */
export function classifyLayer(relativePath: string, layers: ResolvedLayer[]): LayerClassification {
  const rel = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const segs = rel.toLowerCase().split("/");
  const orig = rel.split("/");
  const S = segs.length;
  let neutralHit: { layer: ResolvedLayer; anchor: number; pat: string } | undefined;
  let dirHit: { layer: ResolvedLayer; anchor: number; pat: string } | undefined;
  let fileHit:
    | { layer: ResolvedLayer; pat: string; contextual: boolean; parentAnchor: number }
    | undefined;
  for (const layer of layers) {
    for (const cp of layer.compiled) {
      const a = matchAnchor(cp.tokens, segs);
      if (a === 0) continue;
      if (a === S) {
        const literalCount = cp.tokens.filter((t) => t !== null).length;
        // 2 つ以上のリテラルトークンを持つ = パス文脈付きファイル規則
        const contextual = literalCount >= 2;
        const parentAnchor = Math.max(0, S - 1);
        if (
          !fileHit ||
          (contextual && !fileHit.contextual) ||
          (contextual === fileHit.contextual && parentAnchor > fileHit.parentAnchor)
        ) {
          fileHit = { layer, pat: cp.raw, contextual, parentAnchor };
        }
        continue;
      }
      if (layer.neutral) {
        if (!neutralHit || a > neutralHit.anchor) neutralHit = { layer, anchor: a, pat: cp.raw };
      } else if (!dirHit || a > dirHit.anchor) dirHit = { layer, anchor: a, pat: cp.raw };
    }
  }
  if (neutralHit) {
    return {
      layerKey: neutralHit.layer.name,
      layerBasis: "dir",
      layerReason: `ディレクトリ「${orig[neutralHit.anchor - 1]}」が ${neutralHit.pat} に一致`,
    };
  }
  // パス付きファイル規則は、同階層以上のディレクトリ規則を上書きできる
  if (fileHit?.contextual && (!dirHit || fileHit.parentAnchor >= dirHit.anchor)) {
    return {
      layerKey: fileHit.layer.name,
      layerBasis: "file",
      layerReason: `パス付きファイル規則「${fileHit.pat}」が「${orig[S - 1]}」に一致`,
    };
  }
  if (dirHit) {
    return {
      layerKey: dirHit.layer.name,
      layerBasis: "dir",
      layerReason: `ディレクトリ「${orig[dirHit.anchor - 1]}」が ${dirHit.pat} に一致`,
    };
  }
  if (fileHit) {
    return {
      layerKey: fileHit.layer.name,
      layerBasis: "file",
      layerReason: `ファイル名「${orig[S - 1]}」が ${fileHit.pat} に一致(補助規則)`,
    };
  }
  return { layerKey: LAYER_UNCLASSIFIED, layerBasis: "none", layerReason: "どの規則にも一致しない" };
}

/* ---- Feature(機能)軸 ---- */

function normalizeFeatureRoot(raw: string | FeatureRootRule): FeatureRootRule {
  if (typeof raw === "string") return { match: raw, depth: 1 };
  return { match: raw.match, depth: raw.depth ?? 1 };
}

/**
 * featureRoots 例: "Assets/Shared/*" → Shared 直下の1セグメントが feature 名。
 * "lib/*" → lib 直下。depth>1 なら複数セグメントを `/` でつなぐ。
 */
export function featureFromRoots(
  relativePath: string,
  roots?: Array<string | FeatureRootRule>,
): string | undefined {
  if (!roots?.length) return undefined;
  const rel = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const segs = rel.split("/");
  for (const raw of roots) {
    const root = normalizeFeatureRoot(raw);
    let pattern = root.match.replace(/\\/g, "/").replace(/^\.\//, "");
    // "Assets/Shared/*" → prefix Assets/Shared/, capture following segments
    const starIdx = pattern.indexOf("/*");
    if (starIdx >= 0) {
      const prefix = pattern.slice(0, starIdx).replace(/\/$/, "");
      const prefixSegs = prefix.split("/").filter(Boolean);
      // find prefix in path (allow leading project dirs)
      for (let i = 0; i <= segs.length - prefixSegs.length; i++) {
        let ok = true;
        for (let j = 0; j < prefixSegs.length; j++) {
          if (segs[i + j]!.toLowerCase() !== prefixSegs[j]!.toLowerCase()) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const start = i + prefixSegs.length;
        const depth = root.depth ?? 1;
        if (start + depth > segs.length) continue; // need room for feature + file
        // last seg is filename — feature must not consume the file itself only
        const featureSegs = segs.slice(start, start + depth);
        if (featureSegs.length === 0) continue;
        // if feature would be the filename alone and depth=1 with no trailing dir, skip
        if (start + depth >= segs.length) continue;
        return featureSegs.join("/");
      }
      continue;
    }
    // glob without trailing /* : treat as directory prefix; next `depth` segs are feature
    const cleaned = pattern.replace(/\/\*\*$/, "").replace(/\/$/, "");
    const prefixSegs = cleaned.split("/").filter(Boolean);
    if (prefixSegs.length === 0) continue;
    for (let i = 0; i <= segs.length - prefixSegs.length; i++) {
      let ok = true;
      for (let j = 0; j < prefixSegs.length; j++) {
        if (segs[i + j]!.toLowerCase() !== prefixSegs[j]!.toLowerCase()) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const start = i + prefixSegs.length;
      const depth = root.depth ?? 1;
      if (start + depth >= segs.length) continue;
      return segs.slice(start, start + depth).join("/");
    }
  }
  return undefined;
}

/**
 * Unity: Assets/Shared/<Feature>、Assets/Tests/<Mode>/<Feature>
 * Flutter: lib/<dir>
 * Python: 先頭ディレクトリ(各 API プロジェクト)
 * featureRoots があればそちらを優先。
 */
export function featureKeyFor(
  relativePath: string,
  language: Language,
  roots?: Array<string | FeatureRootRule>,
): string {
  const fromRoots = featureFromRoots(relativePath, roots);
  if (fromRoots) return fromRoots;

  const segs = relativePath.replace(/\\/g, "/").split("/");
  if (language === "csharp") {
    const ai = segs.findIndex((s) => s === "Assets");
    if (ai < 0) return segs.length > 1 ? segs[0]! : "(root)";
    const project = ai > 0 ? segs[ai - 1]! : "(root)";
    const rest = segs.slice(ai + 1);
    if (rest[0] === "Shared") return rest.length > 2 ? rest[1]! : "Shared";
    if (rest[0] === "Tests") return rest.length > 3 ? rest[2]! : "Tests";
    return `${project}:${rest.length > 2 ? rest[1] : rest[0]}`;
  }
  if (language === "dart") {
    const li = segs.findIndex((s) => s === "lib");
    if (li >= 0) {
      const rest = segs.slice(li + 1);
      return rest.length > 1 ? rest[0]! : "lib";
    }
    return segs.length > 2 ? segs[1]! : "(root)";
  }
  return segs.length > 1 ? segs[0]! : "(root)";
}

export function assignLayersAndFeatures(files: SourceFile[], rules?: AnalysisRules | ArchLayerRule[]): void {
  const arch = Array.isArray(rules) ? rules : rules?.archLayers;
  const featureRoots = Array.isArray(rules) ? undefined : rules?.featureRoots;
  const layers = resolveArchLayers(arch);
  for (const f of files) {
    const c = classifyLayer(f.relativePath, layers);
    f.layerKey = c.layerKey;
    f.layerReason = c.layerReason;
    f.layerBasis = c.layerBasis;
    f.featureKey = featureKeyFor(f.relativePath, f.language, featureRoots);
  }
}

/** directory ノード用: 配下ファイルの多数派 */
export function majorityOf(keys: (string | undefined)[]): string | undefined {
  return majorityKey(keys.filter((k): k is string => !!k));
}

export function copyLayerFields(n: GraphNode, f: SourceFile): void {
  n.layerKey = f.layerKey;
  n.featureKey = f.featureKey;
  n.layerReason = f.layerReason;
  n.layerBasis = f.layerBasis;
}

/* ---- 依存方向の検査 ---- */

function allowedFor(layer: ResolvedLayer | undefined): Set<string> | undefined {
  if (!layer) return undefined;
  if (layer.mayDependOn) return new Set(layer.mayDependOn);
  const d = DEFAULT_ALLOWED[layer.name];
  return d ? new Set(d) : undefined; // undefined = 制限なし
}

const baseName = (p: string) => p.split("/").pop() ?? p;

export interface ArchViolation {
  from: SourceFile;
  to: SourceFile;
  fromLayer: string;
  toLayer: string;
  severity: "error" | "warning";
}

export function findLayerViolations(files: SourceFile[], rules: AnalysisRules): ArchViolation[] {
  const layers = resolveArchLayers(rules.archLayers);
  const by = new Map(layers.map((l) => [l.name, l]));
  const out: ArchViolation[] = [];
  for (const { from, to } of computeFileEdges(files)) {
    const la = from.layerKey ?? classifyLayer(from.relativePath, layers).layerKey;
    const lb = to.layerKey ?? classifyLayer(to.relativePath, layers).layerKey;
    if (la === lb) continue;
    const A = by.get(la);
    const B = by.get(lb);
    if (!A || !B || A.neutral || B.neutral) continue;
    const ok = allowedFor(A);
    if (!ok || ok.has(lb)) continue;
    const strong = from.layerBasis === "dir" && to.layerBasis === "dir";
    const domainOut = la === LAYER_DOMAIN && [LAYER_APPLICATION, LAYER_PRESENTATION, LAYER_INFRA].includes(lb);
    const appToPres = la === LAYER_APPLICATION && lb === LAYER_PRESENTATION;
    let severity: "error" | "warning" = "warning";
    if (strong) {
      if (domainOut) severity = "error";
      else if (appToPres && from.language !== "csharp") severity = "error"; // Unity は汎用 MonoBehaviour 等で誤検出しやすい
      else if (!DEFAULT_ALLOWED[la] && !DEFAULT_ALLOWED[lb]) severity = "error"; // 利用者定義の層同士
    }
    out.push({ from, to, fromLayer: la, toLayer: lb, severity });
  }
  return out;
}

export function detectArchLayerViolations(graph: DependencyGraph, rules: AnalysisRules): DesignIssue[] {
  return findLayerViolations(graph.files, rules).map((v) => ({
    id: `archlayer:${v.from.id}>${v.to.id}`,
    kind: "layer_violation" as const,
    severity: v.severity,
    title: `層の依存方向違反: ${v.fromLayer} → ${v.toLayer}`,
    reason: `「${v.fromLayer}」層の ${baseName(v.from.relativePath)} が「${v.toLayer}」層の ${baseName(v.to.relativePath)} に依存しています(${v.fromLayer}→${v.toLayer} は期待する向きに反します)。${
      v.severity === "warning" ? "分類根拠が弱い/Unity の汎用クラス等で誤検出の可能性があるため warning です。" : ""
    }`,
    locations: [v.from.id, v.to.id],
    details: [
      `from_layer: ${v.fromLayer}`,
      `to_layer: ${v.toLayer}`,
      `from: ${v.from.relativePath}`,
      `to: ${v.to.relativePath}`,
      `from_reason: ${v.from.layerReason ?? ""}`,
      `to_reason: ${v.to.layerReason ?? ""}`,
      `from_feature: ${v.from.featureKey ?? ""}`,
      `to_feature: ${v.to.featureKey ?? ""}`,
    ],
  }));
}

/* ---- サマリ ---- */

export interface LayerScopeOptions {
  /** 層のファイル数・未分類率の対象(省略時は allFiles) */
  countFiles?: SourceFile[];
  /** 行列に含める依存(省略時は全エッジ) */
  includeEdge?: (from: SourceFile, to: SourceFile) => boolean;
  /** 層違反に含める issue(省略時は archlayer の全件) */
  includeArchIssue?: (issue: DesignIssue, from?: SourceFile, to?: SourceFile) => boolean;
}

function archIssueEndpoints(
  issue: DesignIssue,
  byId: Map<string, SourceFile>,
): { from?: SourceFile; to?: SourceFile } {
  const from = issue.locations[0] ? byId.get(issue.locations[0]) : undefined;
  const to = issue.locations[1] ? byId.get(issue.locations[1]) : undefined;
  return { from, to };
}

export function summarizeLayerScope(
  allFiles: SourceFile[],
  rules: AnalysisRules,
  issues: DesignIssue[],
  opts: LayerScopeOptions = {},
): LayerScopeSummary {
  const countFiles = opts.countFiles ?? allFiles;
  const resolved = resolveArchLayers(rules.archLayers);
  const display = [...resolved].sort((a, b) => b.order - a.order);
  const infos = [
    ...display,
    {
      name: LAYER_UNCLASSIFIED,
      short: DEFAULT_SHORT[LAYER_UNCLASSIFIED]!,
      color: UNCLASSIFIED_COLOR,
      order: -100,
      neutral: true,
    } as ResolvedLayer,
  ];
  const names = infos.map((l) => l.name);
  const counts = new Map<string, number>(names.map((n) => [n, 0]));
  const byLang = new Map<string, Map<string, number>>();
  for (const f of countFiles) {
    const k = f.layerKey ?? LAYER_UNCLASSIFIED;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (!byLang.has(f.language)) byLang.set(f.language, new Map());
    const m = byLang.get(f.language)!;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  for (const k of counts.keys()) if (!names.includes(k)) names.push(k);

  const byId = new Map(allFiles.map((f) => [f.id, f]));
  const archIssuesAll = issues.filter((i) => i.id.startsWith("archlayer:"));
  const archIssues = archIssuesAll.filter((i) => {
    if (!opts.includeArchIssue) return true;
    const { from, to } = archIssueEndpoints(i, byId);
    return opts.includeArchIssue(i, from, to);
  });

  const issueByLayer = new Map<string, number>();
  for (const i of archIssues) {
    const fl = i.details.find((d) => d.startsWith("from_layer: "))?.slice(12) ?? "";
    issueByLayer.set(fl, (issueByLayer.get(fl) ?? 0) + 1);
  }

  const layers: LayerSummary[] = names.map((n) => {
    const info = infos.find((l) => l.name === n);
    const fileCount = counts.get(n) ?? 0;
    const byLanguage: Record<string, number> = {};
    for (const [lang, m] of byLang) if (m.get(n)) byLanguage[lang] = m.get(n)!;
    return {
      key: n,
      short: info?.short ?? n.slice(0, 4),
      color: info?.color ?? "#94a3b8",
      order: info?.order ?? 0,
      neutral: info?.neutral ?? false,
      fileCount,
      violationsOut: issueByLayer.get(n) ?? 0,
      byLanguage,
    };
  });

  const cells: Record<string, Record<string, number>> = {};
  for (const a of names) {
    cells[a] = {};
    for (const b of names) cells[a]![b] = 0;
  }
  for (const { from, to } of computeFileEdges(allFiles)) {
    if (opts.includeEdge && !opts.includeEdge(from, to)) continue;
    const a = from.layerKey ?? LAYER_UNCLASSIFIED;
    const b = to.layerKey ?? LAYER_UNCLASSIFIED;
    if (!cells[a]) cells[a] = {};
    cells[a]![b] = (cells[a]![b] ?? 0) + 1;
  }
  const allowed: Record<string, string[] | null> = {};
  for (const l of resolved) {
    const s = allowedFor(l);
    allowed[l.name] = s ? [...s] : null;
  }
  const layerMatrix: LayerMatrix = {
    layers: names,
    cells,
    allowed,
    neutral: layers.filter((l) => l.neutral).map((l) => l.key),
  };

  const pair = new Map<string, number>();
  const sev = { error: 0, warning: 0, info: 0 };
  for (const i of archIssues) {
    sev[i.severity]++;
    const fl = i.details.find((d) => d.startsWith("from_layer: "))?.slice(12) ?? "";
    const tl = i.details.find((d) => d.startsWith("to_layer: "))?.slice(10) ?? "";
    const k = `${fl}\t${tl}`;
    pair.set(k, (pair.get(k) ?? 0) + 1);
  }
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const sample = [...archIssues]
    .sort((x, y) => rank[x.severity] - rank[y.severity])
    .slice(0, 10)
    .map((i) => ({
      severity: i.severity,
      fromLayer: i.details.find((d) => d.startsWith("from_layer: "))?.slice(12) ?? "",
      toLayer: i.details.find((d) => d.startsWith("to_layer: "))?.slice(10) ?? "",
      from: i.details.find((d) => d.startsWith("from: "))?.slice(6) ?? "",
      to: i.details.find((d) => d.startsWith("to: "))?.slice(4) ?? "",
    }));
  const layerViolations: LayerViolationSummary = {
    count: archIssues.length,
    error: sev.error,
    warning: sev.warning,
    byPair: [...pair.entries()]
      .map(([k, count]) => {
        const [from, to] = k.split("\t");
        return { from: from!, to: to!, count };
      })
      .sort((a, b) => b.count - a.count),
    samples: sample,
  };

  const unclassifiedFiles = countFiles.filter((f) => (f.layerKey ?? LAYER_UNCLASSIFIED) === LAYER_UNCLASSIFIED);
  const unclassifiedRate = countFiles.length === 0 ? 0 : unclassifiedFiles.length / countFiles.length;
  const dirCounts = new Map<string, number>();
  for (const f of unclassifiedFiles) {
    const parts = f.relativePath.split("/");
    const depth = Math.min(3, Math.max(1, parts.length - 1));
    const dir = parts.slice(0, depth).join("/") || "(root)";
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }
  const unclassifiedTopDirs: UnclassifiedDirStat[] = [...dirCounts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, 10);

  return {
    layers,
    layerMatrix,
    layerViolations,
    unclassifiedRate,
    unclassifiedTopDirs,
  };
}

export function summarizeLayerMatrixScopes(
  files: SourceFile[],
  rules: AnalysisRules,
  issues: DesignIssue[],
): LayerMatrixScopes {
  const byCluster: Record<string, LayerScopeSummary> = {};
  for (const c of summarizeClusters(files, rules.clusters)) {
    if (c.fileCount === 0) continue;
    const key = c.key;
    byCluster[key] = summarizeLayerScope(files, rules, issues, {
      countFiles: files.filter((f) => (f.clusterKey ?? "") === key),
      includeEdge: (from, to) => from.clusterKey === key && to.clusterKey === key,
      includeArchIssue: (_i, from, to) =>
        !!from && !!to && from.clusterKey === key && to.clusterKey === key,
    });
  }
  const interCluster = summarizeLayerScope(files, rules, issues, {
    countFiles: files,
    includeEdge: (from, to) => {
      const a = from.clusterKey ?? "";
      const b = to.clusterKey ?? "";
      return a !== b && a !== "" && b !== "";
    },
    includeArchIssue: (_i, from, to) =>
      !!from && !!to && (from.clusterKey ?? "") !== (to.clusterKey ?? ""),
  });
  return { byCluster, interCluster };
}

export function summarizeLayers(
  files: SourceFile[],
  rules: AnalysisRules,
  issues: DesignIssue[],
): {
  layers: LayerSummary[];
  layerMatrix: LayerMatrix;
  layerViolations: LayerViolationSummary;
  layerMatrixScopes: LayerMatrixScopes;
  features: FeatureSummary[];
  unclassifiedRate: number;
  unclassifiedTopDirs: UnclassifiedDirStat[];
} {
  const overall = summarizeLayerScope(files, rules, issues);
  const layerMatrixScopes = summarizeLayerMatrixScopes(files, rules, issues);

  const feat = new Map<string, FeatureSummary>();
  for (const f of files) {
    const cluster = f.clusterKey ?? "";
    const key = `${cluster}|${f.featureKey ?? "(none)"}`;
    let s = feat.get(key);
    if (!s) {
      s = { key, cluster, feature: f.featureKey ?? "(none)", fileCount: 0, layers: {} };
      feat.set(key, s);
    }
    s.fileCount++;
    const lk = f.layerKey ?? LAYER_UNCLASSIFIED;
    s.layers[lk] = (s.layers[lk] ?? 0) + 1;
  }
  const features = [...feat.values()].sort((a, b) => a.cluster.localeCompare(b.cluster) || b.fileCount - a.fileCount);

  return {
    layers: overall.layers,
    layerMatrix: overall.layerMatrix,
    layerViolations: overall.layerViolations,
    layerMatrixScopes,
    features,
    unclassifiedRate: overall.unclassifiedRate,
    unclassifiedTopDirs: overall.unclassifiedTopDirs,
  };
}
