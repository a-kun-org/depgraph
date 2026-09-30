import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT = "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(OUT, { recursive: true });

const pageErrors = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (err) => pageErrors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") pageErrors.push(`console: ${msg.text()}`);
});

await page.goto("http://127.0.0.1:47123/", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.depgraph?.state?.cy && window.depgraph.state.cy.nodes().length > 0, null, {
  timeout: 15000,
});
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, "arch-cluster.png"), fullPage: false });

async function metrics(label) {
  return page.evaluate((mode) => {
    const cy = window.depgraph.state.cy;
    const nodes = cy.nodes().filter((n) => !n.hasClass("frame"));
    const boxes = nodes.map((n) => {
      const bb = n.boundingBox({ includeLabels: false });
      return { id: n.id(), x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2, w: bb.w, h: bb.h };
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
    const extent = cy.elements().boundingBox();
    const pad = 8;
    const inside =
      extent.x1 >= -pad &&
      extent.y1 >= -pad &&
      Number.isFinite(extent.w) &&
      Number.isFinite(extent.h) &&
      extent.w > 0 &&
      extent.h > 0;
    // nodes should be within the graph container after fit
    cy.fit(undefined, 40);
    const zoom = cy.zoom();
    const pan = cy.pan();
    const container = { w: cy.width(), h: cy.height() };
    let outOfView = 0;
    for (const b of boxes) {
      const sx = b.x1 * zoom + pan.x;
      const sy = b.y1 * zoom + pan.y;
      const ex = b.x2 * zoom + pan.x;
      const ey = b.y2 * zoom + pan.y;
      if (ex < -20 || ey < -20 || sx > container.w + 20 || sy > container.h + 20) outOfView++;
    }
    return {
      mode,
      nodeCount: nodes.length,
      overlapPairs: overlap,
      extentOk: inside,
      outOfView,
      zoom,
      container,
    };
  }, label);
}

const clusterMetrics = await metrics("cluster");

await page.selectOption("#view-mode", "layer");
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(OUT, "arch-layer.png"), fullPage: false });
const layerMetrics = await metrics("layer");

await page.selectOption("#view-mode", "feature");
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(OUT, "arch-feature.png"), fullPage: false });
const featureMetrics = await metrics("feature");

const report = {
  pageErrors,
  clusterMetrics,
  layerMetrics,
  featureMetrics,
  ok:
    pageErrors.length === 0 &&
    clusterMetrics.overlapPairs === 0 &&
    layerMetrics.overlapPairs === 0 &&
    featureMetrics.overlapPairs === 0 &&
    clusterMetrics.outOfView === 0 &&
    layerMetrics.outOfView === 0 &&
    featureMetrics.outOfView === 0,
};
fs.writeFileSync(path.join(OUT, "ui-metrics.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(report.ok ? 0 : 1);
