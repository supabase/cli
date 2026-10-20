import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackOutdated } from "./outdated.handler.ts";

export const stackOutdatedCommand = Command.make("outdated").pipe(
  Command.withDescription(
    "Report, for each service in supabase/supabase.lock, the release supabase stack update would lock instead, this CLI's bundled pin, and whether the entry is out of date with config.toml. " +
      "Read-only: it writes nothing and downloads no artifacts.",
  ),
  Command.withShortDescription("Show locked service versions with newer releases"),
  Command.withExamples([
    {
      command: "supabase stack outdated",
      description: "List what supabase stack update would change",
    },
  ]),
  withPermissions({ operations: [] }),
  Command.withHandler(() =>
    stackOutdated().pipe(withCommandTelemetry({ flags: {} }), withJsonErrorHandling),
  ),
);
