import { Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { credentialsLayer } from "../../auth/credentials.layer.ts";
import { platformApiLayer } from "../../auth/platform-api.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { resolvePlatformOperationDescriptor } from "./platform-route-resolver.ts";
import { runPlatformOperation } from "./platform-handler.ts";
import { PlatformMethodSelectionError, PlatformRouteNotFoundError } from "./platform.errors.ts";
import type { PlatformHttpMethod } from "./platform-types.ts";

const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

const config = {
  route: Argument.string("route").pipe(
    Argument.withDescription("API route template, for example /v1/projects/{ref}/config/auth."),
  ),
  method: Flag.choice("method", API_METHODS).pipe(
    Flag.withDescription("HTTP method to execute for routes that support multiple operations."),
    Flag.optional,
  ),
  params: Flag.string("params").pipe(
    Flag.withDescription("Non-body request input as inline JSON, or - for stdin"),
    Flag.optional,
  ),
  json: Flag.string("json").pipe(
    Flag.withDescription("Object-shaped request body as inline JSON, or - for stdin"),
    Flag.optional,
  ),
  body: Flag.string("body").pipe(
    Flag.withDescription("Request body as inline non-object content, or - for stdin"),
    Flag.optional,
  ),
  bodyFile: Flag.string("body-file").pipe(
    Flag.withDescription("Read the raw request body from a file"),
    Flag.optional,
  ),
  upload: Flag.string("upload").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Multipart binary field input as field=path or field=-. Repeat for array-valued fields.",
    ),
    Flag.withDefault([] as ReadonlyArray<string>),
  ),
  fields: Flag.string("fields").pipe(
    Flag.withDescription("Comma-separated response field paths to keep in the output"),
    Flag.optional,
  ),
  schema: Flag.boolean("schema").pipe(
    Flag.withDescription(
      "Show the request and response schema for this route instead of executing it",
    ),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Validate and preview the outgoing request without executing it"),
  ),
  yes: Flag.boolean("yes").pipe(
    Flag.withDescription("Skip the confirmation prompt for this mutating request"),
  ),
} as const;

const requestPlatformApiLayer = platformApiLayer.pipe(Layer.provide(credentialsLayer));
const requestRuntimeLayer = Layer.mergeAll(
  requestPlatformApiLayer,
  stdinLayer,
  commandRuntimeLayer(["api", "request"]),
);

function resolveDescriptor(route: string, method: Option.Option<PlatformHttpMethod>) {
  const descriptor = resolvePlatformOperationDescriptor(
    route,
    Option.isSome(method) ? method.value : undefined,
  );
  if (
    descriptor instanceof PlatformRouteNotFoundError ||
    descriptor instanceof PlatformMethodSelectionError
  ) {
    return descriptor;
  }
  return descriptor;
}

export const apiRequestCommand = Command.make("request", config).pipe(
  Command.withDescription(
    "Inspect or run one Management API route.\n\n" +
      "Use `supabase api routes` to browse available routes first. " +
      "Use `--schema` to inspect the request and response shape before running a route. " +
      "If a route supports multiple methods, use `--method` to choose one.",
  ),
  Command.withShortDescription("Inspect or run one API route"),
  Command.withExamples([
    {
      command:
        'supabase api request /v1/projects/{ref}/config/auth --params \'{"ref":"project-ref"}\' --schema',
      description: "Inspect a route before running it",
    },
    {
      command: "supabase api request /v1/projects",
      description: "List projects using the default GET operation",
    },
    {
      command:
        'supabase api request /v1/projects --method POST --json \'{"db_pass":"<redacted>","name":"example-name","organization_slug":"my-org"}\'',
      description: "Create a project by calling the POST operation for /v1/projects",
    },
  ]),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resolved = resolveDescriptor(flags.route, flags.method);
      if (
        resolved instanceof PlatformRouteNotFoundError ||
        resolved instanceof PlatformMethodSelectionError
      ) {
        return yield* Effect.fail(resolved);
      }

      return yield* runPlatformOperation({ descriptor: resolved })({
        params: flags.params,
        json: flags.json,
        body: flags.body,
        bodyFile: flags.bodyFile,
        upload: flags.upload,
        fields: flags.fields,
        schema: flags.schema,
        dryRun: flags.dryRun,
        yes: flags.yes,
      });
    }).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(requestRuntimeLayer),
);
