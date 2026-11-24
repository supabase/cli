import { Effect, FileSystem, Option, Path, Random, Ref, Schedule } from "effect";

import { readCachedLinkedProject } from "../../../../command-internal/parent-project-ref.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  createSparkProject,
  findSparkProject,
  getSparkApiKeys,
  listSparkOrganizations,
  withPlatformApi,
} from "../spark-api.ts";
import { applyPendingMigrations, runSeedFiles } from "../spark-apply.ts";
import {
  emitDevInstanceStatus,
  readDevInstanceState,
  requireDevInstanceState,
  SparkDevInstanceError,
  writeDevInstanceState,
} from "../spark-dev-instance.ts";
import { SparkApiError } from "../spark-project.ts";
import { withDevInstanceTarget } from "../spark-target.ts";

const HEALTHY = "ACTIVE_HEALTHY";
const HEALTHY_TIMEOUT_SECONDS = 60;

/** `dev-<folder>-<6 hex>`, the folder reduced to lowercase letters, digits and dashes. */
const devInstanceName = Effect.fnUntraced(function* (root: string) {
  const path = yield* Path.Path;
  const folder =
    path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40) || "project";
  const suffix = (yield* Random.nextIntBetween(0, 0x1000000, { halfOpen: true }))
    .toString(16)
    .padStart(6, "0");
  return `dev-${folder}-${suffix}`;
});

/** `--org`, then the linked project's organization, then the account's only organization. */
const pickOrganization = Effect.fn("spark.start.organization")(function* (
  flag: Option.Option<string>,
) {
  if (Option.isSome(flag)) return flag.value;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* CommandSettings;
  const linked = yield* readCachedLinkedProject(fs, path, settings.workdir);
  const linkedSlug = Option.getOrUndefined(linked)?.organizationSlug;
  if (linkedSlug !== undefined) return linkedSlug;
  const slugs = yield* listSparkOrganizations();
  const [only, ...others] = slugs;
  if (only !== undefined && others.length === 0) return only;
  return yield* new SparkDevInstanceError({
    reason: "organization",
    message:
      only === undefined
        ? "Your account has no organization to create the dev instance in. Create one, then run `supabase start` again."
        : `Your account has several organizations (${slugs.join(", ")}). Choose one with \`supabase start --org <slug>\`.`,
  });
});

/** Polls the project until it is `ACTIVE_HEALTHY`, for at most a minute. */
const waitForHealthy = Effect.fn("spark.start.waitForHealthy")(function* (ref: string) {
  const last = yield* Ref.make("UNKNOWN");
  const project = yield* Ref.make(Option.none<{ readonly api_url?: string }>());
  const check = Effect.gen(function* () {
    const found = yield* findSparkProject(ref);
    if (Option.isNone(found))
      return yield* new SparkApiError({
        message: `the project ${ref} does not exist`,
        status: 404,
      });
    yield* Ref.set(last, found.value.status ?? "UNKNOWN");
    yield* Ref.set(project, found);
    return found.value.status === HEALTHY;
  });
  yield* check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("1 second"), while: (healthy) => !healthy }),
    Effect.timeoutOrElse({
      duration: `${HEALTHY_TIMEOUT_SECONDS} seconds`,
      orElse: () =>
        Effect.flatMap(
          Ref.get(last),
          (status) =>
            new SparkDevInstanceError({
              reason: "timeout",
              message: `The dev instance ${ref} is not ${HEALTHY} after ${HEALTHY_TIMEOUT_SECONDS} seconds (status ${status}). Run \`supabase start\` again to wait for it, or delete it with \`supabase projects delete ${ref}\`.`,
            }),
        ),
    }),
  );
  return Option.getOrUndefined(yield* Ref.get(project))?.api_url;
});

/** The recorded dev instance when the Management API still finds it, else a new one. */
const ensureDevInstance = Effect.fn("spark.start.ensure")(function* (org: Option.Option<string>) {
  const output = yield* Output;
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  if (Option.isSome(yield* readDevInstanceState())) {
    const state = yield* requireDevInstanceState();
    if (Option.isSome(yield* findSparkProject(state.ref))) {
      yield* waitForHealthy(state.ref);
      yield* output.raw(`Using dev instance ${state.name} (${state.ref}).\n`, "stderr");
      return { state, created: false };
    }
    yield* output.raw(
      `The dev instance ${state.ref} no longer exists; creating a new one.\n`,
      "stderr",
    );
  }
  const organization = yield* pickOrganization(org);
  const name = yield* devInstanceName(path.resolve(settings.workdir));
  yield* output.raw(`Creating dev instance ${name} in organization ${organization}...\n`, "stderr");
  const ref = yield* createSparkProject({ name, organizationSlug: organization });
  const apiUrl = yield* waitForHealthy(ref);
  const keys = yield* getSparkApiKeys(ref);
  const state = {
    ref,
    name,
    organization_slug: organization,
    api_url: apiUrl ?? `https://${ref}.${settings.projectHost}`,
    anon_key: keys.anonKey,
    service_role_key: keys.serviceRoleKey,
    management_api_url: settings.apiUrl,
  };
  yield* writeDevInstanceState(state);
  return { state, created: true };
});

/**
 * `supabase start` in dev-instance mode: creates or reuses the checkout's dev instance, applies
 * the pending migrations, seeds a new instance, and prints what `status` prints.
 */
export const sparkDevStart = Effect.fn("spark.start")(function* (flags: {
  readonly org: Option.Option<string>;
}) {
  const telemetryState = yield* TelemetryState;
  yield* Effect.gen(function* () {
    const { state, created } = yield* withPlatformApi(ensureDevInstance(flags.org));
    yield* Effect.annotateCurrentSpan({ "spark.dev_instance.created": created });
    yield* withDevInstanceTarget(
      Effect.gen(function* () {
        yield* applyPendingMigrations;
        if (created) yield* runSeedFiles();
      }),
    );
    yield* emitDevInstanceStatus(state, HEALTHY, { env: false });
  }).pipe(Effect.ensuring(telemetryState.flush));
});
