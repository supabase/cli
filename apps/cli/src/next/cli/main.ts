#!/usr/bin/env bun
import { runCli } from "../../shared/cli/run.ts";
import { nextRoot } from "./root.ts";

await runCli(nextRoot);
