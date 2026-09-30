import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyLayer,
  featureKeyFor,
  featureFromRoots,
  resolveArchLayers,
  findLayerViolations,
  LAYER_DOMAIN,
  LAYER_INFRA,
  LAYER_APPLICATION,
  LAYER_PRESENTATION,
  LAYER_COMMON,
  LAYER_TOOLS,
} from "../src/analyzer/layers.js";
import { analyze, loadRules } from "../src/analyzer/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const archRoot = path.join(__dirname, "../fixtures/arch-sample");
const vsnapLikeRoot = path.join(__dirname, "../fixtures/vsnap-like");
const vsnapConfig = path.join(__dirname, "../examples/vsnap.depgraph.json");

describe("layer classification heuristics", () => {
  const layers = resolveArchLayers();

  it("prefers the deepest matching directory segment", () => {
    const hit = classifyLayer(
      "game/Assets/Shared/Camera/Domain/CameraPose.cs",
      layers,
    );
    expect(hit.layerKey).toBe(LAYER_DOMAIN);
    expect(hit.layerBasis).toBe("dir");
    expect(hit.layerReason).toMatch(/Domain/);
  });

  it("classifies Presentation / Application / Infrastructure / Util", () => {
    expect(classifyLayer("x/Presentation/Hud.cs", layers).layerKey).toBe(LAYER_PRESENTATION);
    expect(classifyLayer("x/Application/Svc.cs", layers).layerKey).toBe(LAYER_APPLICATION);
    expect(classifyLayer("x/Infrastructure/Repo.cs", layers).layerKey).toBe(LAYER_INFRA);
    expect(classifyLayer("x/Util/Math.cs", layers).layerKey).toBe(LAYER_COMMON);
  });

  it("uses filename rules only as a fallback", () => {
    const byFile = classifyLayer("misc/FooView.cs", layers);
    expect(byFile.layerKey).toBe(LAYER_PRESENTATION);
    expect(byFile.layerBasis).toBe("file");
  });

  it("lets path-qualified file rules override same-depth directory rules", () => {
    const layersCustom = resolveArchLayers([
      {
        name: LAYER_PRESENTATION,
        match: ["**/Shared/AR/*Presenter*"],
      },
      {
        name: LAYER_APPLICATION,
        match: ["**/Shared/AR/**"],
      },
    ]);
    expect(
      classifyLayer("core/Assets/Shared/AR/BoardPresenter.cs", layersCustom).layerKey,
    ).toBe(LAYER_PRESENTATION);
    expect(
      classifyLayer("core/Assets/Shared/AR/SessionRunner.cs", layersCustom).layerKey,
    ).toBe(LAYER_APPLICATION);
  });
});

describe("featureRoots", () => {
  it("extracts feature name from Assets/Shared/* and lib/*", () => {
    expect(
      featureFromRoots("game/Assets/Shared/Camera/Domain/X.cs", ["Assets/Shared/*"]),
    ).toBe("Camera");
    expect(featureFromRoots("client/lib/storage/session_store.dart", ["lib/*"])).toBe(
      "storage",
    );
  });

  it("respects depth and falls back to language heuristics", () => {
    expect(
      featureKeyFor("game/Assets/Shared/Camera/Domain/X.cs", "csharp", [
        { match: "Assets/Shared/*", depth: 1 },
      ]),
    ).toBe("Camera");
    expect(featureKeyFor("client/lib/app/home.dart", "dart")).toBe("app");
  });
});

describe("arch-sample fixture", () => {
  it("loads config overrides and reports layer direction violations", () => {
    const rules = loadRules(undefined, archRoot);
    expect(rules.clusters?.length).toBeGreaterThan(0);
    expect(rules.featureRoots?.length).toBeGreaterThan(0);

    const result = analyze(archRoot, { rules });
    expect(result.summary.fileCount).toBeGreaterThan(10);
    expect(result.summary.layers.some((l) => l.key === LAYER_DOMAIN && l.fileCount > 0)).toBe(
      true,
    );
    expect(result.summary.layerMatrix.layers.length).toBeGreaterThan(3);
    expect(typeof result.summary.unclassifiedRate).toBe("number");
    expect(Array.isArray(result.summary.unclassifiedTopDirs)).toBe(true);

    const camera = result.graph.files.find((f) => f.relativePath.includes("CameraPose"));
    expect(camera?.layerKey).toBe(LAYER_DOMAIN);
    expect(camera?.featureKey).toBe("Camera");

    const viol = result.issues.filter(
      (i) => i.kind === "layer_violation" && i.title.includes("層の依存方向違反"),
    );
    expect(viol.length).toBeGreaterThan(0);
  });

  it("findLayerViolations detects infra→application when present", () => {
    const rules = loadRules(path.join(archRoot, "depgraph.config.json"));
    const result = analyze(archRoot, { rules });
    const found = findLayerViolations(result.graph.files, rules);
    expect(
      found.some((v) => v.fromLayer === LAYER_INFRA && v.toLayer === LAYER_APPLICATION),
    ).toBe(true);
  });

  it("treats lib/app as application (may depend on infra)", () => {
    const rules = loadRules(path.join(archRoot, "depgraph.config.json"));
    const app = rules.archLayers?.find((l) => l.name === LAYER_APPLICATION);
    expect(app?.match.some((m) => m.includes("lib/app"))).toBe(true);
    const presentation = rules.archLayers?.find((l) => l.name === LAYER_PRESENTATION);
    expect(presentation?.mayDependOn).not.toContain(LAYER_INFRA);
  });
});

