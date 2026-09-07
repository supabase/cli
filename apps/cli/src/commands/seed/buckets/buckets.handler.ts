import { Effect, FileSystem, Option } from "effect";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacySeedBucketsRun } from "../../../command-internal/legacy-seed-buckets.ts";
import { legacyRequireExplicitWorkdirProject } from "../../../command-internal/legacy-workdir-project.ts";
import { legacyValidateWorkdirIsDirectory } from "../../../command-internal/legacy-workdir-validation.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacySeedChangedTargetFlags } from "./buckets.flags.ts";
import type { LegacyBucketsFlags } from "./buckets.command.ts";
import {
  LegacySeedMissingProjectConfigError,
  LegacySeedMutuallyExclusiveFlagsError,
  LegacySeedWorkdirError,
} from "./buckets.errors.ts";

/**
 * `supabase seed buckets` — seeds Storage buckets from
 * `[storage.buckets]` / `[storage.vector]` in `supabase/config.toml`.
 *
 * Port of `apps/cli-go/internal/seed/buckets/buckets.go`. When `--linked` is
 * passed, the remote Storage gateway is used with the project's service-role key;
 * otherwise the local stack is used. The seeding work lives in the hoisted
 * `legacySeedBucketsRun` (shared with `db reset --local`); this handler owns the
 * target-flag resolution and the post-run cache + telemetry side effects.
 */
export const legacySeedBuckets = Effect.fn("legacy.seed.buckets")(function* (
  // Target (linked vs. local) is selected from the changed-flag set
  // (`flag.Changed`), not the parsed `linked`/`local` values — only
  // `projectRef` is read directly below.
  flags: LegacyBucketsFlags,
) {
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const cliArgs = yield* CliArgs;
  const cliSettings = yield* LegacyCliSettings;
  const fs = yield* FileSystem.FileSystem;

  // Set once --linked resolves a ref; drives the post-run linked-project cache
  // write + org/project group identify (`cmd/root.go`'s `ensureProjectGroupsCached`,
  // gated on a non-empty `flags.ProjectRef`). Empty on the local
  // path, so the cache is never written there.
  let linkedRef = "";

  yield* Effect.gen(function* () {
    yield* legacyValidateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new LegacySeedWorkdirError({ message: error.message })),
    );

    // Resolve the project ref for --linked BEFORE loading config, so that the
    // matching `[remotes.<name>]` override (whose `project_id == ref`) is merged
    // over the base config by `loadCliConfig`. The target is selected from
    // `flag.Changed`, not the flag value: `--linked` is the linked path whenever
    // it's *set* (even `--linked=false`).
    const setFlags = legacySeedChangedTargetFlags(cliArgs.args);
    const isLinked = setFlags.includes("linked");

    // `--project-ref` never implies `--linked` and must not be silently
    // discarded on the local target — see push.handler.ts's identical guard
    // (db push) for the full TS-only rationale.
    if (Option.isSome(flags.projectRef) && !isLinked) {
      return yield* Effect.fail(
        new LegacySeedMutuallyExclusiveFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local)",
        }),
      );
    }

    // An explicit `--workdir`/`SUPABASE_WORKDIR` that holds no project config
    // fails HERE, before the api-keys fetch and any Storage call — fixes the
    // "authenticates, seeds nothing, exits 0" bug. `start`/`db reset` never
    // reach this handler (they call `legacySeedBucketsRun` directly), so
    // their behavior is unaffected. A DEFAULTED workdir is untouched — see
    // `legacyRequireExplicitWorkdirProject`'s own doc comment.
    yield* legacyRequireExplicitWorkdirProject(cliSettings).pipe(
      Effect.mapError(
        (error) => new LegacySeedMissingProjectConfigError({ message: error.message }),
      ),
    );

    const projectRefResolver = yield* LegacyProjectRefResolver;
    const projectRef = isLinked ? yield* projectRefResolver.loadProjectRef(flags.projectRef) : "";
    linkedRef = projectRef;

    yield* legacySeedBucketsRun({ projectRef, emitSummary: true });
  }).pipe(
    // Caches the linked project + fires org/project group identify whenever
    // `flags.ProjectRef` is set — only on the --linked path.
    Effect.ensuring(
      Effect.suspend(() => (linkedRef === "" ? Effect.void : linkedProjectCache.cache(linkedRef))),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
