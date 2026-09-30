import type { Language, SourceFile, ClassInfo, ImportRef } from "../types.js";

export interface ScanResult {
  classes: ClassInfo[];
  imports: ImportRef[];
  namespace?: string;
}

export interface LanguageScanner {
  readonly language: Language;
  readonly extensions: string[];
  scan(content: string, relativePath: string): ScanResult;
}

export function countLoc(content: string): number {
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

export function fileId(relativePath: string): string {
  return `file:${relativePath.replace(/\\/g, "/")}`;
}

export function classId(relativePath: string, name: string): string {
  return `class:${relativePath.replace(/\\/g, "/")}:${name}`;
}

export function toSourceFile(
  relativePath: string,
  language: Language,
  content: string,
  classes: ClassInfo[],
  imports: ImportRef[],
  namespace?: string,
): SourceFile {
  const normalized = relativePath.replace(/\\/g, "/");
  return {
    id: fileId(normalized),
    path: normalized,
    relativePath: normalized,
    language,
    loc: countLoc(content),
    classes,
    imports,
    namespace,
  };
}
