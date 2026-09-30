import type { ClassInfo, ImportRef } from "../types.js";
import type { LanguageScanner } from "./base.js";

/**
 * Python scanner (stdlib + Lambda/API style projects).
 */
export const pythonScanner: LanguageScanner = {
  language: "python",
  extensions: [".py"],

  scan(content, relativePath) {
    const imports: ImportRef[] = [];
    const classes: ClassInfo[] = [];
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;

      // from x.y import z
      const fromMatch = line.match(
        /^\s*from\s+(\.*[A-Za-z_][\w.]*)\s+import\s+(.+)$/,
      );
      if (fromMatch) {
        const mod = fromMatch[1];
        imports.push({
          raw: `from ${mod} import ${fromMatch[2].trim()}`,
          moduleName: mod,
          line: lineNo,
          kind: "import",
        });
        continue;
      }

      // import x, y.z
      const importMatch = line.match(/^\s*import\s+(.+)$/);
      if (importMatch) {
        const parts = importMatch[1].split(",").map((p) => p.trim().split(/\s+as\s+/)[0].trim());
        for (const part of parts) {
          if (!part) continue;
          imports.push({
            raw: `import ${part}`,
            moduleName: part,
            line: lineNo,
            kind: "import",
          });
        }
        continue;
      }

      const classMatch = line.match(/^class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/);
      if (classMatch) {
        classes.push({
          name: classMatch[1],
          qualifiedName: `${relativePath.replace(/\\/g, "/")}:${classMatch[1]}`,
          kind: "class",
          line: lineNo,
        });
        if (classMatch[2]) {
          const bases = classMatch[2].split(",").map((b) => b.trim()).filter(Boolean);
          for (const base of bases) {
            const name = base.replace(/\[.*\]/, "").trim();
            if (name && name !== "object") {
              imports.push({
                raw: name,
                moduleName: name,
                line: lineNo,
                kind: "reference",
              });
            }
          }
        }
      }
    }

    return { classes, imports };
  },
};
