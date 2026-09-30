import fs from "node:fs";
import path from "node:path";
import type { AssemblyInfo } from "./types.js";

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

interface RawAssembly {
  name: string;
  path: string;
  directory: string;
  references: string[];
  guid?: string;
}

/**
 * .asmdef を集める。ソースファイルとしては数えない。
 * references はアセンブリ名、または `GUID:` + .asmdef.meta の guid で解決する。
 */
export function collectAssemblies(root: string, exclude: string[] = []): AssemblyInfo[] {
  const absRoot = path.resolve(root);
  const excl = exclude.map((e) => e.replace(/\\/g, "/").replace(/\/+$/, ""));
  const raw: RawAssembly[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const relDir = path.relative(absRoot, full).split(path.sep).join("/");
        if (excl.some((e) => e === entry.name || e === relDir)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".asmdef") continue;
      const parsed = readAsmdef(full);
      if (!parsed) continue;
      const rel = path.relative(absRoot, full).split(path.sep).join("/");
      const directory = path.posix.dirname(rel);
      raw.push({
        name: parsed.name || path.basename(entry.name, ".asmdef"),
        path: rel,
        directory: directory === "." ? "" : directory,
        references: parsed.references,
        guid: readGuid(full + ".meta"),
      });
    }
  }

  walk(absRoot);

  const used = new Set<string>();
  const assemblies: AssemblyInfo[] = raw.map((a) => {
    let id = `asm:${a.name}`;
    if (used.has(id)) id = `asm:${a.name}:${a.directory}`;
    used.add(id);
    return {
      id,
      name: a.name,
      path: a.path,
      directory: a.directory,
      references: a.references,
      resolvedReferences: [],
      guid: a.guid,
    };
  });

  const byName = new Map<string, AssemblyInfo>();
  const byGuid = new Map<string, AssemblyInfo>();
  for (const a of assemblies) {
    if (!byName.has(a.name)) byName.set(a.name, a);
    if (a.guid) byGuid.set(a.guid.toLowerCase(), a);
  }

  for (const a of assemblies) {
    const seen = new Set<string>();
    for (const ref of a.references) {
      const target = resolveReference(ref, byName, byGuid);
      if (!target || target.id === a.id || seen.has(target.id)) continue;
      seen.add(target.id);
      a.resolvedReferences.push(target.id);
    }
  }

  return assemblies;
}

/** ファイルを支配する asmdef。より深いディレクトリを優先する（Unity と同じ）。 */
export function assemblyForFile(
  relativePath: string,
  assemblies: AssemblyInfo[],
): AssemblyInfo | undefined {
  const rel = relativePath.replace(/\\/g, "/");
  let best: AssemblyInfo | undefined;
  let bestScore = -1;
  for (const a of assemblies) {
    const dir = a.directory;
    const covers = dir === "" || rel === dir || rel.startsWith(`${dir}/`);
    if (!covers) continue;
    const score = dir.length;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

function readAsmdef(file: string): { name: string; references: string[] } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return undefined;
  }
  let json: { name?: unknown; references?: unknown };
  try {
    json = JSON.parse(text) as { name?: unknown; references?: unknown };
  } catch {
    return undefined;
  }
  const references = Array.isArray(json.references)
    ? json.references.filter((r): r is string => typeof r === "string" && r.length > 0)
    : [];
  return {
    name: typeof json.name === "string" ? json.name : "",
    references,
  };
}

function readGuid(metaPath: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(metaPath, "utf8");
  } catch {
    return undefined;
  }
  return text.match(/^guid:\s*([0-9a-fA-F]+)\s*$/m)?.[1]?.toLowerCase();
}

function resolveReference(
  raw: string,
  byName: Map<string, AssemblyInfo>,
  byGuid: Map<string, AssemblyInfo>,
): AssemblyInfo | undefined {
  const guid = /^GUID:([0-9a-fA-F]+)$/i.exec(raw.trim())?.[1]?.toLowerCase();
  if (guid) return byGuid.get(guid);
  return byName.get(raw.trim());
}
