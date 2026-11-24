import { Context, Data, Effect, FileSystem, Option, Path, Schema } from "effect";

import { OutputFlag } from "../../../command-internal/global-flags.ts";
import {
  encodeEnv,
  encodeSortedJson,
  encodeToml,
  encodeYaml,
} from "../../../command-internal/output.encoders.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
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

/** `supabase/.temp/dev-instance.json`: the checkout's dev instance. */
const DevInstanceState = Schema.Struct({
  ref: Schema.String,
  name: Schema.String,
  organization_slug: Schema.String,
  api_url: Schema.String,
  anon_key: Schema.String,
  service_role_key: Schema.String,
  management_api_url: Schema.String,
});
interface DevInstanceState extends Schema.Schema.Type<typeof DevInstanceState> {}

type DevInstanceErrorReason = "missing" | "organization" | "timeout" | "api-url" | "state";

/** The dev instance is absent, unreadable, or could not be created or reached. */
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
      default:
        return actionability.startStack;
    }
  }
}

const NO_DEV_INSTANCE =
  "No dev instance for this project. Run `supabase start` to create one.";

const statePath = Effect.fnUntraced(function* () {
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  return path.join(path.resolve(settings.workdir), "supabase", ".temp", "dev-instance.json");
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
  return Option.some(yield* decodeState(text).pipe(Effect.mapError(stateError)));
});

const sameApi = (left: string, right: string) =>
  left.replace(/\/+$/u, "") === right.replace(/\/+$/u, "");

/**
 * The recorded dev instance, which must exist and belong to the profile's Management API: a
 * different API would not know its ref.
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

/** Writes the state file, readable by its owner only since it holds the service_role key. */
export const writeDevInstanceState = Effect.fn("SparkDevInstance.writeState")(function* (
  state: DevInstanceState,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* statePath();
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${yield* encodeState(state)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created.
  yield* fs.chmod(file, 0o600);
});

export const removeDevInstanceState = Effect.fn("SparkDevInstance.removeState")(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* statePath(), { force: true });
});

/** The URLs and keys `status` reports and `start` prints. */
const devInstanceReport = (state: DevInstanceState, status: string) => {
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

/** Prints the dev instance as `status` does: text, `-o json|yaml|toml|env`, `--env`, or a result. */
export const emitDevInstanceStatus = Effect.fn("SparkDevInstance.emitStatus")(function* (
  state: DevInstanceState,
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
