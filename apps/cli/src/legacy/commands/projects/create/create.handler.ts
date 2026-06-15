import { Effect, Option } from "effect";

import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { legacyProjectCreateCore } from "../../../shared/legacy-project-create-core.ts";
import { LegacyProjectsCreateMissingArgError } from "../projects.errors.ts";
import type { LegacyProjectsCreateFlags } from "./create.command.ts";

export const legacyProjectsCreate = Effect.fn("legacy.projects.create")(function* (
  flags: LegacyProjectsCreateFlags,
) {
  const output = yield* Output;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const tty = yield* Tty;

  let createdRef: string | undefined;

  yield* Effect.gen(function* () {
    // Go gates interactivity on `term.IsTerminal(stdin) && interactive`
    // (`projects.go:63`); `--interactive` defaults to true. We additionally
    // require a text-mode `Output` so json/stream-json never prompt.
    const interactive = Option.getOrElse(flags.interactive, () => true);
    const effectiveInteractive = interactive && tty.stdinIsTty && output.interactive;

    const name = Option.getOrElse(flags.name, () => "");
    const orgId = Option.getOrElse(flags.orgId, () => "");
    const region = Option.getOrUndefined(flags.region);
    const dbPassword = Option.getOrElse(flags.dbPassword, () => "");
    const size = Option.getOrUndefined(flags.size);
    const highAvailability = Option.getOrUndefined(flags.highAvailability);

    // Non-interactive: Go's PreRunE marks `--org-id`, `--db-password`,
    // `--region` required and the project name positional `ExactArgs(1)`.
    if (!effectiveInteractive) {
      const missing: Array<string> = [];
      if (name.length === 0) missing.push("project name");
      if (orgId.length === 0) missing.push("--org-id");
      if (dbPassword.length === 0) missing.push("--db-password");
      if (region === undefined) missing.push("--region");
      if (missing.length > 0) {
        return yield* new LegacyProjectsCreateMissingArgError({
          message: `non-interactive mode requires the following to be set: ${missing.join(", ")}`,
        });
      }
    }

    const { ref } = yield* legacyProjectCreateCore({
      name,
      orgId,
      dbPassword,
      region,
      size,
      highAvailability,
      templateUrl: undefined,
      emitStructuredResult: true,
    });
    createdRef = ref.length > 0 ? ref : undefined;
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        createdRef === undefined ? Effect.void : linkedProjectCache.cache(createdRef),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
