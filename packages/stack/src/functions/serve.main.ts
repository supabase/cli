// @ts-nocheck
// oxlint-disable effecttsgo/async-function -- standalone Edge Runtime artifact uses Deno async APIs.
// oxlint-disable effecttsgo/global-console -- standalone artifact emits its user-facing bootstrap logs.
declare const Deno: any;
declare const EdgeRuntime: any;

import { STATUS_CODE, STATUS_TEXT, toFileUrl } from "./serve-main-deps.ts";
import {
  createWorkerServicePathResolver,
  packageJsonContainedFor,
  resolveFunctionConfig,
  type FunctionConfig,
  type FunctionFileSystem,
  type FunctionOverrides,
} from "./serve-main-resolver.ts";
import * as jose from "jose";

const EXCLUDED_ENVS = ["HOME", "HOSTNAME", "PATH", "PWD"];
const HOST_PORT = Deno.env.get("SUPABASE_INTERNAL_HOST_PORT") ?? "8081";
const FUNCTIONS_ROOT = Deno.env.get("SUPABASE_INTERNAL_FUNCTIONS_ROOT") ?? "";
const JWT_SECRET = Deno.env.get("SUPABASE_INTERNAL_JWT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const JWKS_ENDPOINT = new URL("/auth/v1/.well-known/jwks.json", SUPABASE_URL);
const WALLCLOCK_LIMIT_SEC = Number.parseInt(
  Deno.env.get("SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC") ?? "400",
  10,
);
const SUPABASE_PUBLISHABLE_KEY = Deno.env.get("SUPABASE_INTERNAL_PUBLISHABLE_KEY");
const SUPABASE_SECRET_KEY = Deno.env.get("SUPABASE_INTERNAL_SECRET_KEY");

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
  InvalidLegacyJWT = "UNAUTHORIZED_LEGACY_JWT",
  InvalidAsymmetricJWT = "UNAUTHORIZED_ASYMMETRIC_JWT",
  InvalidTokenFormat = "UNAUTHORIZED_INVALID_JWT_FORMAT",
  UnsupportedTokenAlgorithm = "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM",
}

const parseConfig = (): FunctionOverrides => {
  const raw = Deno.env.get("SUPABASE_INTERNAL_FUNCTIONS_CONFIG");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Invalid optional config is treated as no overrides; host preflight reports invalid paths.
  }
  return {};
};
const configured = parseConfig();
if (Deno.env.get("SUPABASE_INTERNAL_DEBUG") === "true") {
  const debugConfig = Object.fromEntries(
    Object.entries(configured).map(([name, config]) => [
      name,
      Object.fromEntries(Object.entries(config).filter(([key]) => key !== "env")),
    ]),
  );
  console.log("Functions config:", JSON.stringify(debugConfig, null, 2));
}

const getResponse = (payload: any, status: number, customHeaders = {}) => {
  const headers = { ...customHeaders };
  let body: string | null = null;
  if (payload !== undefined && payload !== null) {
    if (typeof payload === "object") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(payload);
    } else {
      headers["Content-Type"] = "text/plain";
      body = String(payload);
    }
  }
  return new Response(body, { status, headers });
};

const getAuthErrorResponse = ({
  code,
  message = "Invalid JWT",
}: {
  code: RequestErrors;
  message?: string;
}) =>
  getResponse({ code, message, msg: message }, STATUS_CODE.Unauthorized, {
    "sb-error-code": code,
    "Access-Control-Expose-Headers": "sb-error-code",
  });

export function extractBearerToken(rawToken: string) {
  const parts = rawToken.split(" ");
  return parts.length === 2 && parts[0] === "Bearer" ? parts[1] : null;
}

const getAuthToken = (request: Request): string | { code: RequestErrors; message: string } => {
  const authHeader = request.headers.get("authorization");
  const compatibility = request.headers.get("sb-api-key")?.replace("Bearer", "").trim();
  if (!authHeader && !compatibility)
    return { code: RequestErrors.MissingAuthHeader, message: "Missing authorization header" };
  const bearer = extractBearerToken(authHeader ?? "");
  const token = !bearer || bearer.startsWith("sb_") ? compatibility : bearer;
  return token ? token : { code: RequestErrors.InvalidTokenFormat, message: "Invalid JWT format" };
};

let localJwks: any = (() => {
  try {
    return jose.createLocalJWKSet(JSON.parse(Deno.env.get("SUPABASE_JWKS") ?? "{" + '"keys":[]}'));
  } catch {
    return null;
  }
})();
const isValidAsymmetricJWT = async (jwt: string): Promise<{ code: RequestErrors } | null> => {
  try {
    if (!localJwks) localJwks = jose.createRemoteJWKSet(JWKS_ENDPOINT);
    await jose.jwtVerify(jwt, localJwks);
    return null;
  } catch {
    return { code: RequestErrors.InvalidAsymmetricJWT };
  }
};

