import { Cause, Config, ConfigProvider, Console, Data, Effect, Exit, Option, Schema } from "effect";
import { dirname, join, STATUS_CODE, STATUS_TEXT, toFileUrl } from "./serve-main-deps.ts";

import * as jose from "jose";

interface DenoErrorConstructors {
  readonly NotFound?: abstract new (...args: never[]) => Error;
  readonly InvalidWorkerCreation?: abstract new (...args: never[]) => Error;
  readonly InvalidWorkerResponse?: abstract new (...args: never[]) => Error;
  readonly WorkerRequestCancelled?: abstract new (...args: never[]) => Error;
}
interface DenoApi {
  readonly env: { get(name: string): string | undefined; toObject(): Record<string, string> };
  readonly errors: DenoErrorConstructors;
  lstat(path: string): Promise<unknown>;
  cwd(): string;
  makeTempDirSync(options: { prefix: string }): string;
  readonly version: { deno: string };
  serve(options: {
    handler: (request: Request) => Promise<Response>;
    onListen: () => void;
    onError: (error: unknown) => Response;
  }): void;
}
interface EdgeRuntimeApi {
  applySupabaseTag(request: Request, forwarded: Request): void;
  getRuntimeMetrics(): Promise<unknown>;
  readonly userWorkers: {
    create(options: WorkerCreateOptions): Promise<{ fetch(request: Request): Promise<Response> }>;
  };
}
interface WorkerCreateOptions {
  readonly servicePath: string;
  readonly memoryLimitMb: number;
  readonly workerTimeoutMs: number;
  readonly noModuleCache: boolean;
  readonly noNpm: boolean;
  readonly importMapPath?: string;
  readonly envVars: ReadonlyArray<readonly [string, string]>;
  readonly forceCreate: boolean;
  readonly customModuleRoot: string;
  readonly cpuTimeSoftLimitMs: number;
  readonly cpuTimeHardLimitMs: number;
  readonly decoratorType: string;
  readonly maybeEntrypoint: string;
  readonly context: { readonly useReadSyncFileAPI: boolean };
  readonly staticPatterns: ReadonlyArray<string>;
}
declare const Deno: DenoApi;
declare const EdgeRuntime: EdgeRuntimeApi;

const bootstrapEnv = Effect.runSync(
  Effect.gen(function* () {
    const read = <A>(config: Config.Config<A>) => config.pipe(Config.option);
    return {
      hostPort: yield* read(Config.string("SUPABASE_INTERNAL_HOST_PORT")),
      jwtSecret: yield* read(Config.string("SUPABASE_INTERNAL_JWT_SECRET")),
      supabaseUrl: yield* read(Config.string("SUPABASE_URL")),
      debug: yield* read(Config.string("SUPABASE_INTERNAL_DEBUG")),
      functionsConfig: yield* read(Config.string("SUPABASE_INTERNAL_FUNCTIONS_CONFIG")),
      jwks: yield* read(Config.string("SUPABASE_JWKS")),
      publishableKey: yield* read(Config.string("SUPABASE_INTERNAL_PUBLISHABLE_KEY")),
      secretKey: yield* read(Config.string("SUPABASE_INTERNAL_SECRET_KEY")),
      wallclock: yield* read(Config.string("SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC")),
    };
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord(Deno.env.toObject(), { preserveEmptyStrings: true }),
    ),
  ),
);
const envValue = (name: keyof typeof bootstrapEnv, fallback = "") =>
  Option.getOrElse(bootstrapEnv[name], () => fallback);
class BootstrapOperationError extends Data.TaggedError("BootstrapOperationError")<{
  readonly cause: unknown;
}> {}
const foreign = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new BootstrapOperationError({ cause }) });

const SB_SPECIFIC_ERROR_CODE = {
  BootError: STATUS_CODE.ServiceUnavailable /** Service Unavailable (RFC 7231, 6.6.4) */,
  InvalidWorkerResponse:
    STATUS_CODE.InternalServerError /** Internal Server Error (RFC 7231, 6.6.1) */,
  WorkerLimit: 546 /** Extended */,
};

const SB_SPECIFIC_ERROR_TEXT = {
  [SB_SPECIFIC_ERROR_CODE.BootError]: "BOOT_ERROR",
  [SB_SPECIFIC_ERROR_CODE.InvalidWorkerResponse]: "WORKER_ERROR",
  [SB_SPECIFIC_ERROR_CODE.WorkerLimit]: "WORKER_LIMIT",
};

