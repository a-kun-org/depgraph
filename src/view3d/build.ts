import path from "node:path";
import { assemblyForFile } from "../analyzer/asmdef.js";
import { majorityKey } from "../analyzer/cluster.js";
import { buildResolutionIndex, resolveImport } from "../analyzer/resolve.js";
import type { AnalysisResult, ImportRef, SourceFile } from "../analyzer/types.js";
import { layoutPositions } from "./layout.js";

export type ViewEdgeKind = "using" | "reference" | "import" | "asmdef";

export interface View3dNode {
  id: string;
  label: string;
  layer: string;
  color: string;
  cluster: string;
  path: string;
  language: string;
  loc: number;
  /** ファイルノードは 1、アセンブリは含まれるファイル数 */
  files: number;
  x: number;
  y: number;
  z: number;
}

export interface View3dEdge {
  source: string;
  target: string;
  kinds: ViewEdgeKind[];
}

export interface View3dGraph {
  nodes: View3dNode[];
  edges: View3dEdge[];
}

export interface View3dModel {
  title: string;
  root: string;
  generatedAt: string;
  layers: { key: string; color: string }[];
  file: View3dGraph;
  assembly: View3dGraph;
}

const KIND_ORDER: ViewEdgeKind[] = ["using", "reference", "import", "asmdef"];

/**
 * 解析結果から 3D 用のファイルグラフとアセンブリグラフを作る。
 * 2D グラフは C# の using を辺にしないが、ここでは using・型参照・import を解決して含める。
 * asmdef の references はアセンブリグラフに入れる。
 */
export function buildView3d(result: AnalysisResult): View3dModel {
  const files = result.graph.files;
  const colors = new Map(result.summary.layers.map((l) => [l.key, l.color]));
  const colorOf = (layer: string) => colors.get(layer) ?? "#94a3b8";

  const fileEdges = collectFileEdges(files);
  const fileNodes = place(
    files.map((file) => ({
      id: file.id,
      label: file.relativePath.split("/").pop() ?? file.relativePath,
      layer: file.layerKey || "未分類",
      color: colorOf(file.layerKey || "未分類"),
      cluster: file.clusterKey || "その他",
      path: file.relativePath,
      language: file.language,
      loc: file.loc,
      files: 1,
    })),
  );

  const asmNodesRaw: Omit<View3dNode, "x" | "y" | "z">[] = [];
  const unitOf = new Map<string, string>();

  for (const asm of result.assemblies) {
    const members = files.filter((f) => assemblyForFile(f.relativePath, result.assemblies)?.id === asm.id);
    for (const f of members) unitOf.set(f.id, asm.id);
    const layer = majorityKey(members.map((f) => f.layerKey || "未分類")) ?? "未分類";
    const cluster = majorityKey(members.map((f) => f.clusterKey || "その他")) ?? "その他";
    asmNodesRaw.push({
      id: asm.id,
      label: asm.name,
      layer,
      color: colorOf(layer),
      cluster,
      path: asm.path,
      language: "asmdef",
      loc: members.reduce((s, f) => s + f.loc, 0),
      files: members.length,
    });
  }

  const loose = new Map<string, SourceFile[]>();
  for (const file of files) {
    if (unitOf.has(file.id)) continue;
    const cluster = file.clusterKey || "その他";
    const id = `loose:${cluster}`;
    unitOf.set(file.id, id);
    const list = loose.get(id) ?? [];
    list.push(file);
    loose.set(id, list);
  }
  const looseSuffix = result.assemblies.length > 0 ? "（asmdef外）" : "（asmdefなし）";
  for (const [id, members] of loose) {
    const cluster = members[0]?.clusterKey || "その他";
    const layer = majorityKey(members.map((f) => f.layerKey || "未分類")) ?? "未分類";
    const langs = new Set(members.map((f) => f.language));
    asmNodesRaw.push({
      id,
      label: `${cluster}${looseSuffix}`,
      layer,
      color: colorOf(layer),
      cluster,
      path: "",
      language: langs.size === 1 ? [...langs][0]! : "mixed",
      loc: members.reduce((s, f) => s + f.loc, 0),
      files: members.length,
    });
  }

  const asmEdges = new Map<string, View3dEdge>();
  for (const asm of result.assemblies) {
    for (const targetId of asm.resolvedReferences) {
      addKind(asmEdges, asm.id, targetId, "asmdef");
    }
  }
  for (const edge of fileEdges) {
    const source = unitOf.get(edge.source);
    const target = unitOf.get(edge.target);
    if (!source || !target) continue;
    for (const kind of edge.kinds) addKind(asmEdges, source, target, kind);
  }

  const present = new Set<string>();
  for (const n of fileNodes) present.add(n.layer);
  for (const n of asmNodesRaw) present.add(n.layer);
  const layers: { key: string; color: string }[] = [];
  for (const layer of result.summary.layers) {
    if (present.has(layer.key)) layers.push({ key: layer.key, color: layer.color });
  }
  for (const key of present) {
    if (!layers.some((l) => l.key === key)) layers.push({ key, color: colorOf(key) });
  }

  return {
    title: `depgraph 3D — ${path.basename(result.graph.root)}`,
    root: result.graph.root,
    generatedAt: result.graph.generatedAt,
    layers,
    file: { nodes: fileNodes, edges: fileEdges },
    assembly: { nodes: place(asmNodesRaw), edges: [...asmEdges.values()].sort(byEndpoint) },
  };
}

function collectFileEdges(files: SourceFile[]): View3dEdge[] {
  const index = buildResolutionIndex(files);
  const edges = new Map<string, View3dEdge>();
  for (const file of files) {
    for (const imp of file.imports) {
      const kind = kindOf(imp);
      for (const target of resolveTargets(file, imp, index)) {
        addKind(edges, file.id, target.id, kind);
      }
    }
  }
  return [...edges.values()].sort(byEndpoint);
}

function resolveTargets(
  file: SourceFile,
  imp: ImportRef,
  index: ReturnType<typeof buildResolutionIndex>,
): SourceFile[] {
  if (file.language === "csharp" && imp.kind === "using") {
    const mod = (imp.moduleName ?? imp.raw).replace(/^\.+/, "");
    const ns = index.byNamespace.get(mod)?.filter((f) => f.id !== file.id) ?? [];
    if (ns.length > 0) return ns;
  }
  const one = resolveImport(file, imp, index);
  if (!one || one.id === file.id) return [];
  return [one];
}

function kindOf(imp: ImportRef): ViewEdgeKind {
  if (imp.kind === "using") return "using";
  if (imp.kind === "reference") return "reference";
  return "import";
}

function addKind(map: Map<string, View3dEdge>, source: string, target: string, kind: ViewEdgeKind) {
  if (source === target) return;
  const key = `${source}\0${target}`;
  let edge = map.get(key);
  if (!edge) {
    edge = { source, target, kinds: [] };
    map.set(key, edge);
  }
  if (!edge.kinds.includes(kind)) {
    edge.kinds.push(kind);
    edge.kinds.sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
  }
}

function byEndpoint(a: View3dEdge, b: View3dEdge): number {
  return a.source.localeCompare(b.source) || a.target.localeCompare(b.target);
}

function place(nodes: Omit<View3dNode, "x" | "y" | "z">[]): View3dNode[] {
  const pos = layoutPositions(nodes.map((n) => ({ id: n.id, layer: n.layer })));
  return nodes.map((n) => {
    const p = pos.get(n.id) ?? { x: 0, y: 0, z: 0 };
    return { ...n, x: p.x, y: p.y, z: p.z };
  });
}
