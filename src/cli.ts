#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { analyze, analysisToJson, printUnclassifiedReport } from "./analyzer/index.js";
import { startServer } from "./server.js";

const program = new Command();

program
  .name("depgraph")
  .description("Visualize code dependencies (C# / Dart / Python) in a local browser")
  .argument("<target>", "Directory to analyze")
  .option("-p, --port <port>", "HTTP port (localhost only)", "47123")
  .option("-H, --host <host>", "Bind host", "127.0.0.1")
  .option("-r, --rules <file>", "Rules / config JSON (alias of --config)")
  .option("-c, --config <file>", "depgraph.config.json / rules JSON")
  .option("-o, --output <file>", "Write full analysis JSON to file (no server)")
  .option("--json", "Print analysis JSON to stdout (no server)", false)
  .option(
    "-g, --granularity <level>",
    "file | directory | class (for --json / --output)",
    "file",
  )
  .option("-x, --exclude <items>", "Comma-separated dir names or root-relative paths to skip", "")
  .option(
    "--report-unclassified",
    "Print unclassified rate and top directories (helps grow archLayers)",
    false,
  )
  .option("--no-open", "Do not print a prominent URL hint")
  .action((target: string, opts) => {
    const abs = path.resolve(target);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      console.error(`Target directory not found: ${abs}`);
      process.exit(1);
    }

    const granularity = opts.granularity as "file" | "directory" | "class";
    if (!["file", "directory", "class"].includes(granularity)) {
      console.error("granularity must be file | directory | class");
      process.exit(1);
    }

    const exclude = String(opts.exclude || "")
      .split(",")
      .map((x: string) => x.trim())
      .filter(Boolean);
    const rulesPath = opts.config || opts.rules;
    try {
      const result = analyze(abs, {
        rulesPath,
        exclude,
        granularity,
      });

      if (opts.reportUnclassified) {
        printUnclassifiedReport(result);
        if (!opts.output && !opts.json) {
          // allow combining with server / json; if alone, exit after report
        }
      }

      if (opts.output) {
        fs.writeFileSync(path.resolve(opts.output), analysisToJson(result), "utf8");
        console.log(`Wrote ${opts.output}`);
        console.log(
          `summary: ${result.summary.fileCount} files, ${result.summary.edgeCount} edges, ${result.summary.issueCount} issues`,
        );
        if (!opts.reportUnclassified) printIssueBrief(result);
        return;
      }

      if (opts.json) {
        process.stdout.write(analysisToJson(result));
        return;
      }

      if (opts.reportUnclassified && !opts.output) {
        // still start server unless user only wanted the report — keep server as default UX
      }

      const port = Number(opts.port);
      startServer({
        target: abs,
        rulesPath,
        exclude,
        host: opts.host,
        port,
        initial: result,
      });

      if (opts.open !== false) {
        console.log(`Open ${`http://${opts.host}:${port}`} in your browser`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

function printIssueBrief(result: ReturnType<typeof analyze>) {
  if (result.issues.length === 0) {
    console.log("No design issues detected.");
    return;
  }
  console.log("Issues:");
  for (const issue of result.issues) {
    console.log(`- [${issue.severity}] ${issue.kind}: ${issue.title}`);
    console.log(`  ${issue.reason}`);
  }
}

program.parse();
