export type Language = "csharp" | "dart" | "python" | "unknown";

export type Granularity = "file" | "directory" | "class";

export interface SourceFile {
  id: string;
  path: string;
  relativePath: string;
  language: Language;
  loc: number;
  classes: ClassInfo[];
  imports: ImportRef[];
  /** C# namespace declaration, if any */
  namespace?: string;
  /** Cluster this file belongs to (Flutter / Unity / その他 or a rules-defined name) */
  clusterKey?: string;
  /** アーキテクチャ層(ドメイン / アプリケーション …)。未判定は「未分類」 */
  layerKey?: string;
  /** 層判定の根拠(どの規則に一致したか) */
  layerReason?: string;
  /** 根拠の種類: dir=ディレクトリ規則 / file=ファイル名(補助) / none */
  layerBasis?: "dir" | "file" | "none";
  /** 機能(Unity: Assets/Shared/<Feature>、Flutter: lib/<dir>、Python: API ディレクトリ) */
  featureKey?: string;
}

export interface ClassInfo {
  name: string;
  qualifiedName: string;
  kind: "class" | "interface" | "struct" | "enum" | "record" | "mixin" | "extension";
  line: number;
}

export interface ImportRef {
  raw: string;
  /** Resolved relative path within the analyzed root, if known */
  resolvedPath?: string;
  /** Module / namespace / package name when file path cannot be resolved */
  moduleName?: string;
  line: number;
  kind: "import" | "using" | "reference";
}

export interface GraphNode {
  id: string;
  label: string;
  kind: "file" | "directory" | "class" | "module";
  language?: Language;
  path?: string;
  loc: number;
  parentId?: string;
  /** For grouping UI */
  groupKey?: string;
  /** Cluster name (default: dart=Flutter, csharp=Unity, else その他; overridable via rules.clusters) */
  clusterKey?: string;
  layerKey?: string;
  featureKey?: string;
  layerReason?: string;
  layerBasis?: "dir" | "file" | "none";
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "imports" | "references" | "contains";
  detail?: string;
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  files: SourceFile[];
  root: string;
  generatedAt: string;
}

export type IssueKind =
  | "circular_dependency"
  | "hub"
  | "bloated_file"
  | "layer_violation"
  | "orphan";

export type IssueSeverity = "error" | "warning" | "info";

export interface DesignIssue {
  id: string;
  kind: IssueKind;
  severity: IssueSeverity;
  title: string;
  reason: string;
  /** Node / file ids involved */
  locations: string[];
  /** Human-readable paths or names */
  details: string[];
}

export interface LayerRule {
  name: string;
  /** Glob-like path prefix patterns (matched against relative path) */
  match: string[];
  /** Layers this layer may depend on (by name). Empty = no outbound deps allowed. */
  mayDependOn: string[];
}

export interface ClusterRule {
  name: string;
  /** Relative-path prefixes (forward slashes); first matching cluster wins */
  match: string[];
  color?: string;
}

export interface ArchLayerRule {
  name: string;
  /** パスの glob(`**` 可)。ディレクトリ名だけ("Domain")の指定も可。大文字小文字は区別しない */
  match: string[];
  color?: string;
  /** 小さいほど内側/下位(共通=0, インフラ=10, ドメイン=20, アプリ=30, プレゼン=40) */
  order?: number;
  /** この層が依存してよい層名。省略時は既定の期待(プレゼン→アプリ→ドメイン←インフラ、共通は誰からでも) */
  mayDependOn?: string[];
  /** true ならテスト/ツール等として依存方向の検査対象外 */
  neutral?: boolean;
}

export interface LayerSummary {
  key: string;
  short: string;
  color: string;
  order: number;
  neutral: boolean;
  fileCount: number;
  /** この層を from とする「層の依存方向違反」件数 */
  violationsOut: number;
  byLanguage: Record<string, number>;
}

export interface LayerMatrix {
  layers: string[];
  /** cells[from][to] = ファイル間依存の本数(同一層も含む) */
  cells: Record<string, Record<string, number>>;
  /** 各層が依存してよい層(null = 制限なし) */
  allowed: Record<string, string[] | null>;
  neutral: string[];
}

