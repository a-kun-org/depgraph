import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalysisResult, Granularity } from "./analyzer/types.js";
import { analyze } from "./analyzer/index.js";
import { filterGraphByCollapsedDirs } from "./analyzer/graph.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

export interface ServerOptions {
  target: string;
  rulesPath?: string;
  exclude?: string[];
  host?: string;
  port?: number;
  initial?: AnalysisResult;
}

export function startServer(options: ServerOptions): http.Server {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 47123;
  const webRoot = path.join(__dirname, "web");

  let cache: AnalysisResult =
    options.initial ??
    analyze(options.target, { rulesPath: options.rulesPath,
          exclude: options.exclude, granularity: "file" });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    if (url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/analysis") {
      const granularity = (url.searchParams.get("granularity") ?? "file") as Granularity;
      const collapsed = (url.searchParams.get("collapsed") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      try {
        const result = analyze(options.target, {
          rulesPath: options.rulesPath,
          exclude: options.exclude,
          granularity,
          rules: cache.rules,
        });
        cache = result;

        const payload =
          collapsed.length > 0
            ? {
                ...result,
                graph: filterGraphByCollapsedDirs(result.graph, new Set(collapsed)),
              }
            : result;

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(payload));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (url.pathname === "/api/reload" && req.method === "POST") {
      try {
        cache = analyze(options.target, {
          rulesPath: options.rulesPath,
          exclude: options.exclude,
          granularity: "file",
          rules: cache.rules,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, summary: cache.summary }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    let rel = url.pathname === "/" ? "/index.html" : url.pathname;
    if (rel === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(webRoot, rel);
    if (
      !filePath.startsWith(webRoot) ||
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()
    ) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  });

  server.listen(port, host, () => {
    console.log(`depgraph listening on http://${host}:${port}`);
    console.log(`target: ${path.resolve(options.target)}`);
    console.log(
      `files: ${cache.summary.fileCount}, edges: ${cache.summary.edgeCount}, issues: ${cache.summary.issueCount}`,
    );
  });

  return server;
}
