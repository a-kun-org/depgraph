import type { ClassInfo, ImportRef } from "../types.js";
import type { LanguageScanner } from "./base.js";

/**
 * C# / Unity scanner.
 * Extracts using directives, namespaces, type declarations, and simple type refs.
 */
export const csharpScanner: LanguageScanner = {
  language: "csharp",
  extensions: [".cs"],

  scan(content, relativePath) {
    const imports: ImportRef[] = [];
    const classes: ClassInfo[] = [];
    const lines = content.split(/\r?\n/);
    let namespace: string | undefined;

    const knownBuiltin = new Set([
      "string",
      "int",
      "bool",
      "float",
      "double",
      "void",
      "object",
      "var",
      "Task",
      "List",
      "Dictionary",
      "IEnumerable",
      "Action",
      "Func",
      "MonoBehaviour",
      "ScriptableObject",
      "GameObject",
      "Transform",
      "Vector2",
      "Vector3",
      "Quaternion",
      "Color",
      "Debug",
    ]);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNo = i + 1;

      const nsMatch = line.match(/^\s*namespace\s+([A-Za-z_][\w.]*)/);
      if (nsMatch) {
        namespace = nsMatch[1];
        continue;
      }

      const usingMatch = line.match(/^\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/);
      if (usingMatch) {
        imports.push({
          raw: usingMatch[1]!,
          moduleName: usingMatch[1],
          line: lineNo,
          kind: "using",
        });
        continue;
      }

      const aliasMatch = line.match(/^\s*using\s+[A-Za-z_]\w*\s*=\s*([A-Za-z_][\w.]*)\s*;/);
      if (aliasMatch) {
        imports.push({
          raw: aliasMatch[1]!,
          moduleName: aliasMatch[1],
          line: lineNo,
          kind: "using",
        });
        continue;
      }

      const typeMatch = line.match(
        /^\s*(?:public|internal|private|protected|static|partial|abstract|sealed|readonly|\s)*\s*(class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/,
      );
      if (typeMatch) {
        const kind = typeMatch[1] as ClassInfo["kind"];
        const name = typeMatch[2]!;
        classes.push({
          name,
          qualifiedName: `${relativePath.replace(/\\/g, "/")}:${name}`,
          kind,
          line: lineNo,
        });
      }

      const baseMatch = line.match(
        /^\s*(?:public|internal|private|protected|static|partial|abstract|sealed|\s)*\s*(?:class|interface|struct|record)\s+[A-Za-z_]\w*\s*:\s*(.+?)(?:\{|$)/,
      );
      if (baseMatch) {
        const parts = baseMatch[1]!.split(",").map((p) => p.trim().replace(/<.*>/, ""));
        for (const part of parts) {
          const name = part.match(/^([A-Za-z_][\w.]*)/)?.[1];
          if (name && !knownBuiltin.has(name) && name !== "where") {
            imports.push({
              raw: name,
              moduleName: name,
              line: lineNo,
              kind: "reference",
            });
          }
        }
      }

      // Field / property type refs: private GameState _state;
      const fieldMatch = line.match(
        /^\s*(?:public|private|protected|internal|static|readonly|required|\s)+\s*([A-Za-z_][\w.]*)\s*<[^>]*>?\s+[A-Za-z_]\w*\s*(?:[=;{]|=>)/,
      );
      const fieldMatch2 = line.match(
        /^\s*(?:public|private|protected|internal|static|readonly|\s)+\s*([A-Za-z_][\w.]*)\s+[A-Za-z_]\w*\s*(?:[=;]|=>|\{)/,
      );
      const fm = fieldMatch || fieldMatch2;
      if (fm) {
        const name = fm[1]!;
        if (!knownBuiltin.has(name) && !["class", "interface", "struct", "enum", "namespace", "using", "return", "new"].includes(name)) {
          imports.push({
            raw: name,
            moduleName: name,
            line: lineNo,
            kind: "reference",
          });
        }
      }

      // Method signatures: public void Flush(TelemetryRecorder recorder)
      const methodMatch = line.match(
        /^\s*(?:public|private|protected|internal|static|virtual|override|\s)+\s*(?:[\w.<>,\[\]]+)\s+[A-Za-z_]\w*\s*\(([^)]*)\)/,
      );
      if (methodMatch?.[1]) {
        for (const part of methodMatch[1].split(",")) {
          const name = part.trim().split(/\s+/)[0]?.replace(/<.*>/, "");
          if (
            name &&
            !knownBuiltin.has(name) &&
            !["ref", "out", "in", "this", "params"].includes(name)
          ) {
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

    return { classes, imports, namespace };
  },
};
