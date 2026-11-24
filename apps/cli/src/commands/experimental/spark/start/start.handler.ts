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
  type DevInstanceState,
  emitDevInstanceStatus,
  ensureDevInstanceWritable,
  isDevInstanceReady,
  readDevInstanceState,
  type ReadyDevInstanceState,
  requireDevInstanceState,
  requireNoPendingReset,
  SparkDevInstanceError,
  withDevInstanceLock,
  writeDevInstanceState,
} from "../spark-dev-instance.ts";
import { SparkApiError } from "../spark-project.ts";
import { withDevInstanceTarget } from "../spark-target.ts";

const HEALTHY = "ACTIVE_HEALTHY";
const HEALTHY_TIMEOUT_SECONDS = 60;
const CREATE_TIMEOUT_SECONDS = 60;

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

/** Polls the project until it is `ACTIVE_HEALTHY`, for at most a minute; resolves to its `api_url`. */
const waitForHealthy = Effect.fn("spark.start.waitForHealthy")(function* (ref: string) {
  const last = yield* Ref.make("UNKNOWN");
  const apiUrl = yield* Ref.make(Option.none<string>());
  const check = Effect.gen(function* () {
    const found = yield* findSparkProject(ref);
    if (Option.isNone(found))
      return yield* new SparkApiError({
        message: `the project ${ref} does not exist`,
        status: 404,
      });
    yield* Ref.set(last, found.value.status ?? "UNKNOWN");
    yield* Ref.set(apiUrl, Option.fromNullishOr(found.value.api_url));
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
              message: `The dev instance ${ref} is not ${HEALTHY} after ${HEALTHY_TIMEOUT_SECONDS} seconds (status ${status}). Run \`supabase start\` again to keep waiting for it, or delete it with \`supabase stop --delete\`.`,
            }),
        ),
    }),
  );
  return yield* Ref.get(apiUrl);
});

/** Waits for the instance to be healthy, then records its URL and keys when they are missing. */
const completeDevInstance = Effect.fn("spark.start.complete")(function* (state: DevInstanceState) {
  const settings = yield* CommandSettings;
  const apiUrl = yield* waitForHealthy(state.ref);
  if (isDevInstanceReady(state)) return state;
  const keys = yield* getSparkApiKeys(state.ref);
  const ready: ReadyDevInstanceState = {
    ...state,
    api_url: Option.getOrElse(apiUrl, () => `https://${state.ref}.${settings.projectHost}`),
    anon_key: keys.anonKey,
    service_role_key: keys.serviceRoleKey,
  };
  yield* writeDevInstanceState(ready);
  return ready;
});

/**
 * The recorded dev instance when the Management API still finds it, finished when an earlier
 * `start` stopped partway; otherwise a new one, recorded as soon as the project exists.
 */
const ensureDevInstance = Effect.fn("spark.start.ensure")(function* (org: Option.Option<string>) {
  const output = yield* Output;
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  if (Option.isSome(yield* readDevInstanceState())) {
    const state = yield* requireDevInstanceState();
    if (Option.isSome(yield* findSparkProject(state.ref))) {
      yield* output.raw(
        isDevInstanceReady(state)
          ? `Using dev instance ${state.name} (${state.ref}).\n`
          : `Finishing the setup of dev instance ${state.name} (${state.ref})...\n`,
        "stderr",
      );
      return { state: yield* completeDevInstance(state), created: false };
    }
    yield* output.raw(
      `The dev instance ${state.ref} no longer exists; creating a new one.\n`,
      "stderr",
    );
  }
  const organization = yield* pickOrganization(org);
  const name = yield* devInstanceName(path.resolve(settings.workdir));
  yield* ensureDevInstanceWritable();
  yield* output.raw(`Creating dev instance ${name} in organization ${organization}...\n`, "stderr");
  // The write follows the create uninterruptibly: an interrupt between the two would leave a project
  // nothing records. The call itself stays interruptible and bounded, so a stalled answer cannot
  // hold the lock for good.
  const created = yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const ref = yield* restore(
        createSparkProject({ name, organizationSlug: organization }).pipe(
          Effect.timeoutOrElse({
            duration: `${CREATE_TIMEOUT_SECONDS} seconds`,
            orElse: () =>
              new SparkDevInstanceError({
                reason: "timeout",
                message: `Creating the dev instance ${name} got no answer within ${CREATE_TIMEOUT_SECONDS} seconds. The project may or may not have been created: check \`supabase projects list\`, then run \`supabase start\` again.`,
              }),
          }),
        ),
      );
      const state: DevInstanceState = {
        ref,
        name,
        organization_slug: organization,
        management_api_url: settings.apiUrl,
        seeded: false,
      };
      yield* writeDevInstanceState(state);
      return state;
    }),
  );
  return { state: yield* completeDevInstance(created), created: true };
});

/**
 * `supabase start`: creates, finishes or reuses the checkout's dev instance,
 * applies the pending migrations, runs the seed files unless they ran on the current database,
 * and prints what `status` prints.
 */
export const sparkDevStart = Effect.fn("spark.start")(function* (flags: {
  readonly org: Option.Option<string>;
}) {
  const telemetryState = yield* TelemetryState;
  yield* withDevInstanceLock(
    Effect.gen(function* () {
      const { state, created } = yield* withPlatformApi(ensureDevInstance(flags.org));
      yield* requireNoPendingReset(state);
      const seed = state.seeded !== true;
      yield* Effect.annotateCurrentSpan({
        "spark.dev_instance.created": created,
        "spark.dev_instance.seed": seed,
      });
      yield* withDevInstanceTarget(() => applyPendingMigrations);
      if (seed) {
        yield* withDevInstanceTarget(() => runSeedFiles());
        yield* writeDevInstanceState({ ...state, seeded: true });
      }
      yield* emitDevInstanceStatus(state, HEALTHY, { env: false });
    }),
  ).pipe(Effect.ensuring(telemetryState.flush));
});
