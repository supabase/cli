import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { RESOURCE_OUTPUT_FORMATS } from "../../../command-internal/go-output-flag.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import {
  validateOutputFormat,
  withCommandTelemetry,
} from "../../../telemetry/command-telemetry.ts";
import { sslEnforcementGet } from "./get.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type SslEnforcementGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const sslEnforcementGetCommand = Command.make("get", config).pipe(
  Command.withDescription("Get the current SSL enforcement configuration."),
  Command.withShortDescription("Get SSL enforcement configuration"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // An invalid `-o` value must be rejected before the missing
      // `--experimental` check, matching flag-parsing precedence.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // The --experimental gate must run before `managementApiRuntimeLayer` is
      // provided (inline here, not via `Command.provide`) — that layer eagerly
      // resolves an access token and would fail on a missing one first.
      yield* requireExperimental;
      return yield* sslEnforcementGet(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["ssl-enforcement", "get"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
