/**
 * vsnap-like + 層レーン全展開の Playwright スモーク。
 * 前提: depgraph が http://127.0.0.1:47123 で起動済み
 *   npm start -- ./fixtures/vsnap-like --config ./examples/vsnap.depgraph.json
 *
 * fit 下限(50%): Flutterのみ / 違反のみ / Unityのみ で実測する。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(OUT, { recursive: true });
const FIT_MIN = 0.5;

const pageErrors = [];
const failedRequests = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (err) => pageErrors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") pageErrors.push(`console: ${msg.text()}`);
});
page.on("response", (res) => {
  if (res.status() === 404) failedRequests.push(`${res.status()} ${res.url()}`);
});

await page.goto("http://127.0.0.1:47123/", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.depgraph?.state?.cy && window.depgraph.state.cy.nodes().length > 0, null, {
  timeout: 20000,
});
await page.waitForTimeout(700);

async function measure(label) {
  return page.evaluate((mode) => {
    const cy = window.depgraph.state.cy;
    const minZ = window.depgraph.FIT_MIN_ZOOM || 0.5;
    window.depgraph.fitCurrentView();
    const zoom = cy.zoom();
    const nodes = cy.nodes().filter((n) => !n.hasClass("frame"));
    const files = cy.nodes('[kind = "file"]');
    const boxes = nodes.map((n) => {
      const bb = n.boundingBox({ includeLabels: true });
      return { id: n.id(), x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 };
    });
    let overlap = 0;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        if (ox > 2 && oy > 2) overlap++;
      }
    }
    const labels = files.map((n) => n.data("label"));
    const fileClusters = [...new Set(files.map((n) => n.data("ckey")))];
    return {
      mode,
      zoom,
      zoomPct: Math.round(zoom * 100),
      fitMinOk: zoom + 1e-6 >= minZ,
      nodeCount: nodes.length,
      fileCount: files.length,
      fileClusters,
      overlapPairs: overlap,
      truncatedLabels: labels.filter((t) => typeof t === "string" && t.includes("…")).length,
      clusters: [...window.depgraph.state.ui.expandedClusters],
      hidden: [...window.depgraph.state.ui.hiddenClusters],
      archOnly: !!window.depgraph.state.ui.archOnly,
    };
  }, label);
}

/** keep に部分一致するクラスタだけ表示し、再描画+fit */
async function showOnlyClusters(keepNames) {
  await page.evaluate((keep) => {
    const ui = window.depgraph.state.ui;
    const keys = [...window.depgraph.state.model.byKey.keys()];
    ui.hiddenClusters.clear();
    for (const k of keys) {
      const ok = keep.some((name) => k.toLowerCase().includes(String(name).toLowerCase()));
      if (!ok) ui.hiddenClusters.add(k);
    }
    document.querySelectorAll(".cluster-item").forEach((item) => {
      const key = item.dataset.key;
      const cb = item.querySelector(".cl-vis");
      if (cb) cb.checked = !ui.hiddenClusters.has(key);
    });
    window.depgraph.render({ fit: true });
  }, keepNames);
  await page.waitForTimeout(500);
}

async function setArchOnly(on) {
  await page.evaluate((v) => {
    const cb = document.getElementById("arch-only");
    if (cb) cb.checked = v;
    window.depgraph.state.ui.archOnly = v;
    window.depgraph.render({ fit: true });
  }, on);
  await page.waitForTimeout(500);
}

// --- 初期 ---
const allMetrics = await measure("all");
await page.screenshot({ path: path.join(OUT, "lanes-overview.png"), fullPage: false });

// --- Flutter のみ ---
await showOnlyClusters(["flutter"]);
await page.click("#fit");
await page.waitForTimeout(300);
const flutterMetrics = await measure("flutter-only");
await page.screenshot({ path: path.join(OUT, "lanes-flutter-only.png"), fullPage: false });

// --- 違反のみ (Flutter のまま) ---
await setArchOnly(true);
await page.click("#fit");
await page.waitForTimeout(300);
const archMetrics = await measure("flutter-arch-only");
await page.screenshot({ path: path.join(OUT, "lanes-arch-only.png"), fullPage: false });

// --- Unity のみ ---
await setArchOnly(false);
await showOnlyClusters(["unity"]);
await page.click("#fit");
await page.waitForTimeout(300);
const unityMetrics = await measure("unity-only");
await page.screenshot({ path: path.join(OUT, "lanes-unity-files.png"), fullPage: false });

const report = {
  pageErrors,
  failedRequests,
  fitMin: FIT_MIN,
  allMetrics,
  flutterMetrics,
  archMetrics,
  unityMetrics,
  ok:
    pageErrors.length === 0 &&
    failedRequests.length === 0 &&
    flutterMetrics.fitMinOk &&
    flutterMetrics.zoom + 1e-6 >= FIT_MIN &&
    flutterMetrics.fileClusters.every((c) => /flutter/i.test(c)) &&
    archMetrics.fitMinOk &&
    archMetrics.zoom + 1e-6 >= FIT_MIN &&
    unityMetrics.fitMinOk &&
    unityMetrics.zoom + 1e-6 >= FIT_MIN &&
    unityMetrics.fileClusters.every((c) => /unity/i.test(c)) &&
    flutterMetrics.overlapPairs === 0 &&
    archMetrics.overlapPairs === 0 &&
    unityMetrics.overlapPairs === 0 &&
    flutterMetrics.fileCount > 0 &&
    unityMetrics.fileCount > 0,
};

fs.writeFileSync(path.join(OUT, "ui-lanes-metrics.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(report.ok ? 0 : 1);
