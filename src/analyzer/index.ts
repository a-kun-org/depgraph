import fs from "node:fs";
import path from "node:path";
import { clusterKeyFor, countCrossClusterEdges, summarizeClusters } from "./cluster.js";
import type { AnalysisResult, AnalysisRules, Granularity, SourceFile } from "./types.js";
import { scannerForExtension, scanners } from "./scanners/index.js";
import { toSourceFile } from "./scanners/base.js";
import { buildGraph, defaultRules } from "./graph.js";
import { assignLayersAndFeatures, summarizeLayers } from "./layers.js";
import { detectAll } from "./detectors/index.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "Library",
  "Temp",
  "obj",
  "bin",
  ".dart_tool",
  ".idea",
  ".vs",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "Pods",
]);

const CONFIG_CANDIDATES = ["depgraph.config.json", "depgraph.rules.json"];

export function resolveConfigPath(explicit?: string, searchRoot?: string): string | undefined {
  if (explicit) return path.resolve(explicit);
  const roots = [searchRoot, process.cwd()].filter(Boolean) as string[];
  for (const root of roots) {
    for (const name of CONFIG_CANDIDATES) {
      const p = path.join(root, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

export function loadRules(rulesPath?: string, searchRoot?: string): AnalysisRules {
  const base = defaultRules();
  const abs = resolveConfigPath(rulesPath, searchRoot);
  if (!abs) return base;
  if (!fs.existsSync(abs)) {
    throw new Error(`Rules file not found: ${abs}`);
  }
  const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as AnalysisRules;
  return {
    ...base,
    ...raw,
    hub: { ...base.hub, ...raw.hub },
    bloat: { ...base.bloat, ...raw.bloat },
    orphans: { ...base.orphans, ...raw.orphans },
    layers: raw.layers ?? base.layers,
    clusters: raw.clusters ?? base.clusters,
    archLayers: raw.archLayers ?? base.archLayers,
    featureRoots: raw.featureRoots ?? base.featureRoots,
  };
}

export function collectFiles(root: string, exclude: string[] = []): SourceFile[] {
  const excl = exclude.map((e) => e.replace(/\\/g, "/").replace(/\/+$/, ""));
  const absRoot = path.resolve(root);
  const results: SourceFile[] = [];
  const supported = new Set(scanners.flatMap((s) => s.extensions));

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const relDir = path.relative(absRoot, full).split(path.sep).join("/");
        if (excl.some((e) => e === entry.name || e === relDir)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!supported.has(ext)) continue;
      const scanner = scannerForExtension(ext);
      if (!scanner) continue;
      let content: string;
      try {
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const relativePath = path.relative(absRoot, full).split(path.sep).join("/");
      const { classes, imports, namespace } = scanner.scan(content, relativePath);
      results.push(
        toSourceFile(relativePath, scanner.language, content, classes, imports, namespace),
      );
    }
  }

  walk(absRoot);
  return results;
}

export function analyze(
  root: string,
  options: {
    rules?: AnalysisRules;
    rulesPath?: string;
    granularity?: Granularity;
    exclude?: string[];
  } = {},
): AnalysisResult {
  const absRoot = path.resolve(root);
  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    throw new Error(`Target directory not found: ${absRoot}`);
  }

  const rules = options.rules ?? loadRules(options.rulesPath, absRoot);
  const files = collectFiles(absRoot, options.exclude ?? []);
  const granularity = options.granularity ?? "file";
  for (const f of files) f.clusterKey = clusterKeyFor(f, rules.clusters);
  assignLayersAndFeatures(files, rules);
  const graph = buildGraph(absRoot, files, granularity, rules.clusters);
  const issues = detectAll(graph, rules);

  const languages: Record<string, number> = {};
  for (const f of files) {
    languages[f.language] = (languages[f.language] ?? 0) + 1;
  }

  const arch = summarizeLayers(files, rules, issues);

  return {
    graph,
    issues,
    rules,
    summary: {
      fileCount: files.length,
      edgeCount: graph.edges.length,
      issueCount: issues.length,
      languages,
      clusters: summarizeClusters(files, rules.clusters),
      crossClusterEdges: countCrossClusterEdges(graph.nodes, graph.edges),
      layers: arch.layers,
      layerMatrix: arch.layerMatrix,
      layerViolations: arch.layerViolations,
      features: arch.features,
      unclassifiedRate: arch.unclassifiedRate,
      unclassifiedTopDirs: arch.unclassifiedTopDirs,
    },
  };
}

export function analysisToJson(result: AnalysisResult): string {
  return JSON.stringify(result, null, 2);
}

export function printUnclassifiedReport(result: AnalysisResult): void {
  const rate = (result.summary.unclassifiedRate * 100).toFixed(1);
  console.log(`未分類率: ${rate}% (${Math.round(result.summary.unclassifiedRate * result.summary.fileCount)} / ${result.summary.fileCount})`);
  if (result.summary.unclassifiedTopDirs.length === 0) {
    console.log("未分類ディレクトリはありません。");
    return;
  }
  console.log("未分類の多いディレクトリ(上位10):");
  for (const d of result.summary.unclassifiedTopDirs) {
    console.log(`  ${d.count}\t${d.path}`);
  }
}
