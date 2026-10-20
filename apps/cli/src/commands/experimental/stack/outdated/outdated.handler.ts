import { defaultArtifactSelection } from "@supabase/stack/defaults";
import { Effect, Ref, Schema } from "effect";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { loadLocalProjectContext } from "../../../../command-internal/local-project-context.ts";
import { loadStackConfig, StackConfigError } from "../../../../command-internal/stack-config.ts";
import {
  LockResolutionError,
  outdatedServices,
  type OutdatedService,
  LOCK_FILE,
} from "../../../../command-internal/stack-lock.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { renderGlamourTable } from "../../../../output/glamour-table.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { mapTargetError, rejectStackOutput } from "../stack.shared.ts";
import { StackCommandOutdatedError } from "./outdated.errors.ts";

const status = (row: OutdatedService) =>
  row.error !== undefined
    ? "probe failed"
    : row.stale !== undefined
      ? "stale"
      : row.update !== undefined
        ? "update available"
        : "up to date";

const render = (rows: ReadonlyArray<OutdatedService>) => {
  const table = renderGlamourTable(
    ["SERVICE", "SPECIFIER", "HOSTED", "LOCKED", "UPDATE", "BUNDLED", "STATUS"],
    rows.map((row) => [
      row.service,
      row.specifier,
      row.hosted ?? "-",
      row.locked,
      row.update ?? "-",
      row.bundled,
      status(row),
    ]),
  ).trimEnd();
  const details = rows.flatMap(({ service, stale, error }) => [
    ...(stale === undefined ? [] : [`  ${service}: ${LOCK_FILE} is stale (${stale})`]),
    ...(error === undefined ? [] : [`  ${service}: ${error}`]),
  ]);
  const hints = [
    ...(rows.some(({ update }) => update !== undefined)
      ? ["Run supabase stack update to adopt the updates."]
      : []),
    ...(rows.some(({ stale }) => stale !== undefined)
      ? ["Run supabase start or supabase stack update to re-resolve stale entries."]
      : []),
  ];
  return `${[table, ...(details.length === 0 ? [] : ["", ...details]), ...(hints.length === 0 ? [] : ["", ...hints])].join("\n")}\n`;
};

/**
 * Reports which locked service versions a `stack update` would change, without writing or downloading
 * anything. Hosted versions are the stored observations; only `stack update` re-probes the project.
 */
export const stackOutdated = Effect.fn("experimental.stack.outdated")(function* () {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    yield* rejectStackOutput(outputFlag).pipe(
      Effect.mapError(mapTargetError((props) => new StackCommandOutdatedError(props))),
    );

    const reported = yield* Ref.make<ReadonlyArray<OutdatedService> | undefined>(undefined);
    yield* Effect.gen(function* () {
      const context = yield* loadLocalProjectContext(
        settings.workdir,
        (message) => new StackConfigError({ message }),
      );
      return yield* loadStackConfig(settings.workdir, {
        context,
        selection: (request) =>
          outdatedServices(request).pipe(
            Effect.tap((rows) => Ref.set(reported, rows)),
            Effect.as(defaultArtifactSelection()),
          ),
      });
    }).pipe(
      Effect.mapError(
        (error) =>
          new StackCommandOutdatedError({
            reason: Schema.is(LockResolutionError)(error) ? "lock" : "invalid-config",
            message: error.message,
            cause: error,
          }),
      ),
      Effect.withSpan("outdated.probe"),
    );
    const rows = yield* Ref.get(reported);
    if (rows === undefined)
      return yield* new StackCommandOutdatedError({
        reason: "invalid-config",
        message: "No supabase/config.toml in this project, so there is no lock to inspect.",
        suggestion: "Run supabase init, then supabase start to create supabase/supabase.lock.",
      });

    const outdated = rows.filter(({ update }) => update !== undefined).length;
    const stale = rows.filter((row) => row.stale !== undefined).length;
    const failed = rows.filter((row) => row.error !== undefined).length;
    yield* Effect.annotateCurrentSpan({
      "outdated.service_count": rows.length,
      "outdated.updatable_count": outdated,
      "outdated.stale_count": stale,
      "outdated.failed_count": failed,
    });
    if (output.format === "text") yield* output.raw(render(rows));
    else
      yield* output.success("", {
        file: LOCK_FILE,
        services: rows.map((row) => ({
          service: row.service,
          specifier: row.specifier,
          resolution: row.resolution,
          hosted: row.hosted ?? null,
          locked: row.locked,
          update: row.update ?? null,
          bundled: row.bundled,
          stale: row.stale ?? null,
          error: row.error ?? null,
        })),
        updatable: outdated,
        stale,
        failed,
      });
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