export async function verifyHybridJWT(jwtSecret: string, jwksUrl: URL, jwt: string) {
  try {
    const algorithm = jose.decodeProtectedHeader(jwt).alg;
    if (!algorithm)
      return { code: RequestErrors.InvalidTokenFormat, message: "Invalid JWT format" };
    if (algorithm === "HS256") {
      try {
        await jose.jwtVerify(jwt, new TextEncoder().encode(jwtSecret));
        return null;
      } catch {
        return { code: RequestErrors.InvalidLegacyJWT };
      }
    }
    if (algorithm === "ES256" || algorithm === "RS256") return isValidAsymmetricJWT(jwt);
    return {
      code: RequestErrors.UnsupportedTokenAlgorithm,
      message: `Unsupported JWT algorithm ${algorithm}`,
    };
  } catch {
    return { code: RequestErrors.InvalidTokenFormat, message: "Invalid JWT format" };
  }
}

const denoFileSystem: FunctionFileSystem = {
  lstat: async (path) => {
    const info = await Deno.lstat(path);
    return {
      isDirectory: info.isDirectory,
      isFile: info.isFile,
      isSymbolicLink: info.isSymlink,
    };
  },
  realPath: (path) => Deno.realPath(path),
  readDirectory: async (path) => {
    const entries: string[] = [];
    for await (const entry of Deno.readDir(path)) entries.push(entry.name);
    return entries;
  },
};

const functionConfig = (slug: string): Promise<FunctionConfig | undefined> =>
  resolveFunctionConfig({ root: FUNCTIONS_ROOT, slug, overrides: configured, fs: denoFileSystem });
const workerServicePath = createWorkerServicePathResolver(() =>
  Deno.makeTempDirSync({ prefix: "supabase-worker-" }),
);

const shouldUsePackageJsonDiscovery = async (config: FunctionConfig): Promise<boolean> => {
  if (config.importMapPath) return false;
  return packageJsonContainedFor({ root: FUNCTIONS_ROOT, config, fs: denoFileSystem });
};

export function prepareUserRequest(request: Request): Request {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) url.hostname = forwardedHost;
  const cloned = new Request(url, request.clone());
  cloned.headers.delete("sb-api-key");
  EdgeRuntime.applySupabaseTag(request, cloned);
  return cloned;
}

Deno.serve({
  handler: async (request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/_internal/health") return getResponse({ message: "ok" }, STATUS_CODE.OK);
    if (pathname === "/_internal/metric")
      return Response.json(await EdgeRuntime.getRuntimeMetrics());
    const functionName = pathname.split("/")[1];
    if (!functionName) return getResponse("Function not found", STATUS_CODE.NotFound);
    const config = await functionConfig(functionName);
    if (!config) return getResponse("Function not found", STATUS_CODE.NotFound);
    if (request.method !== "OPTIONS" && config.verifyJWT) {
      const token = getAuthToken(request);
      if (typeof token !== "string") return getAuthErrorResponse(token);
      const authFailure = await verifyHybridJWT(JWT_SECRET, JWKS_ENDPOINT, token);
      if (authFailure) return getAuthErrorResponse(authFailure);
    }
    const envVarsObj = {
      ...Deno.env.toObject(),
      ...Object.fromEntries(
        Object.entries(config.env ?? {}).filter(([name]) => !name.startsWith("SUPABASE_")),
      ),
      SUPABASE_FUNCTION_SLUG: functionName,
    };
    if (SUPABASE_PUBLISHABLE_KEY)
      envVarsObj.SUPABASE_PUBLISHABLE_KEYS = JSON.stringify({ default: SUPABASE_PUBLISHABLE_KEY });
    if (SUPABASE_SECRET_KEY)
      envVarsObj.SUPABASE_SECRET_KEYS = JSON.stringify({ default: SUPABASE_SECRET_KEY });
    const envVars = Object.entries(envVarsObj).filter(
      ([name]) => !EXCLUDED_ENVS.includes(name) && !name.startsWith("SUPABASE_INTERNAL_"),
    );
    try {
      const worker = await EdgeRuntime.userWorkers.create({
        servicePath: workerServicePath(functionName, config),
        memoryLimitMb: 256,
        workerTimeoutMs: Number.isFinite(WALLCLOCK_LIMIT_SEC)
          ? WALLCLOCK_LIMIT_SEC * 1000
          : 400_000,
        noModuleCache: true,
        noNpm: !(await shouldUsePackageJsonDiscovery(config)),
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
      });
      return await worker.fetch(prepareUserRequest(request));
    } catch (error) {
      console.error("[functions] worker error", error);
      for (const [denoError, sbCode] of DENO_SB_ERROR_MAP.entries()) {
        if (denoError !== undefined && error instanceof denoError)
          return getResponse(
            { code: SB_SPECIFIC_ERROR_TEXT[sbCode], message: SB_SPECIFIC_ERROR_REASON[sbCode] },
            sbCode,
          );
      }
      return getResponse(
        {
          code: STATUS_TEXT[STATUS_CODE.InternalServerError],
          message: "Request failed due to an internal server error",
        },
        STATUS_CODE.InternalServerError,
      );
    }
  },
  onListen: () => {
    const names = Object.keys(configured);
    const examples = names
      .slice(0, 5)
      .map((name) => ` - http://127.0.0.1:${HOST_PORT}/functions/v1/${name}`);
    console.log(
      `Serving functions on http://127.0.0.1:${HOST_PORT}/functions/v1/<function-name>${examples.length ? `\n${examples.join("\n")}` : ""}\nUsing ${Deno.version.deno}`,
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
