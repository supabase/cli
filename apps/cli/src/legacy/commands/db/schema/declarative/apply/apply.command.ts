import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyDbSchemaDeclarativeSharedBase } from "../declarative.shared.ts";
import { legacyDbSchemaDeclarativeApply } from "./apply.handler.ts";
import { legacyDbSchemaDeclarativeApplyRuntimeLayer } from "./apply.layers.ts";

const config = {} as const;

export type LegacyDbSchemaDeclarativeApplyFlags = CliCommand.Command.Config.Infer<typeof config> & {
  readonly noCache: boolean;
};

export const legacyDbSchemaDeclarativeApplyCommand = Command.make("apply", config).pipe(
  Command.withDescription("Apply declarative schema to the local database."),
  Command.withShortDescription("Apply declarative schema to the local database"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const shared = yield* legacyDbSchemaDeclarativeSharedBase;
      const merged: LegacyDbSchemaDeclarativeApplyFlags = { ...flags, noCache: shared.noCache };
      return yield* legacyDbSchemaDeclarativeApply(merged).pipe(
        withLegacyCommandInstrumentation({
          flags: { "no-cache": merged.noCache },
        }),
        withJsonErrorHandling,
      );
    }),
  ),
  Command.provide(legacyDbSchemaDeclarativeApplyRuntimeLayer),
);
