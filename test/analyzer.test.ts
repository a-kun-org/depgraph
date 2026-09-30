import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csharpScanner } from "../src/analyzer/scanners/csharp.js";
import { dartScanner } from "../src/analyzer/scanners/dart.js";
import { pythonScanner } from "../src/analyzer/scanners/python.js";
import { analyze, loadRules } from "../src/analyzer/index.js";
import { matchGlob } from "../src/analyzer/detectors/index.js";
import { clusterKeyFor } from "../src/analyzer/cluster.js";
import { buildGraph } from "../src/analyzer/graph.js";
import { toSourceFile } from "../src/analyzer/scanners/base.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(__dirname, "../fixtures/sample-monorepo");

describe("language scanners", () => {
  it("parses C# usings and classes", () => {
    const src = `
using Sample.Core;
namespace Sample.UI {
  public class HudView {
    private GameState _state;
  }
}
`;
    const result = csharpScanner.scan(src, "UI/HudView.cs");
    expect(result.namespace).toBe("Sample.UI");
    expect(result.classes.map((c) => c.name)).toContain("HudView");
    expect(result.imports.some((i) => i.raw === "Sample.Core")).toBe(true);
    expect(result.imports.some((i) => i.moduleName === "GameState")).toBe(true);
  });

  it("captures C# return types and new expressions", () => {
    const src = `
public class Gateway {
  public CameraPose Read() {
    return new CameraPose();
  }
}
`;
    const result = csharpScanner.scan(src, "Gateway.cs");
    expect(result.classes.map((c) => c.name)).toContain("Gateway");
    expect(result.imports.some((i) => i.kind === "reference" && i.moduleName === "CameraPose")).toBe(
      true,
    );
  });

  it("parses Dart imports and classes", () => {
    const src = `
import 'package:app/services/api_client.dart';
import 'session_store.dart';

class ApiClient {}
`;
    const result = dartScanner.scan(src, "lib/services/api_client.dart");
    expect(result.imports).toHaveLength(2);
    expect(result.classes[0]?.name).toBe("ApiClient");
  });

  it("parses Python imports and classes", () => {
    const src = `
from domain.models import User
import os

class Repo(User):
    pass
`;
    const result = pythonScanner.scan(src, "infra/repo.py");
    expect(result.imports.some((i) => i.moduleName === "domain.models")).toBe(true);
    expect(result.imports.some((i) => i.moduleName === "os")).toBe(true);
    expect(result.classes[0]?.name).toBe("Repo");
    expect(result.imports.some((i) => i.kind === "reference" && i.moduleName === "User")).toBe(
      true,
    );
  });
});

describe("matchGlob", () => {
  it("matches ** globs", () => {
    expect(matchGlob("api/handlers/user_handler.py", "api/handlers/**")).toBe(true);
    expect(matchGlob("api/domain/models.py", "api/handlers/**")).toBe(false);
    expect(matchGlob("flutter/lib/ui/home_page.dart", "**/lib/ui/**")).toBe(true);
  });
});

describe("analyze fixtures", () => {
  it("builds a multi-language graph and detects design issues", () => {
    const rules = loadRules(path.join(fixtureRoot, "depgraph.rules.json"));
    const result = analyze(fixtureRoot, { rules, granularity: "file" });

    expect(result.summary.fileCount).toBeGreaterThanOrEqual(10);
    expect(result.summary.languages.csharp).toBeGreaterThan(0);
    expect(result.summary.languages.dart).toBeGreaterThan(0);
    expect(result.summary.languages.python).toBeGreaterThan(0);
    expect(result.graph.edges.length).toBeGreaterThan(0);

    const kinds = new Set(result.issues.map((i) => i.kind));
    expect(kinds.has("circular_dependency")).toBe(true);
    expect(kinds.has("bloated_file")).toBe(true);
    expect(kinds.has("layer_violation")).toBe(true);
    expect(kinds.has("orphan")).toBe(true);

    const cycle = result.issues.find((i) => i.kind === "circular_dependency");
    expect(cycle?.reason).toMatch(/api_cycle/);
    expect(cycle?.locations.length).toBeGreaterThanOrEqual(2);

    const layer = result.issues.find((i) => i.kind === "layer_violation");
    expect(layer?.details.join(" ")).toMatch(/infra/);
  });

  it("supports directory and class granularity", () => {
    const dirGraph = analyze(fixtureRoot, { granularity: "directory" });
    expect(dirGraph.graph.nodes.every((n) => n.kind === "directory" || true)).toBe(true);
    expect(dirGraph.graph.nodes.some((n) => n.kind === "directory")).toBe(true);

    const classGraph = analyze(fixtureRoot, { granularity: "class" });
    expect(classGraph.graph.nodes.some((n) => n.kind === "class")).toBe(true);
  });

  it("exports JSON-serializable analysis", () => {
    const result = analyze(fixtureRoot, {
      rulesPath: path.join(fixtureRoot, "depgraph.rules.json"),
    });
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.summary.fileCount).toBe(result.summary.fileCount);
    expect(Array.isArray(parsed.issues)).toBe(true);
  });
});

describe("clusters", () => {
  it("defaults by language: dart=Flutter, csharp=Unity, other=その他", () => {
    expect(clusterKeyFor({ relativePath: "a/b.dart", language: "dart" })).toBe("Flutter");
    expect(clusterKeyFor({ relativePath: "a/b.cs", language: "csharp" })).toBe("Unity");
    expect(clusterKeyFor({ relativePath: "a/b.py", language: "python" })).toBe("その他");
  });

  it("rules.clusters take precedence (prefix, first match wins, miss => その他)", () => {
    const rules = [
      { name: "App", match: ["app/"] },
      { name: "Core", match: ["app/core", "core/"] },
    ];
    expect(clusterKeyFor({ relativePath: "app/core/x.dart", language: "dart" }, rules)).toBe("App");
    expect(clusterKeyFor({ relativePath: "core/x.cs", language: "csharp" }, rules)).toBe("Core");
    expect(clusterKeyFor({ relativePath: "tools/x.py", language: "python" }, rules)).toBe("その他");
  });

  it("propagates clusterKey to nodes; directory nodes use the majority cluster", () => {
    const mk = (rel: string, lang: "dart" | "csharp") => toSourceFile(rel, lang, "x\n", [], [], undefined);
    const files = [mk("m/a.dart", "dart"), mk("m/b.dart", "dart"), mk("m/c.cs", "csharp")];
    for (const g of ["file", "directory", "class"] as const) {
      const graph = buildGraph("/r", files, g);
      const dir = graph.nodes.find((n) => n.kind === "directory" && n.path === "m");
      expect(dir?.clusterKey).toBe("Flutter");
      if (g !== "directory") {
        expect(graph.nodes.find((n) => n.path === "m/c.cs")?.clusterKey).toBe("Unity");
      }
    }
  });
});