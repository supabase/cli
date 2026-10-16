import { defaultArtifactSelection } from "@supabase/stack/defaults";
import { artifactServiceKinds, type ServiceKind } from "@supabase/stack/internal/artifacts";
import { Effect, Option, Ref, Schema } from "effect";
import { CommandPlatformApiFactory } from "../../../../auth/command-platform-api-factory.service.ts";
import { probeLinkedTarget } from "../../../../command-internal/hosted-versions.ts";
import { readProjectLink } from "../../../../command-internal/project-link.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { loadLocalProjectContext } from "../../../../command-internal/local-project-context.ts";
import { loadStackConfig, StackConfigError } from "../../../../command-internal/stack-config.ts";
import {
  LOCK_FILE,
  LockResolutionError,
  updatedLock,
  type LockUpdate,
} from "../../../../command-internal/stack-lock.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { mapTargetError, rejectStackOutput } from "../stack.shared.ts";
import { StackCommandUpdateError } from "./update.errors.ts";
import type { StackUpdateFlags } from "./update.command.ts";

const serviceKinds = (names: ReadonlyArray<string>) => {
  const valid = artifactServiceKinds();
  const unknown = names.filter((name) => !valid.some((kind) => kind === name));
  return unknown.length === 0
    ? Effect.succeed(valid.filter((kind) => names.includes(kind)))
    : Effect.fail(
        new StackCommandUpdateError({
          reason: "flags",
          message: `Unknown service ${unknown.map((name) => `"${name}"`).join(", ")}; valid services are ${valid.join(", ")}.`,
        }),
      );
};

const render = (update: LockUpdate) => {
  const skipped = update.stale.map(
    ({ service, reason }) =>
      `${service} is stale (${reason}); run supabase start or supabase stack update ${service}`,
  );
  if (!update.written)
    return skipped.length === 0
      ? `${LOCK_FILE} is already up to date.\n`
      : `${skipped.join("\n")}\n`;
  const lines = update.changes.map(({ service, from, to, reason }) => {
    const arrow = from === undefined ? "" : `${from} → `;
    return `  ${service.padEnd(9)} ${arrow}${to}  (${reason})`;
  });
  return `${["Updated service versions:", ...lines, `Updated ${LOCK_FILE} (${update.changes.length} changed, ${update.unchanged.length} unchanged).`, ...skipped].join("\n")}\n`;
};

const lockReport = (update: LockUpdate) => ({
  file: LOCK_FILE,
  written: update.written,
  added: update.changes.flatMap(({ service, from, to, reason }) =>
    from === undefined ? [{ service, to, reason }] : [],
  ),
  changed: update.changes.flatMap(({ service, from, to, reason }) =>
    from === undefined ? [] : [{ service, from, to, reason }],
  ),
  unchanged: update.unchanged,
  stale: update.stale.map(({ service }) => service),
});

/** Re-resolves the named service versions in the project lock and writes it, without downloading anything. */
export const stackUpdate = Effect.fn("experimental.stack.update")(function* (
  flags: StackUpdateFlags,
) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    yield* rejectStackOutput(outputFlag).pipe(
      Effect.mapError(mapTargetError((props) => new StackCommandUpdateError(props))),
    );
    const services: ReadonlyArray<ServiceKind> = yield* serviceKinds(flags.services);

    const updated = yield* Ref.make<LockUpdate | undefined>(undefined);
    // The hosted probe needs a login, so it runs only when a linked entry is re-resolved.
    const probe = Effect.gen(function* () {
      const link = yield* readProjectLink(settings.workdir);
      if (Option.isNone(link)) return Option.none();
      const api = yield* (yield* CommandPlatformApiFactory).make;
      return Option.some(yield* probeLinkedTarget(api, link.value));
    }).pipe(
      Effect.mapError(
        (error) =>
          new StackCommandUpdateError({
            reason: "hosted",
            message: `Could not read the hosted versions of the linked project: ${error.message}`,
            suggestion: "Run supabase login, then supabase link, and retry.",
            cause: error,
          }),
      ),
    );
    const update = updatedLock({ services, probe, output });
    yield* Effect.gen(function* () {
      const context = yield* loadLocalProjectContext(
        settings.workdir,
        (message) => new StackConfigError({ message }),
      );
      return yield* loadStackConfig(settings.workdir, {
        context,
        selection: (request) =>
          update(request).pipe(
            Effect.tap((result) => Ref.set(updated, result)),
            Effect.as(defaultArtifactSelection()),
          ),
      });
    }).pipe(
      Effect.mapError((error) =>
        error instanceof StackCommandUpdateError
          ? error
          : new StackCommandUpdateError({
              reason: Schema.is(LockResolutionError)(error) ? "lock" : "invalid-config",
              message: error.message,
              cause: error,
            }),
      ),
      Effect.withSpan("update.resolve"),
    );
    const result = yield* Ref.get(updated);
    if (result === undefined)
      return yield* new StackCommandUpdateError({
        reason: "invalid-config",
        message: "No supabase/config.toml in this project, so there is no lock to update.",
        suggestion: "Run supabase init, then supabase start to create supabase/supabase.lock.",
      });

    yield* Effect.annotateCurrentSpan({
      "update.requested_count": services.length,
      "update.updated_count": result.changes.length,
      "update.unchanged_count": result.unchanged.length,
      "update.stale_count": result.stale.length,
      "update.lock_written": result.written,
    });
    if (output.format === "text") yield* output.raw(render(result));
    else yield* output.success("", { lock: lockReport(result) });
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
