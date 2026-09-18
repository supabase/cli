import { Config, ConfigProvider, Console, Data, Effect, Option, Schema, Stream } from "effect";

interface DenoErrorConstructors {
  readonly InvalidWorkerCreation?: abstract new (...args: never[]) => Error;
  readonly InvalidWorkerResponse?: abstract new (...args: never[]) => Error;
  readonly WorkerRequestCancelled?: abstract new (...args: never[]) => Error;
}
interface DenoApi {
  readonly env: { get(name: string): string | undefined; toObject(): Record<string, string> };
  readonly errors: DenoErrorConstructors;
  lstat(path: string): Promise<{ isDirectory: boolean; isFile: boolean; isSymlink: boolean }>;
  realPath(path: string): Promise<string>;
  readDir(path: string): AsyncIterable<{ name: string }>;
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

import { STATUS_CODE, STATUS_TEXT, toFileUrl } from "./serve-main-deps.ts";
import {
  createWorkerServicePathResolver,
  packageJsonContainedFor,
  resolveFunctionConfig,
  type FunctionConfig,
  type FunctionFileSystem,
  FunctionFileSystemError,
  type FunctionOverrides,
} from "./serve-main-resolver.ts";
import * as jose from "jose";

const EXCLUDED_ENVS = new Set(["HOME", "HOSTNAME", "PATH", "PWD"]);
const bootstrapConfig = Effect.runSync(
  Effect.gen(function* () {
    const read = <A>(config: Config.Config<A>) => config.pipe(Config.option);
    return {
      hostPort: yield* read(Config.string("SUPABASE_INTERNAL_HOST_PORT")),
      functionsRoot: yield* read(Config.string("SUPABASE_INTERNAL_FUNCTIONS_ROOT")),
      jwtSecret: yield* read(Config.string("SUPABASE_INTERNAL_JWT_SECRET")),
      supabaseUrl: yield* read(Config.string("SUPABASE_URL")),
      wallclock: yield* read(Config.string("SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC")),
      publishableKey: yield* read(Config.string("SUPABASE_INTERNAL_PUBLISHABLE_KEY")),
      secretKey: yield* read(Config.string("SUPABASE_INTERNAL_SECRET_KEY")),
      functionsConfig: yield* read(Config.string("SUPABASE_INTERNAL_FUNCTIONS_CONFIG")),
      debug: yield* read(Config.string("SUPABASE_INTERNAL_DEBUG")),
      jwks: yield* read(Config.string("SUPABASE_JWKS")),
    };
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord(Deno.env.toObject(), { preserveEmptyStrings: true }),
    ),
  ),
);
const valueOr = (value: Option.Option<string>, fallback = "") =>
  Option.getOrElse(value, () => fallback);
const HOST_PORT = valueOr(bootstrapConfig.hostPort, "8081");
const FUNCTIONS_ROOT = valueOr(bootstrapConfig.functionsRoot);
const JWT_SECRET = valueOr(bootstrapConfig.jwtSecret);
const SUPABASE_URL = valueOr(bootstrapConfig.supabaseUrl, "http://127.0.0.1:54321");
const JWKS_ENDPOINT = new URL("/auth/v1/.well-known/jwks.json", SUPABASE_URL);
const WALLCLOCK_LIMIT_SEC = Number.parseInt(valueOr(bootstrapConfig.wallclock, "400"), 10);
const SUPABASE_PUBLISHABLE_KEY = Option.getOrUndefined(bootstrapConfig.publishableKey);
const SUPABASE_SECRET_KEY = Option.getOrUndefined(bootstrapConfig.secretKey);

const SB_SPECIFIC_ERROR_CODE = {
  BootError: STATUS_CODE.ServiceUnavailable,
  InvalidWorkerResponse: STATUS_CODE.InternalServerError,
  WorkerLimit: 546,
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
const DENO_SB_ERROR_MAP = new Map([
  [Deno.errors.InvalidWorkerCreation, SB_SPECIFIC_ERROR_CODE.BootError],
  [Deno.errors.InvalidWorkerResponse, SB_SPECIFIC_ERROR_CODE.InvalidWorkerResponse],
  [Deno.errors.WorkerRequestCancelled, SB_SPECIFIC_ERROR_CODE.WorkerLimit],
]);

export enum RequestErrors {
  MissingAuthHeader = "UNAUTHORIZED_NO_AUTH_HEADER",
  InvalidLegacyJWT = "UNAUTHORIZED_JWT",
  InvalidAsymmetricJWT = "UNAUTHORIZED_ASYMMETRIC_JWT",
  InvalidTokenFormat = "UNAUTHORIZED_INVALID_JWT_FORMAT",
  UnsupportedTokenAlgorithm = "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM",
}

interface AuthFailure {
  readonly code: RequestErrors;
  readonly message?: string;
}

const FunctionOverrideSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  verifyJWT: Schema.optionalKey(Schema.Boolean),
  entrypointPath: Schema.optionalKey(Schema.String),
  importMapPath: Schema.optionalKey(Schema.String),
  importMapRoot: Schema.optionalKey(Schema.String),
  staticFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const FunctionOverridesSchema = Schema.Record(Schema.String, FunctionOverrideSchema);
const JsonWebKeySetSchema = Schema.declare(
  (value): value is jose.JSONWebKeySet =>
    typeof value === "object" &&
    value !== null &&
    "keys" in value &&
    Array.isArray(value.keys) &&
    value.keys.every((key) => typeof key === "object" && key !== null),
);
const parseConfig = (): FunctionOverrides =>
  Option.match(bootstrapConfig.functionsConfig, {
    onNone: () => ({}),
    onSome: (raw) =>
      Effect.runSync(
        Schema.decodeEffect(Schema.fromJsonString(FunctionOverridesSchema))(raw).pipe(
          Effect.orElseSucceed(() => ({})),
        ),
      ),
  });
const configured: FunctionOverrides = parseConfig();
if (Option.getOrUndefined(bootstrapConfig.debug) === "true") {
  const debugConfig = Object.fromEntries(
    Object.entries(configured).map(([name, config]) => [
      name,
      Object.fromEntries(Object.entries(config).filter(([key]) => key !== "env")),
    ]),
  );
  Effect.runSync(Console.log("Functions config:", JSON.stringify(debugConfig, null, 2)));
}

const getResponse = (
  payload: unknown,
  status: number,
  customHeaders: Record<string, string> = {},
) => {
  const headers = { ...customHeaders };
  let body: string | null = null;
  if (payload !== undefined && payload !== null) {
    if (typeof payload === "object") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(payload);
    } else {
      headers["Content-Type"] = "text/plain";
      body = typeof payload === "string" ? payload : (JSON.stringify(payload) ?? null);
    }
  }
  return new Response(body, { status, headers });
};

const getAuthErrorResponse = ({ code, message = "Invalid JWT" }: AuthFailure) =>
  getResponse({ code, message, msg: message }, STATUS_CODE.Unauthorized, {
    "sb-error-code": code,
    "Access-Control-Expose-Headers": "sb-error-code",
  });

const getWorkerErrorResponse = (error: unknown) => {
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
};

export function extractBearerToken(rawToken: string) {
  const parts = rawToken.split(" ");
  return parts.length === 2 && parts[0] === "Bearer" ? parts[1] : null;
}

const getAuthToken = (request: Request): string | AuthFailure => {
  const authHeader = request.headers.get("authorization");
  const compatibility = request.headers.get("sb-api-key")?.replace("Bearer", "").trim();
  if (!authHeader && !compatibility)
    return { code: RequestErrors.MissingAuthHeader, message: "Missing authorization header" };
  const bearer = extractBearerToken(authHeader ?? "");
  const token = !bearer || bearer.startsWith("sb_") ? compatibility : bearer;
  return token ? token : { code: RequestErrors.InvalidTokenFormat, message: "Invalid JWT format" };
};

class BootstrapOperationError extends Data.TaggedError("BootstrapOperationError")<{
  readonly cause: unknown;
}> {}

const localJwks = Effect.runSync(
  Option.match(bootstrapConfig.jwks, {
    onNone: () =>
      Effect.succeed(
        Option.some<ReturnType<typeof jose.createLocalJWKSet>>(
          jose.createLocalJWKSet({ keys: [] }),
        ),
      ),
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
const selectedJwks = Option.getOrElse(localJwks, () => jose.createRemoteJWKSet(JWKS_ENDPOINT));
const foreign = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new BootstrapOperationError({ cause }),
  });
const isValidAsymmetricJWT = (jwt: string): Effect.Effect<Option.Option<AuthFailure>> =>
  Effect.gen(function* () {
    yield* foreign(() => jose.jwtVerify(jwt, selectedJwks));
    return Option.none<AuthFailure>();
  }).pipe(Effect.orElseSucceed(() => Option.some({ code: RequestErrors.InvalidAsymmetricJWT })));

function verifyHybridJWT(
  jwtSecret: string,
  jwt: string,
): Effect.Effect<Option.Option<AuthFailure>> {
  return Effect.gen(function* () {
    const algorithm = yield* Effect.try({
      try: () => jose.decodeProtectedHeader(jwt).alg,
      catch: (cause) => new BootstrapOperationError({ cause }),
    });
    if (!algorithm)
      return Option.some({ code: RequestErrors.InvalidTokenFormat, message: "Invalid JWT format" });
    if (algorithm === "HS256")
      return yield* foreign(() => jose.jwtVerify(jwt, new TextEncoder().encode(jwtSecret))).pipe(
        Effect.as(Option.none<AuthFailure>()),
        Effect.orElseSucceed(() => Option.some({ code: RequestErrors.InvalidLegacyJWT })),
      );
    if (algorithm === "ES256" || algorithm === "RS256") return yield* isValidAsymmetricJWT(jwt);
    return Option.some({
      code: RequestErrors.UnsupportedTokenAlgorithm,
      message: `Unsupported JWT algorithm ${algorithm}`,
    });
  }).pipe(
    Effect.orElseSucceed(() =>
      Option.some({
        code: RequestErrors.InvalidTokenFormat,
        message: "Invalid JWT format",
      }),
    ),
  );
}

const denoFileSystem: FunctionFileSystem = {
  lstat: (path) =>
    foreign(() => Deno.lstat(path)).pipe(
      Effect.mapError((cause) => new FunctionFileSystemError({ cause })),
      Effect.map((info) => ({
        isDirectory: info.isDirectory,
        isFile: info.isFile,
        isSymbolicLink: info.isSymlink,
      })),
    ),
  realPath: (path) =>
    foreign(() => Deno.realPath(path)).pipe(
      Effect.mapError((cause) => new FunctionFileSystemError({ cause })),
    ),
  readDirectory: (path) =>
    Stream.fromAsyncIterable(
      Deno.readDir(path),
      (cause) => new BootstrapOperationError({ cause }),
    ).pipe(
      Stream.map((entry) => entry.name),
      Stream.runCollect,
      Effect.mapError((cause) => new FunctionFileSystemError({ cause })),
    ),
};

const functionConfig = (slug: string): Effect.Effect<FunctionConfig | undefined> =>
  resolveFunctionConfig({ root: FUNCTIONS_ROOT, slug, overrides: configured, fs: denoFileSystem });
const workerServicePath = createWorkerServicePathResolver(() =>
  Deno.makeTempDirSync({ prefix: "supabase-worker-" }),
);

const shouldUsePackageJsonDiscovery = (config: FunctionConfig): Effect.Effect<boolean> =>
  config.importMapPath
    ? Effect.succeed(false)
    : packageJsonContainedFor({ root: FUNCTIONS_ROOT, config, fs: denoFileSystem });

export function prepareUserRequest(request: Request): Request {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) url.hostname = forwardedHost;
  // Cloning tees the body, so an unread branch can stall early worker responses.
  const forwarded = new Request(url.href, request);
  forwarded.headers.delete("sb-api-key");
  EdgeRuntime.applySupabaseTag(request, forwarded);
  return forwarded;
}

const requestEffect = (request: Request) =>
  Effect.gen(function* () {
    const { pathname } = new URL(request.url);
    if (pathname === "/_internal/health") return getResponse({ message: "ok" }, STATUS_CODE.OK);
    if (pathname === "/_internal/metric")
      return Response.json(yield* foreign(() => EdgeRuntime.getRuntimeMetrics()));
    const functionName = pathname.split("/")[1];
    if (!functionName) return getResponse("Function not found", STATUS_CODE.NotFound);
    const config = yield* functionConfig(functionName);
    if (!config) return getResponse("Function not found", STATUS_CODE.NotFound);
    if (request.method !== "OPTIONS" && config.verifyJWT) {
      const token = getAuthToken(request);
      if (typeof token !== "string") return getAuthErrorResponse(token);
      const authFailure = yield* verifyHybridJWT(JWT_SECRET, token);
      if (Option.isSome(authFailure)) return getAuthErrorResponse(authFailure.value);
    }
    const envVarsObj: Record<string, string> = {
      ...Deno.env.toObject(),
      ...Object.fromEntries(
        Object.entries(config.env ?? {}).filter(([name]) => !name.startsWith("SUPABASE_")),
      ),
      SUPABASE_FUNCTION_SLUG: functionName,
    };
    if (SUPABASE_PUBLISHABLE_KEY)
      envVarsObj.SUPABASE_PUBLISHABLE_KEYS = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )({ default: SUPABASE_PUBLISHABLE_KEY });
    if (SUPABASE_SECRET_KEY)
      envVarsObj.SUPABASE_SECRET_KEYS = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )({ default: SUPABASE_SECRET_KEY });
    const envVars = Object.entries(envVarsObj).filter(
      ([name]) => !EXCLUDED_ENVS.has(name) && !name.startsWith("SUPABASE_INTERNAL_"),
    );
    const noNpm = !(yield* shouldUsePackageJsonDiscovery(config));
    const workerRequest = Effect.gen(function* () {
      const worker = yield* foreign(() =>
        EdgeRuntime.userWorkers.create({
          servicePath: workerServicePath(functionName, config),
          memoryLimitMb: 256,
          workerTimeoutMs: Number.isFinite(WALLCLOCK_LIMIT_SEC)
            ? WALLCLOCK_LIMIT_SEC * 1000
            : 400_000,
          noModuleCache: true,
          noNpm,
          importMapPath: config.importMapPath,
          envVars,
          forceCreate: true,
          customModuleRoot: "",
          cpuTimeSoftLimitMs: 1000,
          cpuTimeHardLimitMs: 2000,
          decoratorType: "tc39",
          maybeEntrypoint: toFileUrl(config.entrypointPath).href,
          context: { useReadSyncFileAPI: true },
          staticPatterns: config.staticFiles,
        }),
      );
      return yield* foreign(() => worker.fetch(prepareUserRequest(request)));
    });
    return yield* workerRequest.pipe(
      Effect.catchTag("BootstrapOperationError", ({ cause }) =>
        Console.error("[functions] worker error", cause).pipe(
          Effect.andThen(Effect.succeed(getWorkerErrorResponse(cause))),
        ),
      ),
    );
  });

