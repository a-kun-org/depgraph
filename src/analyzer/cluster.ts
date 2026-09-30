import type { ClusterRule, ClusterSummary, GraphEdge, GraphNode, SourceFile } from "./types.js";

export const CLUSTER_FLUTTER = "Flutter";
export const CLUSTER_UNITY = "Unity";
export const CLUSTER_OTHER = "その他";

export const DEFAULT_CLUSTER_COLORS: Record<string, string> = {
  [CLUSTER_FLUTTER]: "#4fc3f7",
  [CLUSTER_UNITY]: "#81c784",
  [CLUSTER_OTHER]: "#b39ddb",
};

const PALETTE = ["#f28b82", "#fbbc04", "#78d9ec", "#c58af9", "#a8dab5", "#fdcfe8"];

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Cluster for a file: rules.clusters (prefix match, first wins, miss => その他) else by language. */
export function clusterKeyFor(
  file: Pick<SourceFile, "relativePath" | "language">,
  clusters?: ClusterRule[],
): string {
  if (clusters && clusters.length > 0) {
    const rel = norm(file.relativePath);
    for (const c of clusters) {
      if ((c.match ?? []).some((m) => rel.startsWith(norm(m)))) return c.name;
    }
    return CLUSTER_OTHER;
  }
  if (file.language === "dart") return CLUSTER_FLUTTER;
  if (file.language === "csharp") return CLUSTER_UNITY;
  return CLUSTER_OTHER;
}

export function clusterColor(key: string, clusters?: ClusterRule[], index = 0): string {
  const rule = clusters?.find((c) => c.name === key);
  if (rule?.color) return rule.color;
  return DEFAULT_CLUSTER_COLORS[key] ?? PALETTE[index % PALETTE.length]!;
}

export function summarizeClusters(
  files: SourceFile[],
  clusters?: ClusterRule[],
): ClusterSummary[] {
  const counts = new Map<string, number>();
  const order: string[] =
    clusters && clusters.length > 0
      ? [...clusters.map((c) => c.name), CLUSTER_OTHER]
      : [CLUSTER_FLUTTER, CLUSTER_UNITY, CLUSTER_OTHER];
  for (const k of order) counts.set(k, 0);
  for (const f of files) {
    const k = f.clusterKey ?? clusterKeyFor(f, clusters);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, fileCount], i) => ({
    key,
    fileCount,
    color: clusterColor(key, clusters, i),
  }));
}

export function countCrossClusterEdges(nodes: GraphNode[], edges: GraphEdge[]): number {
  const byId = new Map(nodes.map((n) => [n.id, n.clusterKey]));
  let n = 0;
  for (const e of edges) {
    if (e.kind === "contains") continue;
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (a && b && a !== b) n++;
  }
  return n;
}

/** Majority cluster among a list of keys; ties resolved by first occurrence. */
export function majorityKey(keys: string[]): string | undefined {
  const c = new Map<string, number>();
  let best: string | undefined;
  for (const k of keys) {
    const v = (c.get(k) ?? 0) + 1;
    c.set(k, v);
    if (best === undefined || v > (c.get(best) ?? 0)) best = k;
  }
  return best;
}