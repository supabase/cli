// oxlint-disable effecttsgo/async-function, effecttsgo/global-console -- This file is emitted as raw Deno source and must remain dependency-free at the runtime boundary.
declare const Deno: any;

interface EdgeRuntimeWorker {
  fetch(request: Request): Promise<Response>;
}

interface EdgeRuntimeApi {
  applySupabaseTag(request: Request, clonedRequest: Request): void;
  getRuntimeMetrics(): Promise<unknown>;
  userWorkers: {
    create(options: Readonly<Record<string, unknown>>): Promise<EdgeRuntimeWorker>;
  };
}

declare const EdgeRuntime: EdgeRuntimeApi;

import { dirname, join, STATUS_CODE, STATUS_TEXT, toFileUrl } from "./serve-main-deps.ts";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as jose from "jose";

class ServeRuntimeError extends Data.TaggedError("ServeRuntimeError")<{
  readonly cause: unknown;
}> {}

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function log(...values: ReadonlyArray<unknown>) {
  console.log(...values);
}

function logError(...values: ReadonlyArray<unknown>) {
  console.error(...values);
}

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
const HOST_PORT = Deno.env.get("SUPABASE_INTERNAL_HOST_PORT")!;
const JWT_SECRET = Deno.env.get("SUPABASE_INTERNAL_JWT_SECRET")!;
const JWKS_ENDPOINT = new URL("/auth/v1/.well-known/jwks.json", Deno.env.get("SUPABASE_URL")!);
const DEBUG = Deno.env.get("SUPABASE_INTERNAL_DEBUG") === "true";
const FUNCTIONS_CONFIG_STRING = Deno.env.get("SUPABASE_INTERNAL_FUNCTIONS_CONFIG")!;

const SUPABASE_PUBLISHABLE_KEY = Deno.env.get("SUPABASE_INTERNAL_PUBLISHABLE_KEY");
const SUPABASE_SECRET_KEY = Deno.env.get("SUPABASE_INTERNAL_SECRET_KEY");

const WALLCLOCK_LIMIT_SEC = parseInt(Deno.env.get("SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC"));

const DENO_SB_ERROR_MAP = new Map([
  [Deno.errors.InvalidWorkerCreation, SB_SPECIFIC_ERROR_CODE.BootError],
  [Deno.errors.InvalidWorkerResponse, SB_SPECIFIC_ERROR_CODE.InvalidWorkerResponse],
  [Deno.errors.WorkerRequestCancelled, SB_SPECIFIC_ERROR_CODE.WorkerLimit],
]);
const GENERIC_FUNCTION_SERVE_MESSAGE = `Serving functions on http://127.0.0.1:${HOST_PORT}/functions/v1/<function-name>`;
export enum RequestErrors {
  MissingAuthHeader = "UNAUTHORIZED_NO_AUTH_HEADER",
  InvalidLegacyJWT = "UNAUTHORIZED_LEGACY_JWT",
  InvalidAsymmetricJWT = "UNAUTHORIZED_ASYMMETRIC_JWT",
  InvalidTokenFormat = "UNAUTHORIZED_INVALID_JWT_FORMAT",
  UnsupportedTokenAlgorithm = "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM",
}

interface AuthFailure {
  code: RequestErrors;
  message?: string;
}

interface FunctionConfig {
  entrypointPath: string;
  importMapPath?: string;
  staticFiles?: string[];
  verifyJWT: boolean;
  env?: Record<string, string>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isFunctionConfig(value: unknown): value is FunctionConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entrypointPath = Reflect.get(value, "entrypointPath");
  const importMapPath = Reflect.get(value, "importMapPath");
  const staticFiles = Reflect.get(value, "staticFiles");
  const verifyJWT = Reflect.get(value, "verifyJWT");
  const env = Reflect.get(value, "env");
  return (
    typeof entrypointPath === "string" &&
    (importMapPath === undefined || typeof importMapPath === "string") &&
    (staticFiles === undefined ||
      (Array.isArray(staticFiles) && staticFiles.every((path) => typeof path === "string"))) &&
    typeof verifyJWT === "boolean" &&
    (env === undefined || isStringRecord(env))
  );
}