const SB_SPECIFIC_ERROR_REASON = {
  [SB_SPECIFIC_ERROR_CODE.BootError]: "Worker failed to boot (please check logs)",
  [SB_SPECIFIC_ERROR_CODE.InvalidWorkerResponse]:
    "Function exited due to an error (please check logs)",
  [SB_SPECIFIC_ERROR_CODE.WorkerLimit]:
    "Worker failed to respond due to a resource limit (please check logs)",
};

// OS stuff - we don't want to expose these to the functions.
const EXCLUDED_ENVS = ["HOME", "HOSTNAME", "PATH", "PWD"];
const HOST_PORT = envValue("hostPort");
const JWT_SECRET = envValue("jwtSecret");
const JWKS_ENDPOINT = new URL("/auth/v1/.well-known/jwks.json", envValue("supabaseUrl"));
const DEBUG = envValue("debug") === "true";
const FUNCTIONS_CONFIG_STRING = envValue("functionsConfig");

const SUPABASE_PUBLISHABLE_KEY = envValue("publishableKey") || undefined;
const SUPABASE_SECRET_KEY = envValue("secretKey") || undefined;

const WALLCLOCK_LIMIT_SEC = parseInt(envValue("wallclock"), 10);

const DENO_SB_ERROR_MAP = new Map([
  [Deno.errors.InvalidWorkerCreation, SB_SPECIFIC_ERROR_CODE.BootError],
  [Deno.errors.InvalidWorkerResponse, SB_SPECIFIC_ERROR_CODE.InvalidWorkerResponse],
  [Deno.errors.WorkerRequestCancelled, SB_SPECIFIC_ERROR_CODE.WorkerLimit],
]);
const GENERIC_FUNCTION_SERVE_MESSAGE = `Serving functions on http://127.0.0.1:${HOST_PORT}/functions/v1/<function-name>`;
export enum RequestErrors {
  MissingAuthHeader = "UNAUTHORIZED_NO_AUTH_HEADER",
  InvalidLegacyJWT = "UNAUTHORIZED_JWT",
  InvalidAsymmetricJWT = "UNAUTHORIZED_ASYMMETRIC_JWT",
  InvalidTokenFormat = "UNAUTHORIZED_INVALID_JWT_FORMAT",
  UnsupportedTokenAlgorithm = "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM",
}

interface AuthFailure {
  code: RequestErrors;
  message?: string;
}

