import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/analyzer/index.js";
import { assemblyForFile, collectAssemblies } from "../src/analyzer/asmdef.js";
import { buildView3d } from "../src/view3d/build.js";
import { render3dHtml } from "../src/view3d/html.js";
import { layoutPositions } from "../src/view3d/layout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const archRoot = path.join(__dirname, "../fixtures/arch-sample");
const sampleRoot = path.join(__dirname, "../fixtures/sample-monorepo");

describe("layoutPositions", () => {
  it("keeps layer clusters at the same height and spreads nodes inside each cluster", () => {
    const items = [
      ...["a", "b", "c", "d"].map((id) => ({ id: `p-${id}`, layer: "プレゼンテーション" })),
      ...["a", "b", "c", "d"].map((id) => ({ id: `i-${id}`, layer: "インフラ" })),
    ];
    const pos = layoutPositions(items);
    const group = (prefix: string) =>
      [...pos.entries()].filter(([id]) => id.startsWith(prefix)).map(([, p]) => p);

    const mean = (pts: { x: number; y: number; z: number }[]) => ({
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      z: pts.reduce((s, p) => s + p.z, 0) / pts.length,
    });
    const spreadY = (pts: { y: number }[]) =>
      Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));

    const presentation = group("p-");
    const infra = group("i-");
    const pc = mean(presentation);
    const ic = mean(infra);

    expect(Math.abs(pc.y - ic.y)).toBeLessThan(1.5);
    expect(spreadY(presentation)).toBeGreaterThan(1);
    expect(spreadY(infra)).toBeGreaterThan(1);
    expect(Math.hypot(pc.x - ic.x, pc.z - ic.z)).toBeGreaterThan(5);
    for (const p of presentation) {
      const own = Math.hypot(p.x - pc.x, p.y - pc.y, p.z - pc.z);
      const other = Math.hypot(p.x - ic.x, p.y - ic.y, p.z - ic.z);
      expect(own).toBeLessThan(other);
    }
  });
});

