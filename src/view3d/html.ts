import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { View3dModel } from "./build.js";

export function render3dHtml(model: View3dModel): string {
  const three = fs.readFileSync(assetPath("vendor/three.min.js"), "utf8");
  const viewer = fs.readFileSync(assetPath("view3d-viewer.js"), "utf8");
  if (/<\/script/i.test(three) || /<\/script/i.test(viewer)) {
    throw new Error("インラインするスクリプトに </script> が含まれているため、単一 HTML にできません");
  }
  const data = JSON.stringify(model).replace(/</g, "\\u003c");
  const title = escapeHtml(model.title);
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; --bg: #12151c; --panel: rgba(18, 21, 28, 0.9); --line: rgba(255,255,255,0.1); --text: #e8edf5; --muted: #9aa6b8; }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 13px/1.45 "Segoe UI", "Hiragino Sans", "Noto Sans CJK JP", "Noto Sans JP", sans-serif; }
    #view { position: fixed; inset: 0; }
    #view canvas { display: block; width: 100%; height: 100%; }
    #panel {
      position: fixed; z-index: 3; top: 12px; left: 12px; width: 300px;
      max-height: calc(100% - 24px); overflow: auto;
      background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
      padding: 14px 14px 12px;
    }
    h1 { font-size: 15px; margin: 0 0 4px; font-weight: 650; }
    #subtitle, .hint, #search-count { color: var(--muted); margin: 0 0 10px; }
    .hint { margin-top: 10px; margin-bottom: 0; }
    label.row, label.check { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
    select, input[type="search"] {
      flex: 1; min-width: 0; background: #0e1218; color: var(--text);
      border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px;
    }
    #layers { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 10px; }
    .swatch { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
    button {
      background: #1c2433; color: var(--text); border: 1px solid var(--line);
      border-radius: 8px; padding: 6px 10px; cursor: pointer;
    }
    #tooltip {
      position: fixed; z-index: 4; max-width: 380px; display: none; pointer-events: none;
      background: rgba(10, 12, 18, 0.94); border: 1px solid var(--line); border-radius: 10px;
      padding: 8px 10px; white-space: pre-wrap;
    }
    #labels { position: fixed; inset: 0; z-index: 2; pointer-events: none; overflow: hidden; }
    .node-label, .cluster-label {
      position: absolute; transform: translate(-50%, -140%);
      text-shadow: 0 1px 2px #000, 0 0 6px #000; white-space: nowrap;
    }
    .cluster-label { font-weight: 700; transform: translate(-50%, -50%); }
    .node-label.hot { background: rgba(0,0,0,0.55); border-radius: 6px; padding: 1px 5px; }
  </style>
</head>
<body>
  <div id="view"></div>
  <div id="labels"></div>
  <aside id="panel">
    <h1>${title}</h1>
    <p id="subtitle"></p>
    <label class="row">粒度
      <select id="mode">
        <option value="file">ファイル</option>
        <option value="assembly">アセンブリ (asmdef)</option>
      </select>
    </label>
    <label class="row">検索
      <input id="search" type="search" placeholder="名前 / パス" autocomplete="off" />
    </label>
    <p id="search-count"></p>
    <div id="layers"></div>
    <button id="reset" type="button">配置を戻す</button>
    <p class="hint">ドラッグで回転、ホイールでズーム、ノードをドラッグで移動。矢印は依存先を指します。層は色と空間上のまとまりで、上下には並べていません。</p>
  </aside>
  <div id="tooltip"></div>
  <script>${three}</script>
  <script type="application/json" id="depgraph-data">${data}</script>
  <script>${viewer}</script>
</body>
</html>
`;
}

function assetPath(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "../web", name),
    path.join(process.cwd(), "src/web", name),
    path.join(process.cwd(), "dist/web", name),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`3D 表示に必要なファイルが見つかりません: ${name}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
