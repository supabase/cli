import { Effect, Option } from "effect";

import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { projectCreateCore } from "../../../command-internal/project-create-core.ts";
import { ProjectsCreateMissingArgError } from "../projects.errors.ts";
import type { ProjectsCreateFlags } from "./create.command.ts";

export const projectsCreate = Effect.fn("projects.create")(function* (flags: ProjectsCreateFlags) {
  const output = yield* Output;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const tty = yield* Tty;

  if (Option.isSome(flags.releaseChannel) || Option.isSome(flags.postgresEngine)) {
    yield* requireExperimental;
  }

  let createdRef: string | undefined;

  yield* Effect.gen(function* () {
    // Interactive mode requires a TTY stdin, `--interactive` (default true), and text-mode
    // output, so json/stream-json never prompt.
    const interactive = Option.getOrElse(flags.interactive, () => true);
    const effectiveInteractive = interactive && tty.stdinIsTty && output.interactive;

    const name = Option.getOrElse(flags.name, () => "");
    const orgId = Option.getOrElse(flags.orgId, () => "");
    const region = Option.getOrUndefined(flags.region);
    const dbPassword = Option.getOrElse(flags.dbPassword, () => "");
    const size = Option.getOrUndefined(flags.size);
    const highAvailability = Option.getOrUndefined(flags.highAvailability);
    const releaseChannel = Option.getOrUndefined(flags.releaseChannel);
    const postgresEngine = Option.getOrUndefined(flags.postgresEngine);

    if (!effectiveInteractive) {
      const missing: Array<string> = [];
      if (name.length === 0) missing.push("project name");
      if (orgId.length === 0) missing.push("--org-id");
      if (dbPassword.length === 0) missing.push("--db-password");
      if (region === undefined) missing.push("--region");
      if (missing.length > 0) {
        return yield* new ProjectsCreateMissingArgError({
          message: `non-interactive mode requires the following to be set: ${missing.join(", ")}`,
        });
      }
    }

    const { ref } = yield* projectCreateCore({
      name,
      orgId,
      dbPassword,
      region,
      size,
      highAvailability,
      releaseChannel,
      postgresEngine,
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
