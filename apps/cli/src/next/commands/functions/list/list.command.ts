import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { credentialsLayer } from "../../../auth/credentials.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { functionsList } from "./list.handler.ts";

const functionsListRuntimeLayer = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  credentialsLayer,
  commandRuntimeLayer(["functions", "list"]),
);

export const functionsListCommand = Command.make("list").pipe(
  Command.withDescription(
    "List Edge Functions from the local project inventory and enrich with linked remote deployment data when available.",
  ),
  Command.withShortDescription("List Edge Functions"),
  Command.withExamples([
    {
      command: "supabase functions list",
      description: "List local Edge Functions and linked remote deployment status",
    },
    {
      command: "supabase functions list --output-format json",
      description: "Emit the merged functions inventory as JSON",
    },
  ]),
  Command.withHandler(() =>
    functionsList().pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(functionsListRuntimeLayer),
);