describe("vsnap.depgraph.json against vsnap-like fixture", () => {
  it("classifies Shared/Camera, Colocation, AR, Installer, Sample, ardy_server", () => {
    const rules = loadRules(vsnapConfig);
    const layers = resolveArchLayers(rules.archLayers);
    expect(classifyLayer("vsnap-core/Assets/Shared/Camera/Foo.cs", layers).layerKey).toBe(
      LAYER_APPLICATION,
    );
    expect(
      classifyLayer("vsnap-core/Assets/Shared/Colocation/Card/CardView.cs", layers).layerKey,
    ).toBe(LAYER_PRESENTATION);
    expect(
      classifyLayer("vsnap-core/Assets/Shared/Colocation/Vps/VpsClient.cs", layers).layerKey,
    ).toBe(LAYER_INFRA);
    expect(
      classifyLayer("vsnap-core/Assets/Shared/AR/ARBoardPresenter.cs", layers).layerKey,
    ).toBe(LAYER_PRESENTATION);
    expect(classifyLayer("vsnap-core/Assets/Shared/AR/SessionRunner.cs", layers).layerKey).toBe(
      LAYER_APPLICATION,
    );
    expect(
      classifyLayer(
        "vsnap-core/Assets/Shared/Character/Installer/CharacterInstaller.cs",
        layers,
      ).layerKey,
    ).toBe(LAYER_COMMON);
    expect(classifyLayer("vsnap-core/Assets/Shared/Sample/DemoScene.cs", layers).layerKey).toBe(
      LAYER_TOOLS,
    );
    expect(
      classifyLayer("vsnap-ardy-server/src/ardy_server/session_handler.py", layers).layerKey,
    ).toBe(LAYER_APPLICATION);
    expect(
      classifyLayer("vsnap-filter-preview/Assets/Scripts/PreviewRunner.cs", layers).layerKey,
    ).toBe(LAYER_TOOLS);
  });

  it("keeps unclassified rate low; app→storage ok; util→storage/widgets and storage→widgets remain violations", () => {
    const rules = loadRules(vsnapConfig);
    const result = analyze(vsnapLikeRoot, { rules });
    expect(result.summary.unclassifiedRate).toBeLessThan(0.1);
    expect(result.summary.unclassifiedTopDirs.length).toBe(0);

    const found = findLayerViolations(result.graph.files, rules);
    const pairs = found.map((v) => `${v.from.relativePath}=>${v.to.relativePath}`);

    // app → storage must NOT be a violation
    expect(
      pairs.some(
        (p) => p.includes("lib/app/") && p.includes("lib/storage/"),
      ),
    ).toBe(false);

    // util → storage / widgets remain
    expect(
      pairs.some(
        (p) =>
          p.includes("lib/util/format.dart") && p.includes("lib/storage/session_store.dart"),
      ),
    ).toBe(true);
    expect(
      pairs.some(
        (p) =>
          p.includes("lib/util/format.dart") && p.includes("lib/widgets/unity_commands.dart"),
      ),
    ).toBe(true);

    // storage → widgets remains
    expect(
      pairs.some(
        (p) =>
          p.includes("lib/storage/unity_state_sync.dart") &&
          p.includes("lib/widgets/unity_commands.dart"),
      ),
    ).toBe(true);
  });

  it("exposes archLayers order for lane stacking (presentation above infra)", () => {
    const rules = loadRules(vsnapConfig);
    const result = analyze(vsnapLikeRoot, { rules });
    const layers = [...result.summary.layers]
      .filter((l) => l.fileCount > 0)
      .sort((a, b) => b.order - a.order);
    const keys = layers.map((l) => l.key);
    expect(keys[0]).toBe(LAYER_PRESENTATION);
    const infraIdx = keys.indexOf(LAYER_INFRA);
    const commonIdx = keys.indexOf(LAYER_COMMON);
    const toolsIdx = keys.indexOf(LAYER_TOOLS);
    expect(infraIdx).toBeGreaterThan(-1);
    if (commonIdx >= 0) expect(commonIdx).toBeGreaterThan(infraIdx);
    if (toolsIdx >= 0) expect(toolsIdx).toBeGreaterThan(infraIdx);

    const unity = result.graph.files.filter((f) => f.relativePath.includes("vsnap-core/"));
    const unityLayers = new Set(unity.map((f) => f.layerKey));
    expect(unityLayers.has(LAYER_PRESENTATION) || unityLayers.has(LAYER_APPLICATION)).toBe(true);
    expect(unityLayers.size).toBeGreaterThanOrEqual(3);
  });
});