class RequestCancelled extends Data.TaggedError("RequestCancelled") {}

const requestCancellation = (request: Request) =>
  Effect.callback<never, RequestCancelled>((resume) => {
    const abort = () => resume(Effect.fail(new RequestCancelled()));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => request.signal.removeEventListener("abort", abort));
  });

const handleRequest = (request: Request) =>
  Effect.raceFirst(requestCancellation(request), requestEffect(request)).pipe(
    Effect.catchTag("RequestCancelled", () => Effect.succeed(new Response(null, { status: 499 }))),
  );

Deno.serve({
  handler: (request: Request) => Effect.runPromise(handleRequest(request)),
  onListen: () => {
    const names = Object.keys(configured);
    const examples = names
      .slice(0, 5)
      .map((name) => ` - http://127.0.0.1:${HOST_PORT}/functions/v1/${name}`);
    Effect.runSync(
      Console.log(
        `Serving functions on http://127.0.0.1:${HOST_PORT}/functions/v1/<function-name>${examples.length ? `\n${examples.join("\n")}` : ""}\nUsing ${Deno.version.deno}`,
      ),
    );
  },
  onError: () =>
    getResponse(
      {
        code: STATUS_TEXT[500],
        message: "Request failed due to an internal server error",
      },
      500,
    ),
});