const FunctionConfigSchema = Schema.Struct({
  entrypointPath: Schema.String,
  importMapPath: Schema.optionalKey(Schema.String),
  staticFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  verifyJWT: Schema.Boolean,
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const FunctionsConfigSchema = Schema.Record(Schema.String, FunctionConfigSchema);
const JsonWebKeySetSchema = Schema.declare(
  (value): value is jose.JSONWebKeySet =>
    typeof value === "object" &&
    value !== null &&
    "keys" in value &&
    Array.isArray(value.keys) &&
    value.keys.every((key) => typeof key === "object" && key !== null),
);
type FunctionConfig = Schema.Schema.Type<typeof FunctionConfigSchema>;

function getResponse(payload: unknown, status: number, customHeaders: Record<string, string> = {}) {
  const headers = { ...customHeaders };
  let body: string | null = null;

  if (payload) {
    if (typeof payload === "object") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(payload);
    } else if (typeof payload === "string") {
      headers["Content-Type"] = "text/plain";
      body = payload;
    } else {
      body = null;
    }
  }

  return new Response(body, { status, headers });
}

function getAuthErrorResponse({ code, message = "Invalid JWT" }: AuthFailure) {
  return getResponse(
    {
      code,
      message,
      // DEPRECATED: Retained for backward compatibility.
      msg: message,
    },
    STATUS_CODE.Unauthorized,
    {
      "sb-error-code": code,
      "Access-Control-Expose-Headers": "sb-error-code",
    },
  );
}

function getWorkerErrorResponse(error: unknown) {
  for (const [denoError, sbCode] of DENO_SB_ERROR_MAP.entries()) {
    if (denoError !== undefined && error instanceof denoError) {
      return getResponse(
        {
          code: SB_SPECIFIC_ERROR_TEXT[sbCode],
          message: SB_SPECIFIC_ERROR_REASON[sbCode],
        },
        sbCode,
      );
    }
  }
  return getResponse(
    {
      code: STATUS_TEXT[STATUS_CODE.InternalServerError],
      message: "Request failed due to an internal server error",
    },
    STATUS_CODE.InternalServerError,
  );
}

const functionsConfig = Effect.runSync(
  Schema.decodeEffect(Schema.fromJsonString(FunctionsConfigSchema))(FUNCTIONS_CONFIG_STRING),
);
if (DEBUG) {
  const debugConfig = Object.fromEntries(
    Object.entries(functionsConfig).map(([name, config]) => [
      name,
      Object.fromEntries(Object.entries(config).filter(([key]) => key !== "env")),
    ]),
  );
  Effect.runSync(Console.log("Functions config:", JSON.stringify(debugConfig, null, 2)));
}

// Edge Runtime pools user workers by servicePath. Keep the source directory
// for the common case, but give each function a process-owned temporary
// path when multiple configured functions share that directory, since a
// real function directory can't be reused as a pool key. `maybeEntrypoint`
// still points at the real source file, so module resolution is unchanged.
const workerServicePaths = (() => {
  const sourcePathCounts = new Map<string, number>();
  for (const config of Object.values(functionsConfig)) {
    const sourcePath = dirname(config.entrypointPath);
    sourcePathCounts.set(sourcePath, (sourcePathCounts.get(sourcePath) ?? 0) + 1);
  }

  return Object.fromEntries(
    Object.entries(functionsConfig).map(([functionName, config]) => {
      const sourcePath = dirname(config.entrypointPath);
      const servicePath =
        sourcePathCounts.get(sourcePath) === 1
          ? sourcePath
          : Deno.makeTempDirSync({ prefix: "supabase-worker-" });
      return [functionName, servicePath];
    }),
  );
})();

export function extractBearerToken(rawToken: string) {
  const tokenParts = rawToken.split(" ");
  const [bearer, token] = tokenParts;
  if (bearer !== "Bearer" || tokenParts.length !== 2) {
    return null;
  }

  return token;
}

function getAuthToken(req: Request): string | AuthFailure {
  const authHeader = req.headers.get("authorization");
  const sbApiKeyCompatibilityToken = req.headers.get("sb-api-key");

  // Kong on the CLI stack passes this down as "Bearer Token" format.
  const cleanSbApiKeyCompatibilityToken = sbApiKeyCompatibilityToken?.replace("Bearer", "")?.trim();

  if (!authHeader && !cleanSbApiKeyCompatibilityToken) {
    return {
      code: RequestErrors.MissingAuthHeader,
      message: "Missing authorization header",
    };
  }

  // Compatibility mode triggers when the API proxy mints a temp token and
  // the original bearer is absent or an API key.
  const bearerToken = extractBearerToken(authHeader ?? "");
  const token =
    !bearerToken || bearerToken.startsWith("sb_") ? cleanSbApiKeyCompatibilityToken : bearerToken;

  if (!token) {
    return {
      code: RequestErrors.InvalidTokenFormat,
      message: "Invalid JWT format",
    };
  }

  return token;
}

function isValidLegacyJWT(
  jwtSecret: string,
  jwt: string,
): Effect.Effect<Option.Option<AuthFailure>> {
  return foreign(() => jose.jwtVerify(jwt, new TextEncoder().encode(jwtSecret))).pipe(
    Effect.as(Option.none<AuthFailure>()),
    Effect.tapError((error) => Console.error("Symmetric Legacy JWT verification error", error)),
    Effect.orElseSucceed(() => Option.some({ code: RequestErrors.InvalidLegacyJWT })),
  );
}

// Lazy-loading JWKs
const jwks = Effect.runSync(
  Option.match(bootstrapEnv.jwks, {
    onNone: () => Effect.succeed(Option.none<ReturnType<typeof jose.createLocalJWKSet>>()),
    onSome: (value) =>
      Effect.gen(function* () {
        const keySet = yield* Schema.decodeEffect(Schema.fromJsonString(JsonWebKeySetSchema))(
          value,
        );
        return yield* Effect.try({
          try: () => jose.createLocalJWKSet(keySet),
          catch: (cause) => new BootstrapOperationError({ cause }),
        });
      }).pipe(Effect.option),
  }),
);
const selectedJwks = Option.getOrElse(jwks, () => jose.createRemoteJWKSet(JWKS_ENDPOINT));

function isValidJWT(jwt: string): Effect.Effect<Option.Option<AuthFailure>> {
  return foreign(() => jose.jwtVerify(jwt, selectedJwks)).pipe(
    Effect.as(Option.none<AuthFailure>()),
    Effect.tapError((error) => Console.error("Asymmetric JWT verification error", error)),
    Effect.orElseSucceed(() => Option.some({ code: RequestErrors.InvalidAsymmetricJWT })),
  );
}

/**
 * Applies hybrid JWT verification, using JWK as primary and Legacy Secret as fallback.
 * Use only during 'New JWT Keys' migration period, while `JWT_SECRET` is still available.
 */
export function verifyHybridJWT(
  jwtSecret: string,
  jwksUrl: URL,
  jwt: string,
): Effect.Effect<Option.Option<AuthFailure>> {
  const jwtAlgorithm = Effect.try({
    try: () => jose.decodeProtectedHeader(jwt).alg,
    catch: (cause) => new BootstrapOperationError({ cause }),
  });
  return Effect.gen(function* () {
    const algorithm = yield* jwtAlgorithm;
    if (!algorithm)
      return Option.some({ code: RequestErrors.InvalidTokenFormat, message: "Invalid JWT format" });

    if (algorithm === "HS256") {
      yield* Console.log(`Legacy token type detected, attempting ${algorithm} verification.`);

      return yield* isValidLegacyJWT(jwtSecret, jwt);
    }

    if (algorithm === "ES256" || algorithm === "RS256") {
      return yield* isValidJWT(jwt);
    }

    return Option.some({
      code: RequestErrors.UnsupportedTokenAlgorithm,
      message: `Unsupported JWT algorithm ${algorithm}`,
    });
  }).pipe(
    Effect.catchTag("BootstrapOperationError", () =>
      Effect.succeed(
        Option.some({ code: RequestErrors.InvalidTokenFormat, message: "Invalid JWT format" }),
      ),
    ),
  );
}

// Ref: https://docs.deno.com/examples/checking_file_existence/
function shouldUsePackageJsonDiscovery({
  entrypointPath,
  importMapPath,
}: FunctionConfig): Effect.Effect<boolean> {
  if (importMapPath) {
    return Effect.succeed(false);
  }
  const packageJsonPath = join(dirname(entrypointPath), "package.json");
  const notFound = Deno.errors.NotFound;
  return foreign(() => Deno.lstat(packageJsonPath)).pipe(
    Effect.as(true),
    Effect.catchTag("BootstrapOperationError", ({ cause }) =>
      Effect.succeed(notFound !== undefined && cause instanceof notFound ? false : true),
    ),
  );
}

export function prepareUserRequest(req: Request): Request {
  const clonedURL = new URL(req.url);
  const forwardedHost = req.headers.get("x-forwarded-host");
  clonedURL.hostname = forwardedHost ?? clonedURL.hostname;
  // Cloning tees the body, so an unread branch can stall early worker responses.
  const forwardedReq = new Request(clonedURL.href, req);

  forwardedReq.headers.delete("sb-api-key");
  EdgeRuntime.applySupabaseTag(req, forwardedReq);

  return forwardedReq;
}

Deno.serve({
  handler: (req: Request) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const url = new URL(req.url);
        const { pathname } = url;

        if (pathname === "/_internal/health") {
          return getResponse({ message: "ok" }, STATUS_CODE.OK);
        }

        if (pathname === "/_internal/metric") {
          const metric = yield* foreign(() => EdgeRuntime.getRuntimeMetrics());
          return Response.json(metric);
        }

        const pathParts = pathname.split("/");
        const functionName = pathParts[1];

        const functionConfig =
          functionName === undefined ? undefined : functionsConfig[functionName];
        if (!functionName || functionConfig === undefined) {
          return getResponse("Function not found", STATUS_CODE.NotFound);
        }

        if (req.method !== "OPTIONS" && functionConfig.verifyJWT) {
          const token = getAuthToken(req);
          if (typeof token !== "string") {
            return getAuthErrorResponse(token);
          }
          const authFailure = yield* verifyHybridJWT(JWT_SECRET, JWKS_ENDPOINT, token);
          if (Option.isSome(authFailure)) {
            return getAuthErrorResponse(authFailure.value);
          }
        }

        const servicePath = workerServicePaths[functionName];
        if (servicePath === undefined) {
          return getResponse(
            {
              code: STATUS_TEXT[STATUS_CODE.InternalServerError],
              message: "Request failed due to an internal server error",
            },
            STATUS_CODE.InternalServerError,
          );
        }
        yield* Console.error(`serving the request with ${servicePath}`);

        // Ref: https://supabase.com/docs/guides/functions/limits
        const memoryLimitMb = 256;
        const workerTimeoutMs = isFinite(WALLCLOCK_LIMIT_SEC)
          ? WALLCLOCK_LIMIT_SEC * 1000
          : 400 * 1000;
        const noModuleCache = false;
        const envVarsObj: Record<string, string> = {
          ...Deno.env.toObject(),
          ...Object.fromEntries(
            Object.entries(functionConfig.env ?? {}).filter(
              ([name]) => !name.startsWith("SUPABASE_"),
            ),
          ),
          // Listed after the spreads so neither the container env nor function config can shadow it
          SUPABASE_FUNCTION_SLUG: functionName,
        };
        if (SUPABASE_PUBLISHABLE_KEY) {
          envVarsObj.SUPABASE_PUBLISHABLE_KEYS = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )({ default: SUPABASE_PUBLISHABLE_KEY });
        }
        if (SUPABASE_SECRET_KEY) {
          envVarsObj.SUPABASE_SECRET_KEYS = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )({ default: SUPABASE_SECRET_KEY });
        }

        const envVars = Object.entries(envVarsObj).filter(
          ([name]) => !EXCLUDED_ENVS.includes(name) && !name.startsWith("SUPABASE_INTERNAL_"),
        );

        const forceCreate = false;
        const customModuleRoot = ""; // empty string to allow any local path
        const cpuTimeSoftLimitMs = 1000;
        const cpuTimeHardLimitMs = 2000;

        // Kept as "tc39" for Deno 1 compatibility.
        const decoratorType = "tc39";

        const absEntrypoint = join(Deno.cwd(), functionConfig.entrypointPath);
        const maybeEntrypoint = toFileUrl(absEntrypoint).href;
        const usePackageJson = yield* shouldUsePackageJsonDiscovery(functionConfig);

        const workerRequest = Effect.gen(function* () {
          const worker = yield* foreign(() =>
            EdgeRuntime.userWorkers.create({
              servicePath,
              memoryLimitMb,
              workerTimeoutMs,
              noModuleCache,
              noNpm: !usePackageJson,
              importMapPath: functionConfig.importMapPath,
              envVars,
              forceCreate,
              customModuleRoot,
              cpuTimeSoftLimitMs,
              cpuTimeHardLimitMs,
              decoratorType,
              maybeEntrypoint,
              context: {
                useReadSyncFileAPI: true,
              },
              staticPatterns: functionConfig.staticFiles ?? [],
            }),
          );

          const userReq = prepareUserRequest(req);
          return yield* foreign(() => worker.fetch(userReq));
        });

        return yield* workerRequest.pipe(
          Effect.catchTag("BootstrapOperationError", ({ cause }) =>
            Console.error("[functions] worker error", cause).pipe(
              Effect.andThen(Effect.succeed(getWorkerErrorResponse(cause))),
            ),
          ),
        );
      }),
      { signal: req.signal },
    ).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      if (req.signal.aborted && Cause.hasInterruptsOnly(exit.cause))
        return new Response(null, { status: 499 });
      throw Cause.squash(exit.cause);
    }),

  onListen: () => {
    const MAX_FUNCTIONS_URL_EXAMPLES = 5;
    const functionNames = Object.keys(functionsConfig);
    const exampleFunctions = functionNames.slice(0, MAX_FUNCTIONS_URL_EXAMPLES);
    const functionsUrls = exampleFunctions.map(
      (fname) => ` - http://127.0.0.1:${HOST_PORT}/functions/v1/${fname}`,
    );
    const functionsExamplesMessages =
      functionNames.length > 0
        ? `\n${functionsUrls.join(`\n`)}${
            functionNames.length > MAX_FUNCTIONS_URL_EXAMPLES
              ? `\n... and ${functionNames.length - MAX_FUNCTIONS_URL_EXAMPLES} more functions`
              : ""
          }`
        : "";
    Effect.runSync(
      Console.log(
        `${GENERIC_FUNCTION_SERVE_MESSAGE}${functionsExamplesMessages}\nUsing ${Deno.version.deno}`,
      ),
    );
  },

  onError: (e) => {
    Effect.runSync(Console.error(e));
    return getResponse(
      {
        code: STATUS_TEXT[STATUS_CODE.InternalServerError],
        message: "Request failed due to an internal server error",
      },
      STATUS_CODE.InternalServerError,
    );
  },
});
