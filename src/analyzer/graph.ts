import type {
  AnalysisRules,
  DependencyGraph,
  GraphEdge,
  GraphNode,
  Granularity,
  ClusterRule,
  ImportRef,
  SourceFile,
} from "./types.js";
import { clusterKeyFor, majorityKey } from "./cluster.js";
import { buildResolutionIndex, resolveImport } from "./resolve.js";
import { classId } from "./scanners/base.js";
import { copyLayerFields, majorityOf } from "./layers.js";

function shouldSkipImport(file: SourceFile, imp: ImportRef): boolean {
  // Bare `using Namespace;` is ambiguous across many files — prefer type refs.
  return file.language === "csharp" && imp.kind === "using";
}

/** ファイル間の(重複なし)依存。粒度に依存しない層集計用。 */
export function computeFileEdges(files: SourceFile[]): { from: SourceFile; to: SourceFile }[] {
  const index = buildResolutionIndex(files);
  const seen = new Set<string>();
  const out: { from: SourceFile; to: SourceFile }[] = [];
  for (const file of files) {
    for (const imp of file.imports) {
      if (shouldSkipImport(file, imp)) continue;
      const target = resolveImport(file, imp, index);
      if (!target || target.id === file.id) continue;
      const k = `${file.id}>${target.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ from: file, to: target });
    }
  }
  return out;
}

export function buildGraph(
  root: string,
  files: SourceFile[],
  granularity: Granularity = "file",
  clusters?: ClusterRule[],
): DependencyGraph {
  for (const f of files) {
    if (!f.clusterKey) f.clusterKey = clusterKeyFor(f, clusters);
  }
  const index = buildResolutionIndex(files);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  const addNode = (n: GraphNode) => {
    if (nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };

  const addEdge = (e: GraphEdge) => {
    if (edgeIds.has(e.id)) return;
    // skip self-loops for clarity
    if (e.source === e.target) return;
    edgeIds.add(e.id);
    edges.push(e);
  };

  // Directory aggregation helpers
  const ensureDirChain = (relPath: string) => {
    const parts = relPath.split("/");
    let parent: string | undefined;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      const id = `dir:${dirPath}`;
      addNode({
        id,
        label: parts[i]!,
        kind: "directory",
        path: dirPath,
        loc: 0,
        parentId: parent,
        groupKey: dirPath,
      });
      parent = id;
    }
    return parent;
  };

  if (granularity === "directory") {
    const dirLoc = new Map<string, number>();
    const depDirs = new Map<string, Set<string>>();

    for (const file of files) {
      const dir = pathDir(file.relativePath);
      dirLoc.set(dir, (dirLoc.get(dir) ?? 0) + file.loc);
    }

    for (const file of files) {
      const fromDir = pathDir(file.relativePath);
      for (const imp of file.imports) {
        if (shouldSkipImport(file, imp)) continue;
        const target = resolveImport(file, imp, index);
        if (!target) continue;
        const toDir = pathDir(target.relativePath);
        if (fromDir === toDir) continue;
        if (!depDirs.has(fromDir)) depDirs.set(fromDir, new Set());
        depDirs.get(fromDir)!.add(toDir);
      }
    }

    for (const [dir, loc] of dirLoc) {
      ensureDirChain(dir === "." ? "root/." : `${dir}/x`);
      const id = dir === "." ? "dir:." : `dir:${dir}`;
      addNode({
        id,
        label: dir === "." ? "(root)" : dir.split("/").pop()!,
        kind: "directory",
        path: dir,
        loc,
        groupKey: dir,
      });
    }

    for (const [from, tos] of depDirs) {
      for (const to of tos) {
        const source = from === "." ? "dir:." : `dir:${from}`;
        const target = to === "." ? "dir:." : `dir:${to}`;
        addEdge({
          id: `e:${source}->${target}`,
          source,
          target,
          kind: "imports",
        });
      }
    }
  } else if (granularity === "class") {
    for (const file of files) {
      const parent = ensureDirChain(file.relativePath);
      addNode({
        id: file.id,
        label: file.relativePath.split("/").pop()!,
        kind: "file",
        language: file.language,
        path: file.relativePath,
        loc: file.loc,
        parentId: parent,
        groupKey: pathDir(file.relativePath),
      });

      for (const cls of file.classes) {
        addNode({
          id: classId(file.relativePath, cls.name),
          label: cls.name,
          kind: "class",
          language: file.language,
          path: file.relativePath,
          loc: Math.max(1, Math.round(file.loc / Math.max(1, file.classes.length))),
          parentId: file.id,
          groupKey: file.relativePath,
        });
      }
    }

    // Edges: file imports + class name references across files
    for (const file of files) {
      for (const imp of file.imports) {
        if (shouldSkipImport(file, imp)) continue;
        const target = resolveImport(file, imp, index);
        if (!target) {
          // Unresolved module node (optional lightweight)
          continue;
        }
        if (imp.kind === "reference") {
          const name = (imp.moduleName ?? imp.raw).split(".").pop()!;
          const targetClass = target.classes.find((c) => c.name === name);
          const sourceClass = file.classes[0];
          if (targetClass && sourceClass) {
            const s = classId(file.relativePath, sourceClass.name);
            const t = classId(target.relativePath, targetClass.name);
            addEdge({
              id: `e:${s}->${t}:${imp.line}`,
              source: s,
              target: t,
              kind: "references",
              detail: `${file.relativePath}:${imp.line}`,
            });
            continue;
          }
        }
        addEdge({
          id: `e:${file.id}->${target.id}:${imp.line}`,
          source: file.id,
          target: target.id,
          kind: "imports",
          detail: `${file.relativePath}:${imp.line} → ${imp.raw}`,
        });
      }
    }
  } else {
    // file granularity (default)
    for (const file of files) {
      const parent = ensureDirChain(file.relativePath);
      addNode({
        id: file.id,
        label: file.relativePath.split("/").pop()!,
        kind: "file",
        language: file.language,
        path: file.relativePath,
        loc: file.loc,
        parentId: parent,
        groupKey: pathDir(file.relativePath),
      });
    }

    // Accumulate directory LOC
    for (const n of nodes) {
      if (n.kind === "directory" && n.path) {
        n.loc = files
          .filter((f) => f.relativePath.startsWith(n.path === "." ? "" : `${n.path}/`) || pathDir(f.relativePath) === n.path)
          .reduce((s, f) => s + f.loc, 0);
      }
    }

    for (const file of files) {
      for (const imp of file.imports) {
        if (shouldSkipImport(file, imp)) continue;
        const target = resolveImport(file, imp, index);
        if (!target) continue;
        imp.resolvedPath = target.relativePath;
        addEdge({
          id: `e:${file.id}->${target.id}:${imp.raw}:${imp.line}`,
          source: file.id,
          target: target.id,
          kind: imp.kind === "reference" ? "references" : "imports",
          detail: `${file.relativePath}:${imp.line} → ${imp.raw}`,
        });
      }
    }
  }

  assignNodeClusters(nodes, files, granularity);

  return {
    nodes,
    edges,
    files,
    root,
    generatedAt: new Date().toISOString(),
  };
}

function assignNodeClusters(
  nodes: GraphNode[],
  files: SourceFile[],
  granularity: Granularity,
): void {
  const fileByPath = new Map(files.map((f) => [f.relativePath, f]));
  // per directory: keys of direct files, and of all descendant files
  const layerDirect = new Map<string, (string | undefined)[]>();
  const layerAll = new Map<string, (string | undefined)[]>();
  const featAll = new Map<string, (string | undefined)[]>();
  const direct = new Map<string, string[]>();
  const all = new Map<string, string[]>();
  for (const f of files) {
    const key = f.clusterKey!;
    const d = pathDir(f.relativePath);
    if (!direct.has(d)) direct.set(d, []);
    direct.get(d)!.push(key);
    const parts = f.relativePath.split("/");
    const push = (p: string) => {
      if (!all.has(p)) all.set(p, []);
      all.get(p)!.push(key);
    };
    push(".");
    for (let i = 1; i < parts.length; i++) push(parts.slice(0, i).join("/"));
    const pushL = (m: Map<string, (string | undefined)[]>, p: string, v: string | undefined) => {
      if (!m.has(p)) m.set(p, []);
      m.get(p)!.push(v);
    };
    pushL(layerDirect, d, f.layerKey);
    pushL(layerAll, ".", f.layerKey);
    pushL(featAll, ".", f.featureKey);
    for (let i = 1; i < parts.length; i++) {
      pushL(layerAll, parts.slice(0, i).join("/"), f.layerKey);
      pushL(featAll, parts.slice(0, i).join("/"), f.featureKey);
    }
  }
  for (const n of nodes) {
    if (n.kind === "directory") {
      const p = n.path ?? ".";
      const keys =
        (granularity === "directory" ? direct.get(p) : undefined) ?? all.get(p) ?? [];
      n.clusterKey = majorityKey(keys);
      n.layerKey = majorityOf((granularity === "directory" ? layerDirect.get(p) : undefined) ?? layerAll.get(p) ?? []);
      n.featureKey = majorityOf(featAll.get(p) ?? []);
    } else {
      const f = n.path ? fileByPath.get(n.path) : undefined;
      if (f) {
        n.clusterKey = f.clusterKey;
        copyLayerFields(n, f);
      }
    }
  }
}

function pathDir(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? "." : rel.slice(0, idx);
}

export function filterGraphByCollapsedDirs(
  graph: DependencyGraph,
  collapsed: Set<string>,
): DependencyGraph {
  // Collapse: replace files under a collapsed dir with the dir node, rewrite edges
  if (collapsed.size === 0) return graph;

  const nodes: GraphNode[] = [];
  const mapId = new Map<string, string>();

  for (const n of graph.nodes) {
    if (n.kind === "directory") {
      nodes.push(n);
      continue;
    }
    const rel = n.path ?? "";
    let collapsedTo: string | undefined;
    for (const dir of collapsed) {
      if (rel === dir || rel.startsWith(`${dir}/`)) {
        // pick deepest matching collapsed dir
        if (!collapsedTo || dir.length > collapsedTo.length) collapsedTo = dir;
      }
    }
    if (collapsedTo) {
      mapId.set(n.id, `dir:${collapsedTo}`);
    } else {
      nodes.push(n);
      mapId.set(n.id, n.id);
    }
  }

  // Ensure collapsed dirs present
  for (const dir of collapsed) {
    if (!nodes.find((n) => n.id === `dir:${dir}`)) {
      const existing = graph.nodes.find((n) => n.id === `dir:${dir}`);
      if (existing) nodes.push(existing);
    }
  }

  const edgeIds = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of graph.edges) {
    const s = mapId.get(e.source) ?? e.source;
    const t = mapId.get(e.target) ?? e.target;
    if (s === t) continue;
    const id = `e:${s}->${t}`;
    if (edgeIds.has(id)) continue;
    edgeIds.add(id);
    edges.push({ ...e, id, source: s, target: t });
  }

  return { ...graph, nodes, edges };
}

export function defaultRules(): AnalysisRules {
  return {
    hub: { degreeThreshold: 8 },
    bloat: { locThreshold: 400 },
    orphans: { ignore: ["**/test/**", "**/tests/**", "**/*_test.*", "**/main.*"] },
    layers: [],
  };
}
