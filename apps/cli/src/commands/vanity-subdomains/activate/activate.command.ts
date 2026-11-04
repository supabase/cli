import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { RESOURCE_OUTPUT_FORMATS } from "../../../command-internal/output-formats.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import {
  validateOutputFormat,
  withCommandTelemetry,
} from "../../../telemetry/command-telemetry.ts";
import { vanitySubdomainsActivate } from "./activate.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
  // Optional at parse time so the --experimental gate, login check, and project-ref
  // resolution all run first; required-ness is enforced in the handler after ref
  // resolution.
  desiredSubdomain: cliFlag("desired-subdomain", Flag.String, {
    description: "The vanity subdomain to use for the project.",
    optional: true,
    docs: { required: true },
  }),
} as const;

export type VanitySubdomainsActivateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const vanitySubdomainsActivateCommand = makeCommand("activate", config).pipe(
  Command.withDescription(
    "Makes your project respond to requests on the vanity subdomain you choose. After activation, your project's auth services no longer work on the `{project-ref}.{supabase-domain}` hostname.",
  ),
  Command.withShortDescription("Activate a vanity subdomain"),
  Command.withExamples([
    {
      command: "supabase vanity-subdomains activate --desired-subdomain my-app --experimental --remote=<project-ref>",
      description: "Activate a vanity subdomain for a project",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          {
            operationId: "v1-activate-vanity-subdomain-config",
            kind: "required",
            when: [{ flag: "desired-subdomain", present: true }],
          },
          {
            operationId: "v1-activate-vanity-subdomain-config",
            kind: "required",
            when: [{ flag: "desired-subdomain", oneOf: [""] }],
          },
        ],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // An invalid `-o` value must win over a missing `--experimental` flag, so this
      // validation runs before the gate.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // `managementApiRuntimeLayer` eagerly resolves an access token, so it's provided
      // inline after the experimental gate rather than via `Command.provide` on the
      // whole command — `Command.provide` would build the layer, and fail on a missing
      // token, before the gate ever runs.
      yield* requireExperimental;
      return yield* vanitySubdomainsActivate(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["vanity-subdomains", "activate"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
