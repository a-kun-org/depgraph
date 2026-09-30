import type { ClassInfo, ImportRef } from "../types.js";
import type { LanguageScanner } from "./base.js";

/**
 * Dart / Flutter scanner.
 */
export const dartScanner: LanguageScanner = {
  language: "dart",
  extensions: [".dart"],

  scan(content, relativePath) {
    const imports: ImportRef[] = [];
    const classes: ClassInfo[] = [];
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;

      const importMatch = line.match(
        /^\s*import\s+['"]([^'"]+)['"](?:\s+as\s+\w+)?(?:\s+show\s+[^;]+)?(?:\s+hide\s+[^;]+)?\s*;/,
      );
      if (importMatch) {
        const raw = importMatch[1];
        const isPackage = raw.startsWith("package:") || raw.startsWith("dart:");
        imports.push({
          raw,
          moduleName: isPackage ? raw : undefined,
          // Relative imports resolved later
          line: lineNo,
          kind: "import",
        });
        continue;
      }

      const exportMatch = line.match(/^\s*export\s+['"]([^'"]+)['"]\s*;/);
      if (exportMatch) {
        imports.push({
          raw: exportMatch[1],
          moduleName: exportMatch[1].startsWith("package:")
            ? exportMatch[1]
            : undefined,
          line: lineNo,
          kind: "import",
        });
        continue;
      }

      const partMatch = line.match(/^\s*part\s+['"]([^'"]+)['"]\s*;/);
      if (partMatch) {
        imports.push({
          raw: partMatch[1],
          line: lineNo,
          kind: "import",
        });
        continue;
      }

      const typeMatch = line.match(
        /^\s*(?:abstract\s+|base\s+|final\s+|sealed\s+|mixin\s+)?(?:class|mixin|enum|extension\s+type|extension)\s+([A-Za-z_]\w*)/,
      );
      if (typeMatch) {
        let kind: ClassInfo["kind"] = "class";
        if (/\bmixin\b/.test(line)) kind = "mixin";
        else if (/\benum\b/.test(line)) kind = "enum";
        else if (/\bextension\b/.test(line)) kind = "extension";
        classes.push({
          name: typeMatch[1],
          qualifiedName: `${relativePath.replace(/\\/g, "/")}:${typeMatch[1]}`,
          kind,
          line: lineNo,
        });
      }
    }

    return { classes, imports };
  },
};
