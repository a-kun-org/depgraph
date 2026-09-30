import { detectArchLayerViolations } from "../layers.js";
import type {
  AnalysisRules,
  DependencyGraph,
  DesignIssue,
  GraphEdge,
  GraphNode,
} from "../types.js";

export function detectCycles(graph: DependencyGraph): DesignIssue[] {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind === "contains") continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }

  const issues: DesignIssue[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];
  const reported = new Set<string>();

  const labelOf = (id: string) =>
    graph.nodes.find((n) => n.id === id)?.path ??
    graph.nodes.find((n) => n.id === id)?.label ??
    id;

  function dfs(node: string) {
    if (stack.has(node)) {
      const start = path.indexOf(node);
      const cycle = path.slice(start).concat(node);
      const key = cycle
        .slice(0, -1)
        .sort()
        .join("|");
      if (!reported.has(key)) {
        reported.add(key);
        issues.push({
          id: `cycle:${key}`,
          kind: "circular_dependency",
          severity: "error",
          title: "循環依存",
          reason: `依存が閉路を形成しています: ${cycle.map(labelOf).join(" → ")}`,
          locations: cycle.slice(0, -1),
          details: cycle.map(labelOf),
        });
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    path.push(node);
    for (const next of adj.get(node) ?? []) dfs(next);
    path.pop();
    stack.delete(node);
  }

  for (const n of graph.nodes) {
    if (n.kind === "directory") continue;
    dfs(n.id);
  }

  return issues;
}

export function detectHubs(
  graph: DependencyGraph,
  rules: AnalysisRules,
): DesignIssue[] {
  const threshold = rules.hub?.degreeThreshold ?? 8;
  const degree = new Map<string, { in: number; out: number }>();

  const bump = (id: string, dir: "in" | "out") => {
    const d = degree.get(id) ?? { in: 0, out: 0 };
    d[dir]++;
    degree.set(id, d);
  };

  for (const e of graph.edges) {
    if (e.kind === "contains") continue;
    bump(e.source, "out");
    bump(e.target, "in");
  }

  const issues: DesignIssue[] = [];
  for (const n of graph.nodes) {
    if (n.kind === "directory") continue;
    const d = degree.get(n.id);
    if (!d) continue;
    const total = d.in + d.out;
    if (total >= threshold) {
      issues.push({
        id: `hub:${n.id}`,
        kind: "hub",
        severity: d.in >= threshold ? "warning" : "info",
        title: "依存の集中（ハブ / God object 疑い）",
        reason: `ノード「${n.path ?? n.label}」の次数が ${total}（入次数 ${d.in} / 出次数 ${d.out}）で閾値 ${threshold} 以上です。変更の影響範囲が広がりやすい状態です。`,
        locations: [n.id],
        details: [
          `path: ${n.path ?? n.label}`,
          `in-degree: ${d.in}`,
          `out-degree: ${d.out}`,
        ],
      });
    }
  }
  return issues;
}

export function detectBloatedFiles(
  graph: DependencyGraph,
  rules: AnalysisRules,
): DesignIssue[] {
  const threshold = rules.bloat?.locThreshold ?? 400;
  return graph.nodes
    .filter((n) => n.kind === "file" && n.loc >= threshold)
    .map((n) => ({
      id: `bloat:${n.id}`,
      kind: "bloated_file" as const,
      severity: "warning" as const,
      title: "肥大化したファイル",
      reason: `ファイル「${n.path}」の実効 LOC が ${n.loc} 行で、閾値 ${threshold} を超えています。分割を検討してください。`,
      locations: [n.id],
      details: [`path: ${n.path}`, `loc: ${n.loc}`, `threshold: ${threshold}`],
    }));
}

export function detectOrphans(
  graph: DependencyGraph,
  rules: AnalysisRules,
): DesignIssue[] {
  const connected = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind === "contains") continue;
    connected.add(e.source);
    connected.add(e.target);
  }

  const ignore = rules.orphans?.ignore ?? [];
  const issues: DesignIssue[] = [];

  for (const n of graph.nodes) {
    if (n.kind !== "file") continue;
    if (connected.has(n.id)) continue;
    const p = n.path ?? n.label;
    if (ignore.some((pat) => matchGlob(p, pat))) continue;
    issues.push({
      id: `orphan:${n.id}`,
      kind: "orphan",
      severity: "info",
      title: "孤立ノード",
      reason: `ファイル「${p}」は解析対象内の他ファイルとの依存エッジがありません（エントリポイント、未使用コード、または未解決 import の可能性）。`,
      locations: [n.id],
      details: [`path: ${p}`],
    });
  }
  return issues;
}

export function detectLayerViolations(
  graph: DependencyGraph,
  rules: AnalysisRules,
): DesignIssue[] {
  const layers = rules.layers ?? [];
  if (layers.length === 0) return [];

  const layerOf = (path: string | undefined): string | undefined => {
    if (!path) return undefined;
    for (const layer of layers) {
      if (layer.match.some((pat) => matchGlob(path, pat))) return layer.name;
    }
    return undefined;
  };

  const allowed = new Map(layers.map((l) => [l.name, new Set(l.mayDependOn)]));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const issues: DesignIssue[] = [];

  for (const e of graph.edges) {
    if (e.kind === "contains") continue;
    const src = nodeById.get(e.source);
    const tgt = nodeById.get(e.target);
    if (!src?.path || !tgt?.path) continue;
    const sl = layerOf(src.path);
    const tl = layerOf(tgt.path);
    if (!sl || !tl || sl === tl) continue;
    const ok = allowed.get(sl);
    if (ok && !ok.has(tl)) {
      issues.push({
        id: `layer:${e.id}`,
        kind: "layer_violation",
        severity: "error",
        title: "レイヤー違反の疑い",
        reason: `レイヤー「${sl}」の「${src.path}」が、依存を許可されていないレイヤー「${tl}」の「${tgt.path}」を参照しています。`,
        locations: [e.source, e.target],
        details: [
          `from_layer: ${sl}`,
          `to_layer: ${tl}`,
          `from: ${src.path}`,
          `to: ${tgt.path}`,
          e.detail ? `edge: ${e.detail}` : "",
        ].filter(Boolean),
      });
    }
  }
  return issues;
}

export function detectAll(
  graph: DependencyGraph,
  rules: AnalysisRules,
): DesignIssue[] {
  return [
    ...detectCycles(graph),
    ...detectHubs(graph, rules),
    ...detectBloatedFiles(graph, rules),
    ...detectLayerViolations(graph, rules),
    ...detectArchLayerViolations(graph, rules),
    ...detectOrphans(graph, rules),
  ];
}

/** Minimal glob: * and ** supported against full relative path */
export function matchGlob(path: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

// silence unused import warnings in some bundlers
export type { GraphEdge, GraphNode };
