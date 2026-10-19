import { Effect, FileSystem, Ref } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { requireTargetMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { seedBucketsRun } from "../../../command-internal/seed-buckets.ts";
import { announceLocalStorageTarget } from "../../../command-internal/storage-gateway.ts";
import { resolveTarget } from "../../../command-internal/target/resolve-target.ts";
import { requireExplicitWorkdirProject } from "../../../command-internal/workdir-project.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { BucketsFlags } from "./buckets.command.ts";
import { SeedMissingProjectConfigError, SeedWorkdirError } from "./buckets.errors.ts";

/**
 * `supabase seed buckets` — seeds Storage buckets from
 * `[storage.buckets]` / `[storage.vector]` in `supabase/config.toml`. The
 * seeding work lives in the hoisted `seedBucketsRun` (shared with `db reset`); this
 * handler owns target resolution, hosted consent and telemetry.
 */
export const seedBuckets = Effect.fn("seed.buckets")(function* (flags: BucketsFlags) {
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;

  // Set once the target resolves to a linked project; drives the post-run linked-project
  // cache write and org/project group identify. Empty on the local path.
  const linkedRef = yield* Ref.make("");

  yield* Effect.gen(function* () {
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new SeedWorkdirError({ message: error.message })),
    );

    // An explicit `--workdir`/`SUPABASE_WORKDIR` with no project config fails
    // here, before any Storage call, instead of authenticating and seeding
    // nothing while exiting 0. `start`/`db reset` skip this by calling
    // `seedBucketsRun` directly.
    yield* requireExplicitWorkdirProject(cliSettings).pipe(
      Effect.mapError((error) => new SeedMissingProjectConfigError({ message: error.message })),
    );

    // Resolved before the config load so the matching `[remotes.<name>]` override
    // (whose `project_id == ref`) is merged over the base config.
    const target = yield* resolveTarget({
      remote: flags.remote,
      local: flags.local,
      linked: flags.linked,
      projectRef: flags.projectRef,
    });
    const projectRef = target.kind === "linked" ? target.ref : "";
    yield* Ref.set(linkedRef, projectRef);

    yield* Effect.annotateCurrentSpan({ "db.conn_type": target.kind });
    yield* seedBucketsRun({
      projectRef,
      emitSummary: true,
      announceLocalEndpoint: announceLocalStorageTarget,
      confirmHostedWrites:
        target.kind === "linked"
          ? (details) =>
              requireTargetMutationConsent(target, { action: "Seed storage buckets", details })
          : undefined,
    });
  }).pipe(
    // Caches the linked project and fires org/project group identify — only
    // on the linked path, when `linkedRef` is set.
    Effect.ensuring(
      Effect.flatMap(Ref.get(linkedRef), (ref) =>
        ref === "" ? Effect.void : linkedProjectCache.cache(ref),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
