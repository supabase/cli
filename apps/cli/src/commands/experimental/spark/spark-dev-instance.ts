import { holdLock, isLockBusy, publish } from "@supabase/stack/effect";
import { Context, Data, Duration, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { OutputFlag } from "../../../command-internal/global-flags.ts";
import type { ProjectTargetFlagValues } from "../../../command-internal/target/target-flags.ts";
import {
  encodeEnv,
  encodeSortedJson,
  encodeToml,
  encodeYaml,
} from "../../../command-internal/output.encoders.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { DefaultProjectRef } from "../../../config/project-ref.service.ts";
import { FunctionsApiDeployMode } from "../../../shared/functions/deploy.ts";
import { ensureGitignore } from "../../../shared/config/project-link.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Whether the Spark tree runs in dev-instance mode (`[experimental.spark] dev_instance`): the
 * tree `spark.command.ts` builds for that mode provides `true`.
 */
export const SparkDevInstanceMode = Context.Reference<boolean>(
  "supabase/cli/SparkDevInstanceMode",
  { defaultValue: () => false },
);

/**
 * `supabase/.temp/dev-instance.json`: the checkout's dev instance. `start` writes it as soon as
 * the project exists, and adds the URL and keys once the instance is healthy.
 */
const DevInstanceState = Schema.Struct({
  ref: Schema.String,
  name: Schema.String,
  organization_slug: Schema.String,
  management_api_url: Schema.String,
  api_url: Schema.optionalKey(Schema.String),
  anon_key: Schema.optionalKey(Schema.String),
  service_role_key: Schema.optionalKey(Schema.String),
  /** Whether the seed files ran on the current database. */
  seeded: Schema.optionalKey(Schema.Boolean),
});
export interface DevInstanceState extends Schema.Schema.Type<typeof DevInstanceState> {}

/** A dev instance whose URL and keys are recorded: `start` finished setting it up. */
export interface ReadyDevInstanceState extends DevInstanceState {
  readonly api_url: string;
  readonly anon_key: string;
  readonly service_role_key: string;
}

export const isDevInstanceReady = (state: DevInstanceState): state is ReadyDevInstanceState =>
  state.api_url !== undefined &&
  state.anon_key !== undefined &&
  state.service_role_key !== undefined;

type DevInstanceErrorReason =
  | "missing"
  | "incomplete"
  | "organization"
  | "timeout"
  | "api-url"
  | "state"
  | "locked"
  | "local-flag";

/** The dev instance is absent, unreadable, busy, or could not be created or reached. */
export class SparkDevInstanceError extends Data.TaggedError("SparkDevInstanceError")<{
  readonly reason: DevInstanceErrorReason;
  readonly message: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "organization":
        return actionability.provideFlags;
      case "timeout":
        return actionability.externalNetwork;
      case "local-flag":
        return actionability.invalidInput;
      case "locked":
        return { ...actionability.invalidInput, fingerprint_suffix: "lease_held" };
      default:
        return actionability.startStack;
    }
  }
}

const NO_DEV_INSTANCE = "No dev instance for this project. Run `supabase start` to create one.";

const STATE_FILE = "dev-instance.json";
const LOCK_FILE = "dev-instance.lock";

const tempDirectory = Effect.fnUntraced(function* () {
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  return path.join(path.resolve(settings.workdir), "supabase", ".temp");
});

const statePath = Effect.fnUntraced(function* () {
  const path = yield* Path.Path;
  return path.join(yield* tempDirectory(), STATE_FILE);
});

const decodeState = Schema.decodeEffect(Schema.fromJsonString(DevInstanceState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(DevInstanceState));

/** The recorded dev instance, `None` when the file does not exist. */
export const readDevInstanceState = Effect.fn("SparkDevInstance.readState")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* statePath();
  const stateError = (cause: { readonly message: string }) =>
    new SparkDevInstanceError({
      reason: "state",
      message: `${file} is unreadable (${cause.message}). Delete it and run \`supabase start\`.`,
      cause,
    });
  if (!(yield* fs.exists(file).pipe(Effect.mapError(stateError))))
    return Option.none<DevInstanceState>();
  const text = yield* fs.readFileString(file).pipe(Effect.mapError(stateError));
  return Option.some<DevInstanceState>(yield* decodeState(text).pipe(Effect.mapError(stateError)));
});

