import { Effect, FileSystem, Option } from "effect";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { seedBucketsRun } from "../../../command-internal/seed-buckets.ts";
import { requireExplicitWorkdirProject } from "../../../command-internal/workdir-project.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { seedChangedTargetFlags } from "./buckets.flags.ts";
import type { BucketsFlags } from "./buckets.command.ts";
import {
  SeedMissingProjectConfigError,
  SeedMutuallyExclusiveFlagsError,
  SeedWorkdirError,
} from "./buckets.errors.ts";

/**
 * `supabase seed buckets` — seeds Storage buckets from
 * `[storage.buckets]` / `[storage.vector]` in `supabase/config.toml`.
 *
 * Port of `apps/cli-go/internal/seed/buckets/buckets.go`. When `--linked` is
 * passed, the remote Storage gateway is used with the project's service-role key;
 * otherwise the local stack is used. The seeding work lives in the hoisted
 * `seedBucketsRun` (shared with `db reset --local`); this handler owns the
 * target-flag resolution and the post-run cache + telemetry side effects.
 */
export const seedBuckets = Effect.fn("seed.buckets")(function* (
  // Target (linked vs. local) is selected from the changed-flag set
  // (`flag.Changed`), not the parsed `linked`/`local` values — only
  // `projectRef` is read directly below.
  flags: BucketsFlags,
) {
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const cliArgs = yield* CliArgs;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;

  // Set once --linked resolves a ref; drives the post-run linked-project cache
  // write + org/project group identify (`cmd/root.go`'s `ensureProjectGroupsCached`,
  // gated on a non-empty `flags.ProjectRef`). Empty on the local
  // path, so the cache is never written there.
  let linkedRef = "";

  yield* Effect.gen(function* () {
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new SeedWorkdirError({ message: error.message })),
    );

    // Resolve the project ref for --linked BEFORE loading config, so that the
    // matching `[remotes.<name>]` override (whose `project_id == ref`) is merged
    // over the base config by `loadCliConfig`. The target is selected from
    // `flag.Changed`, not the flag value: `--linked` is the linked path whenever
    // it's *set* (even `--linked=false`).
    const setFlags = seedChangedTargetFlags(cliArgs.args);
    const isLinked = setFlags.includes("linked");

    // `--project-ref` never implies `--linked` and must not be silently
    // discarded on the local target — see push.handler.ts's identical guard
    // (db push) for the full TS-only rationale.
    if (Option.isSome(flags.projectRef) && !isLinked) {
      return yield* Effect.fail(
        new SeedMutuallyExclusiveFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local)",
        }),
      );
    }

    // An explicit `--workdir`/`SUPABASE_WORKDIR` that holds no project config
    // fails HERE, before the api-keys fetch and any Storage call — fixes the
    // "authenticates, seeds nothing, exits 0" bug. `start`/`db reset` never
    // reach this handler (they call `seedBucketsRun` directly), so
    // their behavior is unaffected. A DEFAULTED workdir is untouched — see
    // `requireExplicitWorkdirProject`'s own doc comment.
    yield* requireExplicitWorkdirProject(cliSettings).pipe(
      Effect.mapError((error) => new SeedMissingProjectConfigError({ message: error.message })),
    );

    const projectRefResolver = yield* ProjectRefResolver;
    const projectRef = isLinked ? yield* projectRefResolver.loadProjectRef(flags.projectRef) : "";
    linkedRef = projectRef;

    yield* seedBucketsRun({ projectRef, emitSummary: true });
  }).pipe(
    // Caches the linked project + fires org/project group identify whenever
    // `flags.ProjectRef` is set — only on the --linked path.
    Effect.ensuring(
      Effect.suspend(() => (linkedRef === "" ? Effect.void : linkedProjectCache.cache(linkedRef))),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