function isFunctionsConfig(value: unknown): value is Record<string, FunctionConfig> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isFunctionConfig)
  );
}

function getResponse(payload: unknown, status: number, customHeaders: Record<string, string> = {}) {
  const headers = { ...customHeaders };
  let body: string | null = null;

  if (payload) {
    if (typeof payload === "object") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(payload) ?? null;
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

const functionsConfig: Record<string, FunctionConfig> = (() => {
  try {
    const parsedConfig: unknown = JSON.parse(FUNCTIONS_CONFIG_STRING);
    if (!isFunctionsConfig(parsedConfig)) {
      throw new Error("functions config has an invalid shape");
    }

    if (DEBUG) {
      const debugConfig = Object.fromEntries(
        Object.entries(parsedConfig).map(([name, config]) => [
          name,
          Object.fromEntries(Object.entries(config).filter(([key]) => key !== "env")),
        ]),
      );
      log("Functions config:", JSON.stringify(debugConfig, null, 2));
    }

    return parsedConfig;
  } catch (cause) {
    throw new Error("Failed to parse functions config", { cause });
  }
})();

/* --- JWT verification --- */
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

  // NOTE:(kallebysantos) Kong on legacy CLI stack pass it down as 'Bearer Token' format
  const cleanSbApiKeyCompatibilityToken = sbApiKeyCompatibilityToken?.replace("Bearer", "")?.trim();

  if (!authHeader && !cleanSbApiKeyCompatibilityToken) {
    return {
      code: RequestErrors.MissingAuthHeader,
      message: "Missing authorization header",
    };
  }

  // NOTE:(kallebysantos) Compatibility mode is triggered when all conditions match:
  // - API proxy mints a temp token
  // - Original bearer is not present or is ApiKey
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

function isValidLegacyJWT(jwtSecret: string, jwt: string): Effect.Effect<AuthFailure | null> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(jwtSecret);
  return Effect.tryPromise({
    try: () => jose.jwtVerify(jwt, secretKey),
    catch: (error) => new ServeRuntimeError({ cause: error }),
  }).pipe(
    Effect.as<AuthFailure | null>(null),
    Effect.catch((error) =>
      Effect.sync(() => {
        const details = describeRuntimeError(error);
        logError("Symmetric Legacy JWT verification error", details.message, details.trace ?? "");
        return { code: RequestErrors.InvalidLegacyJWT };
      }),
    ),
  );
}

function isJsonWebKeySet(value: unknown): value is jose.JSONWebKeySet {
  const keys = typeof value === "object" && value !== null ? Reflect.get(value, "keys") : undefined;
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray(keys) &&
    keys.every((key) => typeof key === "object" && key !== null && !Array.isArray(key))
  );
}

// Lazy-loading JWKs
let jwks: jose.JWTVerifyGetKey | null = (() => {
  try {
    // using injected JWKS from cli
    const parsedJwks: unknown = decodeJsonText(Deno.env.get("SUPABASE_JWKS"));
    return isJsonWebKeySet(parsedJwks) ? jose.createLocalJWKSet(parsedJwks) : null;
  } catch {
    return null;
  }
})();

function isValidJWT(jwksUrl: URL, jwt: string): Effect.Effect<AuthFailure | null> {
  return Effect.tryPromise({
    try: () => {
      if (!jwks) {
        // Loading from remote-url on fly
        jwks = jose.createRemoteJWKSet(new URL(jwksUrl));
      }
      return jose.jwtVerify(jwt, jwks);
    },
    catch: (error) => new ServeRuntimeError({ cause: error }),
  }).pipe(
    Effect.as<AuthFailure | null>(null),
    Effect.catch((error) =>
      Effect.sync(() => {
        const details = describeRuntimeError(error);
        logError("Asymmetric JWT verification error", details.message, details.trace ?? "");
        return { code: RequestErrors.InvalidAsymmetricJWT };
      }),
    ),
  );
}

/**
 * Applies hybrid JWT verification, using JWK as primary and Legacy Secret as fallback.
 * Use only during 'New JWT Keys' migration period, while `JWT_SECRET` is still available.
 */
