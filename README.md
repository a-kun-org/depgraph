# depgraph

ローカル Web ツールで、C#（Unity）/ Dart（Flutter）/ Python の依存関係を可視化します。クラスタ・**アーキテクチャ層**・**機能(feature)** の3モードで総構造を俯瞰し、循環依存・ハブ・肥大ファイル・層の依存方向違反・孤立ノードを検出します。

## セットアップ

```bash
npm install
```

Node.js 18 以上。

## 使い方

### Web UI（localhost のみ）

```bash
npm start -- /path/to/your/repo
npm start -- /path/to/repo --config depgraph.config.json -x Library,Temp,node_modules
```

既定 URL: `http://127.0.0.1:47123`

対象ルートに `depgraph.config.json` または `depgraph.rules.json` があれば自動読込します（`--config` / `--rules` で上書き）。

### JSON / 未分類レポート

```bash
npm start -- /path/to/repo --json > analysis.json
npm start -- /path/to/repo -o analysis.json --config ./examples/vsnap.depgraph.json
npm start -- /path/to/repo --report-unclassified --config ./examples/vsnap.depgraph.json
```

`--report-unclassified` は未分類率と、未分類が多いディレクトリ上位10を表示します（`archLayers` を育てる材料）。

### 付属サンプル

```bash
# 混在言語・古典的指摘
npm start -- ./fixtures/sample-monorepo --rules ./fixtures/sample-monorepo/depgraph.rules.json

# 層 / 機能デモ（Unity Shared・Flutter lib・Python API）
npm start -- ./fixtures/arch-sample
```

## UI

- **表示モード**: クラスタ / 層 / 機能
  - **クラスタ（既定）**: **「層で分ける」(既定ON)** で、表示中クラスタの**全ファイルを層レーンに一括配置**（折りたたみ不要）。レーン順は `archLayers`（プレゼンテーション → アプリケーション → ドメイン → インフラ → 共通・基盤 → テスト・ツール・外部 → 未分類）。0件の帯は非表示、未分類が少数ならコンパクト帯。ラベルは**省略せず全文**表示し、ノード幅・間隔で重なりを回避。**fit は常に下限約50%**（クラスタ絞り込み・違反のみ・再配置後も同じ）。収まらない場合は左上(最上位レーン)から表示し、パンで辿る。**「段階展開」**をONにすると従来の概要→ディレクトリ→ファイルの折りたたみ操作に戻せる
  - **層**: 層帯の概要ビュー（帯クリックで feature → ファイル）
  - **機能**: feature カードと集約矢印
- 依存線は既定で薄く表示。**ノードホバー / 選択**で、そのノードにつながる線だけを強調
- 検索・フィルタ（孤立隠し / 層で分ける / 段階展開 / 問題のみ / **層の依存方向違反のみ** / 種類トグル）。違反のみON時は端点ノードを強調し違反辺を太く表示
- サイドバーの **層×層 依存行列**。セルクリックで該当依存をハイライト
- 選択パネルに **層・feature・layerReason** を表示

### vsnap-like デモ

```bash
npm start -- ./fixtures/vsnap-like --config ./examples/vsnap.depgraph.json
# UI スモーク（Playwright）: 先に上記を起動してから
node scripts/ui-lanes-smoke.mjs
```

## 設定例（汎用）

`depgraph.config.json`（または `depgraph.rules.example.json`）:

```json
{
  "hub": { "degreeThreshold": 10 },
  "bloat": { "locThreshold": 500 },
  "clusters": [
    { "name": "Flutter", "match": ["client/"], "color": "#4fc3f7" },
    { "name": "Unity", "match": ["game/"], "color": "#81c784" }
  ],
  "featureRoots": [
    { "match": "Assets/Shared/*", "depth": 1 },
    { "match": "lib/*", "depth": 1 }
  ],
  "archLayers": [
    {
      "name": "プレゼンテーション",
      "match": ["**/Presentation/**", "**/UI/**"],
      "mayDependOn": ["アプリケーション", "ドメイン", "共通・基盤"]
    },
    {
      "name": "アプリケーション",
      "match": ["**/Application/**", "**/Handlers/**"],
      "mayDependOn": ["ドメイン", "インフラ", "共通・基盤"]
    },
    {
      "name": "ドメイン",
      "match": ["**/Domain/**", "**/Models/**"],
      "mayDependOn": ["共通・基盤"]
    },
    {
      "name": "インフラ",
      "match": ["**/Infrastructure/**", "**/storage/**"],
      "mayDependOn": ["ドメイン", "共通・基盤"]
    },
    {
      "name": "共通・基盤",
      "match": ["**/Util/**", "**/Core/**", "**/config/**"],
      "mayDependOn": []
    }
  ]
}
```

- **既定の層推定**は一般的な命名規約のみ（Domain / Application / Infrastructure / Presentation / Util 等）。リポジトリ固有名は入れません
- **パスの最も深い一致**を優先。ファイル名規則は補助
- `mayDependOn` で期待する依存の向きを上書き可能
- 従来のパス接頭辞 `layers`（プロジェクト固有レイヤー境界）も併用可

## vsnap-projects 向け

vsnap 固有の clusters / featureRoots / archLayers は **`examples/vsnap.depgraph.json`** に分離しています（ツール本体の既定ヒューリスティックには vsnap パスを入れません）。

### 設定の育て方

1. まず未分類を見る:

```bash
npm start -- /path/to/vsnap-projects --config ./examples/vsnap.depgraph.json \
  -x Library,Temp,Logs,obj,bin,.git,node_modules --report-unclassified
```

2. 上位ディレクトリを `archLayers[].match` に振り分け（深いパスを優先）、再実行して未分類率を確認する。
3. 誤検出の多い依存向きは `mayDependOn` で調整する（例: Flutter の `lib/app` は画面+状態管理なので **アプリケーション** に置き、インフラ依存を許可。`lib/util`→`lib/storage` / `lib/widgets` や `lib/storage`→`lib/widgets` は本物の違反として残す）。

### 起動例

```bash
npm start -- /path/to/vsnap-projects --config ./examples/vsnap.depgraph.json \
  -x Library,Temp,Logs,obj,bin,.git,node_modules
```

想定フォルダ規約の例:

- Unity: `vsnap-core/Assets/Shared/<Feature>/{Domain,Application,Infrastructure,Presentation,…}`（Camera/Colocation/AR 直下などは設定側でアプリケーション等へ割当）
- Flutter: `vsnap-client-uaal/lib/{app,widgets,storage,auth,config,…}`（`app`=アプリケーション、`widgets`=プレゼン）
- Python: `vsnap-photo-map/api`, `vsnap-telemetry/api`, `vsnap-ardy-server/src/ardy_server`, …

## テスト

```bash
npm test
npx tsc --noEmit
```

## 構成

| パス | 役割 |
|------|------|
| `src/cli.ts` | CLI（`--config` / `-x` / `--report-unclassified`） |
| `src/server.ts` | localhost HTTP |
| `src/analyzer/layers.ts` | 汎用の層・feature 分類と依存方向検査 |
| `src/analyzer/cluster.ts` | クラスタ |
| `src/web/` | UI（Cytoscape + dagre） |
| `examples/vsnap.depgraph.json` | vsnap 専用設定 |
| `fixtures/arch-sample/` | 層/機能の動作確認用ミニ構成 |

## ライセンス

MIT