const sameApi = (left: string, right: string) =>
  left.replace(/\/+$/u, "") === right.replace(/\/+$/u, "");

/**
 * The recorded dev instance, which must exist and belong to the profile's Management API: a
 * different API would not know its ref. It may still be setting up.
 */
export const requireDevInstanceState = Effect.fn("SparkDevInstance.requireState")(function* () {
  const settings = yield* CommandSettings;
  const state = yield* readDevInstanceState();
  if (Option.isNone(state))
    return yield* new SparkDevInstanceError({ reason: "missing", message: NO_DEV_INSTANCE });
  if (!sameApi(state.value.management_api_url, settings.apiUrl))
    return yield* new SparkDevInstanceError({
      reason: "api-url",
      message: `The dev instance ${state.value.ref} was created through ${state.value.management_api_url}, but the profile's Management API is ${settings.apiUrl}. Switch back to that profile, or delete supabase/.temp/dev-instance.json and run \`supabase start\`.`,
    });
  return state.value;
});

/** The recorded dev instance, which `start` must have finished setting up. */
export const requireReadyDevInstanceState = Effect.fn("SparkDevInstance.requireReadyState")(
  function* () {
    const state = yield* requireDevInstanceState();
    if (!isDevInstanceReady(state))
      return yield* new SparkDevInstanceError({
        reason: "incomplete",
        message: `The dev instance ${state.ref} is not set up yet. Run \`supabase start\` to finish setting it up.`,
      });
    return state;
  },
);

/**
 * Publishes the state file atomically with mode `0600`, since it holds the service_role key,
 * after making sure `supabase/.gitignore` ignores `.temp`.
 */
export const writeDevInstanceState = Effect.fn("SparkDevInstance.writeState")(function* (
  state: DevInstanceState,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* CommandSettings;
  const file = yield* statePath();
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* ensureGitignore(fs, path, path.resolve(settings.workdir), [".temp"]);
    yield* publish(fs, path, { target: file, content: `${yield* encodeState(state)}\n` });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SparkDevInstanceError({
          reason: "state",
          message: `failed to write ${file}: ${cause.message}`,
          cause,
        }),
    ),
  );
});

export const removeDevInstanceState = Effect.fn("SparkDevInstance.removeState")(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* statePath(), { force: true });
});

/**
 * Runs `effect` holding the checkout's dev-instance lock (`supabase/.temp/dev-instance.lock`),
 * so two commands cannot create or change the instance at once; a second holder fails at once.
 */
export const withDevInstanceLock = Effect.fn("SparkDevInstance.lock")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* tempDirectory();
  const file = path.join(directory, LOCK_FILE);
  const lockError = (cause: { readonly message: string }) =>
    new SparkDevInstanceError({
      reason: "state",
      message: `failed to take ${file}: ${cause.message}`,
      cause,
    });
  yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(lockError));
  yield* holdLock(file, Duration.zero, `supabase/.temp/${LOCK_FILE}`).pipe(
    Effect.mapError((cause) =>
      isLockBusy(cause)
        ? new SparkDevInstanceError({
            reason: "locked",
            message: `Another supabase command is changing this project's dev instance (it holds supabase/.temp/${LOCK_FILE}). Wait for it to finish, then run this command again.`,
            cause,
          })
        : lockError(cause),
    ),
  );
  return yield* effect;
}, Effect.scoped);

