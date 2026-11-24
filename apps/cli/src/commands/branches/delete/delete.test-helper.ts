import { Effect, Layer } from "effect";

import {
  CommandExecutor,
  commandExecutorLayer,
} from "../../../command-internal/command-executor.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { BranchesDeleteResult, type BranchesDeleteFlags } from "./delete.command.ts";
import { branchesDelete } from "./delete.handler.ts";

export const runBranchesDelete = (flags: BranchesDeleteFlags) =>
  CommandExecutor.use((executor) =>
    executor.run({ output: BranchesDeleteResult, handler: branchesDelete }, flags, Layer.empty),
  ).pipe(Effect.provide([commandExecutorLayer, commandRuntimeLayer(["branches", "delete"])]));
