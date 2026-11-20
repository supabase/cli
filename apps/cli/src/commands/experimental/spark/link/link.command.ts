import { Command } from "effect/cli";

import { managementApiRuntimeLayer } from "../../../../command-internal/management-api-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { sparkLink } from "./link.handler.ts";
import { projectRef } from "../spark.flags.ts";

export const sparkLinkCommand = Command.make("link", { projectRef }).pipe(
  Command.withDescription("Links this checkout to a Spark project through the Management API."),
  Command.withShortDescription("Link to a Spark project"),
  Command.withHandler((flags) =>
    sparkLink(flags).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["link"])),
);
