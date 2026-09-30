import path from "node:path";
import type { SourceFile, ImportRef } from "./types.js";

export interface ResolutionIndex {
  byRelative: Map<string, SourceFile>;
  byModuleHint: Map<string, SourceFile[]>;
  classOwners: Map<string, SourceFile>;
  byNamespace: Map<string, SourceFile[]>;
}

/** Build lookup maps for resolving imports to files within the analyzed tree. */
export function buildResolutionIndex(files: SourceFile[]): ResolutionIndex {
  const byRelative = new Map<string, SourceFile>();
  const byModuleHint = new Map<string, SourceFile[]>();
  const classOwners = new Map<string, SourceFile>();
  const byNamespace = new Map<string, SourceFile[]>();

  for (const file of files) {
    byRelative.set(file.relativePath, file);

    if (file.language === "python") {
      let mod = file.relativePath.replace(/\.py$/, "").replace(/\//g, ".");
      if (mod.endsWith(".__init__")) mod = mod.slice(0, -".__init__".length);
      addHint(byModuleHint, mod, file);
      const parts = mod.split(".");
      for (let i = 0; i < parts.length; i++) {
        addHint(byModuleHint, parts.slice(i).join("."), file);
      }
    }

    if (file.language === "csharp") {
      const noExt = file.relativePath.replace(/\.cs$/, "");
      addHint(byModuleHint, noExt.replace(/\//g, "."), file);
      const base = path.posix.basename(noExt);
      addHint(byModuleHint, base, file);
      if (file.namespace) {
        addHint(byNamespace, file.namespace, file);
        addHint(byModuleHint, file.namespace, file);
      }
    }

    if (file.language === "dart") {
      addHint(byModuleHint, file.relativePath, file);
      const base = path.posix.basename(file.relativePath, ".dart");
      addHint(byModuleHint, base, file);
    }

    for (const cls of file.classes) {
      classOwners.set(cls.name, file);
      classOwners.set(cls.qualifiedName, file);
    }
  }

  return { byRelative, byModuleHint, classOwners, byNamespace };
}

function addHint(map: Map<string, SourceFile[]>, key: string, file: SourceFile) {
  const list = map.get(key) ?? [];
  if (!list.includes(file)) list.push(file);
  map.set(key, list);
}

export function resolveImport(
  from: SourceFile,
  imp: ImportRef,
  index: ResolutionIndex,
): SourceFile | undefined {
  if (imp.raw.startsWith(".") || (imp.raw.startsWith("/") && from.language === "dart")) {
    const resolved = resolveRelative(from.relativePath, imp.raw, from.language);
    if (resolved) {
      const hit =
        index.byRelative.get(resolved) ||
        index.byRelative.get(`${resolved}.dart`) ||
        index.byRelative.get(`${resolved}.py`) ||
        index.byRelative.get(`${resolved}.cs`) ||
        index.byRelative.get(`${resolved}/__init__.py`);
      if (hit) return hit;
    }
  }

  // Dart relative without leading ./ sometimes
  if (from.language === "dart" && !imp.raw.startsWith("package:") && !imp.raw.startsWith("dart:")) {
    const resolved = resolveRelative(from.relativePath, imp.raw, from.language);
    if (resolved) {
      const hit =
        index.byRelative.get(resolved) ||
        index.byRelative.get(resolved.endsWith(".dart") ? resolved : `${resolved}.dart`);
      if (hit) return hit;
    }
  }

  if (imp.raw.startsWith("package:")) {
    const without = imp.raw.replace(/^package:[^/]+\//, "");
    for (const [rel, file] of index.byRelative) {
      if (rel.endsWith(without) || rel.endsWith(`lib/${without}`)) return file;
    }
  }

  if (imp.moduleName) {
    const mod = imp.moduleName.replace(/^\.+/, "");

    if (imp.moduleName.startsWith(".") && from.language === "python") {
      const dots = imp.moduleName.match(/^\.+/)?.[0].length ?? 0;
      const rest = imp.moduleName.slice(dots);
      const fromDir = path.posix.dirname(from.relativePath);
      const up = path.posix.normalize(
        path.posix.join(fromDir, ...Array(Math.max(0, dots - 1)).fill("..")),
      );
      const candidate = rest
        ? path.posix.join(up === "." ? "" : up, rest.replace(/\./g, "/"))
        : up;
      const cleaned = candidate.replace(/^\//, "");
      const hit =
        index.byRelative.get(`${cleaned}.py`) ||
        index.byRelative.get(`${cleaned}/__init__.py`);
      if (hit) return hit;
    }

    // C# using Namespace — prefer a file in that namespace (not self)
    if (from.language === "csharp" && imp.kind === "using") {
      const nsFiles = index.byNamespace.get(mod)?.filter((f) => f.id !== from.id);
      if (nsFiles && nsFiles.length === 1) return nsFiles[0];
      if (nsFiles && nsFiles.length > 1) return pickClosest(from.relativePath, nsFiles);
    }

    const hints = index.byModuleHint.get(mod);
    if (hints?.length === 1 && hints[0]!.id !== from.id) return hints[0];
    if (hints && hints.length > 1) {
      const sameLang = hints.filter((h) => h.language === from.language && h.id !== from.id);
      if (sameLang.length === 1) return sameLang[0];
      if (sameLang.length > 1) return pickClosest(from.relativePath, sameLang);
    }

    const asPath = mod.replace(/\./g, "/");
    const hit =
      index.byRelative.get(`${asPath}.py`) ||
      index.byRelative.get(`${asPath}/__init__.py`) ||
      index.byRelative.get(`${asPath}.cs`) ||
      index.byRelative.get(`${asPath}.dart`);
    if (hit && hit.id !== from.id) return hit;

    // Suffix path match: domain.models → **/domain/models.py
    const suffixPy = `${asPath}.py`;
    const suffixInit = `${asPath}/__init__.py`;
    for (const [rel, file] of index.byRelative) {
      if (file.id === from.id) continue;
      if (rel === suffixPy || rel.endsWith(`/${suffixPy}`)) return file;
      if (rel === suffixInit || rel.endsWith(`/${suffixInit}`)) return file;
      if (rel.endsWith(`/${asPath}.cs`) || rel.endsWith(`/${asPath}.dart`)) return file;
    }

    const owner = index.classOwners.get(mod.split(".").pop()!);
    if (owner && owner.id !== from.id) return owner;
  }

  return undefined;
}

function resolveRelative(
  fromPath: string,
  raw: string,
  language: SourceFile["language"],
): string | undefined {
  if (language === "dart" && (raw.startsWith("package:") || raw.startsWith("dart:"))) {
    return undefined;
  }
  const fromDir = path.posix.dirname(fromPath);
  const joined = path.posix.normalize(path.posix.join(fromDir, raw));
  return joined.replace(/^\.\//, "");
}

function pickClosest(from: string, candidates: SourceFile[]): SourceFile {
  const fromParts = from.split("/");
  let best = candidates[0]!;
  let bestScore = -1;
  for (const c of candidates) {
    const parts = c.relativePath.split("/");
    let score = 0;
    for (let i = 0; i < Math.min(parts.length, fromParts.length); i++) {
      if (parts[i] === fromParts[i]) score++;
      else break;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
