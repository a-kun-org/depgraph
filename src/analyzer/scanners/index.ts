import { csharpScanner } from "./csharp.js";
import { dartScanner } from "./dart.js";
import { pythonScanner } from "./python.js";
import type { LanguageScanner } from "./base.js";

export const scanners: LanguageScanner[] = [
  csharpScanner,
  dartScanner,
  pythonScanner,
];

export function scannerForExtension(ext: string): LanguageScanner | undefined {
  const lower = ext.toLowerCase();
  return scanners.find((s) => s.extensions.includes(lower));
}

export { csharpScanner, dartScanner, pythonScanner };
export type { LanguageScanner } from "./base.js";