/** The URLs and keys `status` reports and `start` prints. */
const devInstanceReport = (state: ReadyDevInstanceState, status: string) => {
  const base = state.api_url.replace(/\/+$/u, "");
  return {
    name: state.name,
    ref: state.ref,
    status,
    api_url: base,
    rest_url: `${base}/rest/v1`,
    auth_url: `${base}/auth/v1`,
    functions_url: `${base}/functions/v1`,
    anon_key: state.anon_key,
    service_role_key: state.service_role_key,
  };
};

/** The dev instance as the default project of the mainline `functions` and `secrets` commands. */
const devInstanceDefaultProject = requireReadyDevInstanceState().pipe(
  Effect.map((state) => ({ ref: state.ref, name: state.name })),
  Effect.mapError((error) => new ProjectRefNotLinkedError({ message: error.message })),
);

const API_ONLY_DEPLOY =
  "A dev instance takes functions only through the API upload, so --use-docker and --legacy-bundle are not supported in dev-instance mode. Drop the flag: functions deploy uploads through the API by default.";

/**
 * What a mainline hosted command (`functions`, `secrets`) needs in dev-instance mode: with no
 * `--project-ref` or `--remote` it acts on the dev instance, and `functions deploy` uploads
 * through the API and prints each function's URL on the instance.
 */
export const devInstanceHostedLayer = (flags: ProjectTargetFlagValues) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const functionUrl = (projectRef: string, slug: string) =>
        Effect.gen(function* () {
          const settings = yield* Effect.serviceOption(CommandSettings);
          if (Option.isNone(settings)) return Option.none<string>();
          const state = yield* readDevInstanceState().pipe(
            Effect.provideService(CommandSettings, settings.value),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.orElseSucceed(() => Option.none<DevInstanceState>()),
          );
          return Option.flatMap(
            Option.filter(state, isDevInstanceReady),
            (ready): Option.Option<string> =>
              ready.ref === projectRef
                ? Option.some(`${devInstanceReport(ready, "").functions_url}/${slug}`)
                : Option.none(),
          );
        });
      const byDefault = Option.isNone(flags.remote) && Option.isNone(flags.projectRef);
      return Layer.mergeAll(
        Layer.succeed(
          DefaultProjectRef,
          byDefault ? Option.some(devInstanceDefaultProject) : Option.none(),
        ),
        Layer.succeed(
          FunctionsApiDeployMode,
          Option.some({ refusal: API_ONLY_DEPLOY, functionUrl }),
        ),
      );
    }),
  );

/** Prints the dev instance as `status` does: text, `-o json|yaml|toml|env`, `--env`, or a result. */
export const emitDevInstanceStatus = Effect.fn("SparkDevInstance.emitStatus")(function* (
  state: ReadyDevInstanceState,
  status: string,
  options: { readonly env: boolean },
) {
  const output = yield* Output;
  const format = Option.getOrUndefined(yield* OutputFlag);
  const report = devInstanceReport(state, status);
  if (options.env || format === "env") {
    const env = {
      API_URL: report.api_url,
      REST_URL: report.rest_url,
      AUTH_URL: report.auth_url,
      FUNCTIONS_URL: report.functions_url,
      ANON_KEY: report.anon_key,
      SERVICE_ROLE_KEY: report.service_role_key,
    };
    if (format === undefined && output.format !== "text") return yield* output.result(env);
    return yield* output.raw(`${encodeEnv(env)}\n`);
  }
  if (format === "json") return yield* output.raw(encodeSortedJson(report));
  if (format === "yaml") return yield* output.raw(encodeYaml(report));
  if (format === "toml") return yield* output.raw(encodeToml(report));
  if (output.format !== "text") return yield* output.result(report);
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Dev instance", `${report.name} (${report.ref})`],
    ["Status", report.status],
    ["API URL", report.api_url],
    ["REST URL", report.rest_url],
    ["Auth URL", report.auth_url],
    ["Functions URL", report.functions_url],
    ["anon key", report.anon_key],
    ["service_role key", report.service_role_key],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  yield* output.raw(
    `${rows.map(([label, value]) => `${label.padStart(width)}: ${value}`).join("\n")}\n`,
  );
});
