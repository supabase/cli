import { Command } from "effect/unstable/cli";
import { projectCommandBaseLayer } from "../../../config/project-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { list } from "./list.handler.ts";

export const remotesListCommand = Command.make("list").pipe(
  Command.withDescription("List named remote Supabase projects from supabase/config.toml."),
  Command.withShortDescription("List configured remotes"),
  Command.withHandler(() => list().pipe(withCommandInstrumentation(), withJsonErrorHandling)),
  Command.provide(commandRuntimeLayer(["remotes", "list"])),
  Command.provide(projectCommandBaseLayer),
);