export interface LayerViolationSummary {
  count: number;
  error: number;
  warning: number;
  byPair: { from: string; to: string; count: number }[];
  samples: { severity: string; fromLayer: string; toLayer: string; from: string; to: string }[];
}

/** 層×層行列など、ファイル集合と依存の切り口ごとのサマリ */
export interface LayerScopeSummary {
  layers: LayerSummary[];
  layerMatrix: LayerMatrix;
  layerViolations: LayerViolationSummary;
  unclassifiedRate: number;
  unclassifiedTopDirs: UnclassifiedDirStat[];
}

export interface LayerMatrixScopes {
  /** clusters 設定のクラスタ名ごと(クラスタ内の依存のみ) */
  byCluster: Record<string, LayerScopeSummary>;
  /** クラスタをまたぐ依存のみ */
  interCluster: LayerScopeSummary;
}

export interface FeatureSummary {
  key: string;
  cluster: string;
  feature: string;
  fileCount: number;
  layers: Record<string, number>;
}

export interface ClusterSummary {
  key: string;
  color: string;
  fileCount: number;
}

export interface FeatureRootRule {
  /** Glob-like root (e.g. "Assets/Shared/*" or "lib/*"). `*` の位置のセグメントが feature 名 */
  match: string;
  /** feature 名に使うセグメント数(既定 1) */
  depth?: number;
}

export interface UnclassifiedDirStat {
  path: string;
  count: number;
}

export interface AnalysisRules {
  layers?: LayerRule[];
  /** アーキテクチャ層の上書き/追加(同名は既定を上書き)。省略時は既定分類 */
  archLayers?: ArchLayerRule[];
  /**
   * 機能名を取るルート。例: ["Assets/Shared/*", "lib/*"]
   * 文字列または { match, depth }。未指定時は言語別ヒューリスティック。
   */
  featureRoots?: Array<string | FeatureRootRule>;
  /** Cluster definitions; when set they take precedence over the language-based default */
  clusters?: ClusterRule[];
  hub?: {
    /** Flag nodes whose in+out degree exceeds this (file granularity) */
    degreeThreshold?: number;
  };
  bloat?: {
    /** Flag files with LOC above this */
    locThreshold?: number;
  };
  orphans?: {
    /** Ignore orphan files matching these path prefixes */
    ignore?: string[];
  };
}

/** Unity asmdef。ファイル走査とは別に集め、ファイル数には含めない。 */
export interface AssemblyInfo {
  /** `asm:<name>`。同名が複数あるときだけディレクトリを足す */
  id: string;
  name: string;
  /** リポジトリ相対の .asmdef パス */
  path: string;
  /** この asmdef が支配するディレクトリ（配下のより深い asmdef が優先） */
  directory: string;
  /** asmdef の references をそのまま */
  references: string[];
  /** この解析ツリー内に解決できた参照先の assembly id */
  resolvedReferences: string[];
  guid?: string;
}

export interface AnalysisResult {
  graph: DependencyGraph;
  issues: DesignIssue[];
  rules: AnalysisRules;
  /** .asmdef の名前と references。無いリポジトリでは空 */
  assemblies: AssemblyInfo[];
  summary: {
    fileCount: number;
    edgeCount: number;
    issueCount: number;
    languages: Record<string, number>;
    clusters: ClusterSummary[];
    /** Number of edges (at the requested granularity) whose endpoints are in different clusters */
    crossClusterEdges: number;
    /** 層別ファイル数(表示順: 上位→下位、最後に未分類) */
    layers: LayerSummary[];
    /** 層 × 層 の依存本数(ファイル間) */
    layerMatrix: LayerMatrix;
    /** 「層の依存方向違反」の件数と代表例 */
    layerViolations: LayerViolationSummary;
    /** 全体に加え、クラスタ別・クラスタ間の層サマリ */
    layerMatrixScopes?: LayerMatrixScopes;
    /** クラスタ × feature ごとのファイル数と層内訳 */
    features: FeatureSummary[];
    /** 未分類ファイルの割合(0〜1) */
    unclassifiedRate: number;
    /** 未分類ファイルが多いディレクトリ上位 */
    unclassifiedTopDirs: UnclassifiedDirStat[];
  };
}
