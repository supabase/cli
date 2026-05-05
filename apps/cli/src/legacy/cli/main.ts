#!/usr/bin/env bun
import { runCli } from "../../shared/cli/run.ts";
import { legacyRoot } from "./root.ts";

await runCli(legacyRoot);
