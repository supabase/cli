#!/usr/bin/env bun

import { createProcessCompose } from "./index.ts";

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let configPath = "";
  let apiPort = 8080;
  let noApi = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-f" || arg === "--file") {
      configPath = args[++i] ?? "";
    } else if (arg === "-p" || arg === "--port") {
      apiPort = parseInt(args[++i] ?? "8080", 10);
    } else if (arg === "--no-api") {
      noApi = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (!arg?.startsWith("-") && !configPath) {
      configPath = arg ?? "";
    }
  }

  if (!configPath) {
    // Try default paths
    const defaultPaths = ["process-compose.yaml", "process-compose.yml"];
    for (const path of defaultPaths) {
      if (await Bun.file(path).exists()) {
        configPath = path;
        break;
      }
    }
  }

  if (!configPath) {
    console.error("Error: No config file specified and no default found");
    console.error("Usage: process-compose -f <config.yaml>");
    process.exit(1);
  }

  console.log(`Loading config from: ${configPath}`);

  try {
    const pc = await createProcessCompose({
      configPath,
      apiPort,
      startApi: !noApi,
    });

    console.log(`Starting project: ${pc.orchestrator.projectName}`);
    await pc.start();

    // Keep running
    await new Promise(() => {});
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
process-compose - Process orchestrator

Usage:
  process-compose [options] [config-file]

Options:
  -f, --file <path>   Path to config file (default: process-compose.yaml)
  -p, --port <port>   API server port (default: 8080)
  --no-api            Don't start the API server
  -h, --help          Show this help

API Endpoints:
  GET  /live                              Health check
  GET  /processes                         Get all process states
  GET  /process/:name                     Get single process state
  POST /process/start/:name               Start a process
  PATCH /process/stop/:name               Stop a process
  POST /process/restart/:name             Restart a process
  GET  /process/logs/:name/:offset/:limit Get process logs
  DELETE /process/logs/:name              Truncate process logs
  POST /project/stop                      Stop all processes
`);
}

void main();