export const verifyHybridJWT = Effect.fn("functions.verifyHybridJWT")(function* (
  jwtSecret: string,
  jwksUrl: URL,
  jwt: string,
) {
  const jwtAlgorithm = yield* Effect.try({
    try: () => jose.decodeProtectedHeader(jwt).alg,
    catch: (cause) => new ServeRuntimeError({ cause }),
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (jwtAlgorithm === undefined) {
    yield* Effect.sync(() => logError("JWT format error"));
    return {
      code: RequestErrors.InvalidTokenFormat,
      message: "Invalid JWT format",
    };
  }

  if (jwtAlgorithm === "HS256") {
    yield* Effect.sync(() =>
      log(`Legacy token type detected, attempting ${jwtAlgorithm} verification.`),
    );
    return yield* isValidLegacyJWT(jwtSecret, jwt);
  }

  if (jwtAlgorithm === "ES256" || jwtAlgorithm === "RS256") {
    return yield* isValidJWT(jwksUrl, jwt);
  }

  return {
    code: RequestErrors.UnsupportedTokenAlgorithm,
    message: `Unsupported JWT algorithm ${jwtAlgorithm}`,
  };
});

// Ref: https://docs.deno.com/examples/checking_file_existence/
function shouldUsePackageJsonDiscovery({
  entrypointPath,
  importMapPath,
}: FunctionConfig): Effect.Effect<boolean> {
  if (importMapPath) {
    return Effect.succeed(false);
  }
  const packageJsonPath = join(dirname(entrypointPath), "package.json");
  return Effect.tryPromise({
    try: () => Deno.lstat(packageJsonPath),
    catch: (error) => new ServeRuntimeError({ cause: error }),
  }).pipe(
    Effect.as(true),
    Effect.catch((error) => {
      const cause = error instanceof ServeRuntimeError ? error.cause : error;
      return cause instanceof Deno.errors.NotFound ? Effect.succeed(false) : Effect.die(error);
    }),
  );
}

function describeRuntimeError(error: unknown) {
  const cause = error instanceof ServeRuntimeError ? error.cause : error;
  const message = cause instanceof Error ? cause.message : String(cause);
  const trace =
    cause instanceof Error ? cause.stack : error instanceof Error ? error.stack : undefined;
  return { cause, message, trace };
}

export function prepareUserRequest(req: Request): Request {
  const clonedURL = new URL(req.url);
  const forwardedHost = req.headers.get("x-forwarded-host");
  clonedURL.hostname = forwardedHost ?? clonedURL.hostname;
  const source = req.clone();
  const constructed: unknown = Reflect.construct(Request, [clonedURL.href, source]);
  if (!(constructed instanceof Request)) {
    throw new TypeError("failed to clone request");
  }
  const clonedReq = constructed;

  // remove custom api headers
  clonedReq.headers.delete("sb-api-key");
  EdgeRuntime.applySupabaseTag(req, clonedReq);

  return clonedReq;
}

Deno.serve({
  handler: (req: Request) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url);
        const { pathname } = url;

        // handle health checks
        if (pathname === "/_internal/health") {
          return getResponse({ message: "ok" }, STATUS_CODE.OK);
        }

        // handle metrics
        if (pathname === "/_internal/metric") {
          const metric = yield* Effect.tryPromise({
            try: () => EdgeRuntime.getRuntimeMetrics(),
            catch: (error) => new ServeRuntimeError({ cause: error }),
          });
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
          const token = yield* Effect.try({
            try: () => getAuthToken(req),
            catch: () => ({
              code: RequestErrors.InvalidTokenFormat,
              message: "Invalid JWT format",
            }),
          });
          if (typeof token !== "string") {
            return getAuthErrorResponse(token);
          }
          const authFailure = yield* verifyHybridJWT(JWT_SECRET, JWKS_ENDPOINT, token);
          if (authFailure) {
            return getAuthErrorResponse(authFailure);
          }
        }

        const servicePath = dirname(functionConfig.entrypointPath);
        yield* Effect.sync(() => logError(`serving the request with ${servicePath}`));

        // Ref: https://supabase.com/docs/guides/functions/limits
        const memoryLimitMb = 256;
        const workerTimeoutMs = isFinite(WALLCLOCK_LIMIT_SEC)
          ? WALLCLOCK_LIMIT_SEC * 1000
          : 400 * 1000;
        const noModuleCache = false;
        const envVarsObj = {
          ...Deno.env.toObject(),
          ...Object.fromEntries(
            Object.entries(functionConfig.env ?? {}).filter(
              ([name, _]) => !name.startsWith("SUPABASE_"),
            ),
          ),
        };
        if (SUPABASE_PUBLISHABLE_KEY) {
          envVarsObj["SUPABASE_PUBLISHABLE_KEYS"] = encodeJsonText({
            default: SUPABASE_PUBLISHABLE_KEY,
          });
        }
        if (SUPABASE_SECRET_KEY) {
          envVarsObj["SUPABASE_SECRET_KEYS"] = encodeJsonText({
            default: SUPABASE_SECRET_KEY,
          });
        }

        const envVars = Object.entries(envVarsObj).filter(
          ([name, _]) => !EXCLUDED_ENVS.includes(name) && !name.startsWith("SUPABASE_INTERNAL_"),
        );

        const forceCreate = false;
        const customModuleRoot = ""; // empty string to allow any local path
        const cpuTimeSoftLimitMs = 1000;
        const cpuTimeHardLimitMs = 2000;

        // NOTE(Nyannyacha): Decorator type has been set to tc39 by Lakshan's request,
        // but in my opinion, we should probably expose this to customers at some
        // point, as their migration process will not be easy.
        // This need to be kept for Deno 1 compatibility.
        const decoratorType = "tc39";

        const absEntrypoint = join(Deno.cwd(), functionConfig.entrypointPath);
        const maybeEntrypoint = toFileUrl(absEntrypoint).href;
        const usePackageJson = yield* shouldUsePackageJsonDiscovery(functionConfig);

        const staticPatterns = functionConfig.staticFiles;

        const workerResult = yield* Effect.tryPromise({
          try: () =>
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
              staticPatterns,
            }),
          catch: (error) => new ServeRuntimeError({ cause: error }),
        }).pipe(
          Effect.flatMap((worker) =>
            Effect.tryPromise({
              try: () => worker.fetch(prepareUserRequest(req)),
              catch: (error) => new ServeRuntimeError({ cause: error }),
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              const details = describeRuntimeError(error);
              logError(details.message, details.trace ?? "");

              for (const [denoError, sbCode] of DENO_SB_ERROR_MAP.entries()) {
                if (denoError !== void 0 && details.cause instanceof denoError) {
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
                  trace: encodeJsonText(details.trace ?? details.message),
                },
                STATUS_CODE.InternalServerError,
              );
            }),
          ),
        );
        return workerResult;
      }),
    ),

  onListen: () => {
    try {
      const functionsConfigString = Deno.env.get("SUPABASE_INTERNAL_FUNCTIONS_CONFIG");
      if (functionsConfigString) {
        const MAX_FUNCTIONS_URL_EXAMPLES = 5;
        const parsedConfig: unknown = decodeJsonText(functionsConfigString);
        if (!isFunctionsConfig(parsedConfig)) {
          throw new Error("functions config has an invalid shape");
        }
        const functionNames = Object.keys(parsedConfig);
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
        log(
          `${GENERIC_FUNCTION_SERVE_MESSAGE}${functionsExamplesMessages}\nUsing ${Deno.version.deno}`,
        );
      }
    } catch {
      log(`${GENERIC_FUNCTION_SERVE_MESSAGE}\nUsing ${Deno.version.deno}`);
    }
  },

  onError: (e: unknown) => {
    const details = describeRuntimeError(e);
    logError(details.message, details.trace ?? "");
    return getResponse(
      {
        code: STATUS_TEXT[STATUS_CODE.InternalServerError],
        message: "Request failed due to an internal server error",
        trace: encodeJsonText(details.trace ?? details.message),
      },
      STATUS_CODE.InternalServerError,
    );
  },
});