describe("asmdef", () => {
  it("resolves name and GUID references, and prefers the nested asmdef", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "depgraph-asm-"));
    try {
      const aDir = path.join(root, "A");
      const bDir = path.join(aDir, "Sub");
      fs.mkdirSync(bDir, { recursive: true });
      fs.writeFileSync(
        path.join(aDir, "A.asmdef"),
        JSON.stringify({ name: "AsmA", references: ["GUID:abcdefabcdefabcdefabcdefabcdefab"] }),
      );
      fs.writeFileSync(
        path.join(aDir, "A.asmdef.meta"),
        "fileFormatVersion: 2\nguid: 11111111111111111111111111111111\n",
      );
      fs.writeFileSync(
        path.join(bDir, "B.asmdef"),
        JSON.stringify({ name: "AsmB", references: ["AsmA"] }),
      );
      fs.writeFileSync(
        path.join(bDir, "B.asmdef.meta"),
        "fileFormatVersion: 2\nguid: abcdefabcdefabcdefabcdefabcdefab\n",
      );
      fs.mkdirSync(path.join(root, "Library"));
      fs.writeFileSync(
        path.join(root, "Library", "Skip.asmdef"),
        JSON.stringify({ name: "Skip", references: [] }),
      );

      const asms = collectAssemblies(root);
      expect(asms.map((a) => a.name).sort()).toEqual(["AsmA", "AsmB"]);
      const a = asms.find((x) => x.name === "AsmA");
      const b = asms.find((x) => x.name === "AsmB");
      expect(a?.resolvedReferences).toContain(b!.id);
      expect(b?.resolvedReferences).toContain(a!.id);
      expect(assemblyForFile("A/Y.cs", asms)?.name).toBe("AsmA");
      expect(assemblyForFile("A/Sub/X.cs", asms)?.name).toBe("AsmB");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("3D model", () => {
  it("includes C# using and type refs without adding using-only edges to the 2D graph", () => {
    const result = analyze(sampleRoot);
    const gc = result.graph.files.find((f) => f.relativePath.endsWith("GameController.cs"));
    const mega = result.graph.files.find((f) => f.relativePath.endsWith("MegaService.cs"));
    expect(gc && mega).toBeTruthy();
    expect(result.graph.edges.some((e) => e.source === gc!.id && e.target === mega!.id)).toBe(false);

    const model = buildView3d(result);
    const edge = model.file.edges.find((e) => e.source === gc!.id && e.target === mega!.id);
    expect(edge?.kinds).toEqual(["using"]);
    expect(model.file.edges.some((e) => e.kinds.includes("reference"))).toBe(true);
    expect(model.file.edges.some((e) => e.kinds.includes("import"))).toBe(true);
  });

  it("includes asmdef references and rolls file dependencies up to assemblies", () => {
    const result = analyze(archRoot);
    expect(result.graph.files.some((f) => f.relativePath.endsWith(".asmdef"))).toBe(false);
    expect(result.assemblies.map((a) => a.name).sort()).toEqual([
      "Game.Camera",
      "Game.Telemetry",
      "Game.Util",
    ]);

    const model = buildView3d(result);
    const hud = model.file.edges.find(
      (e) => e.source.endsWith("CameraHudView.cs") && e.target.endsWith("CameraService.cs"),
    );
    expect(hud?.kinds).toEqual(["using", "reference"]);

    const gateway = model.file.edges.find(
      (e) => e.source.endsWith("CameraDeviceGateway.cs") && e.target.endsWith("CameraPose.cs"),
    );
    expect(gateway?.kinds).toContain("reference");
    expect(gateway?.kinds).toContain("using");

    const asm = model.assembly.edges.find(
      (e) => e.source === "asm:Game.Camera" && e.target === "asm:Game.Util",
    );
    expect(asm?.kinds).toEqual(["using", "asmdef"]);

    const telemetry = model.assembly.edges.find(
      (e) => e.source === "asm:Game.Telemetry" && e.target === "asm:Game.Util",
    );
    expect(telemetry?.kinds).toEqual(["asmdef"]);

    expect(model.file.nodes.every((n) => n.id.startsWith("file:"))).toBe(true);
    expect(model.assembly.nodes.some((n) => n.id.startsWith("loose:"))).toBe(true);

    const byLayer = new Map<string, { y: number }[]>();
    for (const n of model.file.nodes) {
      const list = byLayer.get(n.layer) ?? [];
      list.push(n);
      byLayer.set(n.layer, list);
    }
    const means = [...byLayer.values()].map(
      (list) => list.reduce((s, n) => s + n.y, 0) / list.length,
    );
    expect(Math.max(...means) - Math.min(...means)).toBeLessThan(2);
    const wide = [...byLayer.values()].find((list) => list.length >= 3);
    expect(wide).toBeTruthy();
    const ys = wide!.map((n) => n.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.8);
  });
});

describe("render3dHtml", () => {
  it("writes one offline HTML file with Three.js and the graph inlined", () => {
    const model = buildView3d(analyze(archRoot));
    const html = render3dHtml(model);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("WebGLRenderer");
    expect(html).toContain("depgraph-data");
    expect(html).not.toMatch(/<script[^>]+src\s*=/i);
    expect(html.match(/<\/script>/gi)?.length).toBe(3);

    const raw = html.match(
      /<script type="application\/json" id="depgraph-data">([\s\S]*?)<\/script>/,
    );
    expect(raw).toBeTruthy();
    const data = JSON.parse(raw![1]!);
    expect(data.file.nodes.some((n: { label: string }) => n.label === "CameraHudView.cs")).toBe(
      true,
    );
    expect(data.assembly.edges.some((e: { kinds: string[] }) => e.kinds.includes("asmdef"))).toBe(
      true,
    );

    const evil = structuredClone(model);
    evil.file.nodes[0]!.label = "</script><script>alert(1)";
    const escaped = render3dHtml(evil);
    expect(escaped.match(/<\/script>/gi)?.length).toBe(3);
    expect(escaped).not.toContain("</script><script>");
  });
});
