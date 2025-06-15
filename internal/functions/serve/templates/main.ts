import { STATUS_CODE, STATUS_TEXT } from "https://deno.land/std/http/status.ts";
import * as posix from "https://deno.land/std/path/posix/mod.ts";

import * as jose from "https://deno.land/x/jose@v4.13.1/index.ts";

const SB_SPECIFIC_ERROR_CODE = {
  BootError:
    STATUS_CODE.ServiceUnavailable, /** Service Unavailable (RFC 7231, 6.6.4) */
  InvalidWorkerResponse:
    STATUS_CODE.InternalServerError, /** Internal Server Error (RFC 7231, 6.6.1) */
  WorkerLimit: 546, /** Extended */
};

const SB_SPECIFIC_ERROR_TEXT = {
  [SB_SPECIFIC_ERROR_CODE.BootError]: "BOOT_ERROR",
  [SB_SPECIFIC_ERROR_CODE.InvalidWorkerResponse]: "WORKER_ERROR",
  [SB_SPECIFIC_ERROR_CODE.WorkerLimit]: "WORKER_LIMIT",
};

const SB_SPECIFIC_ERROR_REASON = {
  [SB_SPECIFIC_ERROR_CODE.BootError]:
    "Worker failed to boot (please check logs)",
  [SB_SPECIFIC_ERROR_CODE.InvalidWorkerResponse]:
    "Function exited due to an error (please check logs)",
  [SB_SPECIFIC_ERROR_CODE.WorkerLimit]:
    "Worker failed to respond due to a resource limit (please check logs)",
};

// OS stuff - we don't want to expose these to the functions.
const EXCLUDED_ENVS = ["HOME", "HOSTNAME", "PATH", "PWD"];

const JWT_SECRET = Deno.env.get("SUPABASE_INTERNAL_JWT_SECRET")!;
const HOST_PORT = Deno.env.get("SUPABASE_INTERNAL_HOST_PORT")!;
const DEBUG = Deno.env.get("SUPABASE_INTERNAL_DEBUG") === "true";
const FUNCTIONS_CONFIG_STRING = Deno.env.get(
  "SUPABASE_INTERNAL_FUNCTIONS_CONFIG",
)!;

const WALLCLOCK_LIMIT_SEC = parseInt(
  Deno.env.get("SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC"),
);

const DENO_SB_ERROR_MAP = new Map([
  [Deno.errors.InvalidWorkerCreation, SB_SPECIFIC_ERROR_CODE.BootError],
  [Deno.errors.InvalidWorkerResponse, SB_SPECIFIC_ERROR_CODE.InvalidWorkerResponse],
  [
    Deno.errors.WorkerRequestCancelled,
    SB_SPECIFIC_ERROR_CODE.WorkerLimit,
  ],
]);
const GENERIC_FUNCTION_SERVE_MESSAGE = `Serving functions on http://127.0.0.1:${HOST_PORT}/functions/v1/<function-name>`

interface FunctionConfig {
  entrypointPath: string;
  importMapPath: string;
  verifyJWT: boolean;
}

function getResponse(payload: any, status: number, customHeaders = {}) {
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

const functionsConfig: Record<string, FunctionConfig> = (() => {
  try {
    const functionsConfig = JSON.parse(FUNCTIONS_CONFIG_STRING);

    if (DEBUG) {
      console.log(
        "Functions config:",
        JSON.stringify(functionsConfig, null, 2),
      );
    }

    return functionsConfig;
  } catch (cause) {
    throw new Error("Failed to parse functions config", { cause });
  }
})();

function getAuthToken(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    throw new Error("Missing authorization header");
  }
  const [bearer, token] = authHeader.split(" ");
  if (bearer !== "Bearer") {
    throw new Error(`Auth header is not 'Bearer {token}'`);
  }
  return token;
}

async function verifyJWT(jwt: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(JWT_SECRET);
  try {
    await jose.jwtVerify(jwt, secretKey);
  } catch (e) {
    console.error(e);
    return false;
  }
  return true;
}

Deno.serve({
  handler: async (req: Request) => {
    const url = new URL(req.url);
    const { pathname } = url;

    // handle health checks
    if (pathname === "/_internal/health") {
      return getResponse({ message: "ok" }, STATUS_CODE.OK);
    }

    // handle metrics
    if (pathname === '/_internal/metric') {
      const metric = await EdgeRuntime.getRuntimeMetrics();
      return Response.json(metric);
    }

    const pathParts = pathname.split("/");
    const functionName = pathParts[1];

    if (!functionName || !(functionName in functionsConfig)) {
      return getResponse("Function not found", STATUS_CODE.NotFound);
    }

    if (req.method !== "OPTIONS" && functionsConfig[functionName].verifyJWT) {
      try {
        const token = getAuthToken(req);
        const isValidJWT = await verifyJWT(token);

        if (!isValidJWT) {
          return getResponse({ msg: "Invalid JWT" }, STATUS_CODE.Unauthorized);
        }
      } catch (e) {
        console.error(e);
        return getResponse({ msg: e.toString() }, STATUS_CODE.Unauthorized);
      }
    }

    const servicePath = posix.dirname(functionsConfig[functionName].entrypointPath);
    console.error(`serving the request with ${servicePath}`);

    // Ref: https://supabase.com/docs/guides/functions/limits
    const memoryLimitMb = 256;
    const workerTimeoutMs = isFinite(WALLCLOCK_LIMIT_SEC) ? WALLCLOCK_LIMIT_SEC * 1000 : 400 * 1000;
    const noModuleCache = false;
    const envVarsObj = Deno.env.toObject();
    const envVars = Object.entries(envVarsObj)
      .filter(([name, _]) =>
        !EXCLUDED_ENVS.includes(name) && !name.startsWith("SUPABASE_INTERNAL_")
      );

    const forceCreate = false;
    const customModuleRoot = ""; // empty string to allow any local path
    const cpuTimeSoftLimitMs = 1000;
    const cpuTimeHardLimitMs = 2000;

    // NOTE(Nyannyacha): Decorator type has been set to tc39 by Lakshan's request,
    // but in my opinion, we should probably expose this to customers at some
    // point, as their migration process will not be easy.
    const decoratorType = "tc39";

    const absEntrypoint = posix.join(Deno.cwd(), functionsConfig[functionName].entrypointPath);
    const maybeEntrypoint = posix.toFileUrl(absEntrypoint).href;

    const staticPatterns = functionsConfig[functionName].staticFiles;

    try {
      const worker = await EdgeRuntime.userWorkers.create({
        servicePath,
        memoryLimitMb,
        workerTimeoutMs,
        noModuleCache,
        importMapPath: functionsConfig[functionName].importMapPath,
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
      });

      return await worker.fetch(req);
    } catch (e) {
      console.error(e);

      for (const [denoError, sbCode] of DENO_SB_ERROR_MAP.entries()) {
        if (denoError !== void 0 && e instanceof denoError) {
          return getResponse(
            {
              code: SB_SPECIFIC_ERROR_TEXT[sbCode],
              message: SB_SPECIFIC_ERROR_REASON[sbCode],
            },
            sbCode
          );
        }
      }

      return getResponse(
        {
          code: STATUS_TEXT[STATUS_CODE.InternalServerError],
          message: "Request failed due to an internal server error",
          trace: JSON.stringify(e.stack)
        },
        STATUS_CODE.InternalServerError,
      );
    }
  },

  onListen: () => {
    try {
      const functionsConfigString = Deno.env.get(
        "SUPABASE_INTERNAL_FUNCTIONS_CONFIG"
      );
      if (functionsConfigString) {
        const MAX_FUNCTIONS_URL_EXAMPLES = 5
        const functionsConfig = JSON.parse(functionsConfigString) as Record<
          string,
          unknown
        >;
        const functionNames = Object.keys(functionsConfig);
        const exampleFunctions = functionNames.slice(0, MAX_FUNCTIONS_URL_EXAMPLES);
        const functionsUrls = exampleFunctions.map(
          (fname) => ` - http://127.0.0.1:${HOST_PORT}/functions/v1/${fname}`
        );
        const functionsExamplesMessages = functionNames.length > 0
          // Show some functions urls examples
          ? `\n${functionsUrls.join(`\n`)}${functionNames.length > MAX_FUNCTIONS_URL_EXAMPLES
            // If we have more than 10 functions to serve, then show examples for first 10
            // and a count for the remaining ones
            ? `\n... and ${functionNames.length - MAX_FUNCTIONS_URL_EXAMPLES} more functions`
            : ''}`
          : ''
        console.log(`${GENERIC_FUNCTION_SERVE_MESSAGE}${functionsExamplesMessages}\nUsing ${Deno.version.deno}`);
      }
    } catch (e) {
      console.log(
        `${GENERIC_FUNCTION_SERVE_MESSAGE}\nUsing ${Deno.version.deno}`
      );
    }
  },

  onError: e => {
    return getResponse(
      {
        code: STATUS_TEXT[STATUS_CODE.InternalServerError],
        message: "Request failed due to an internal server error",
        trace: JSON.stringify(e.stack)
      },
      STATUS_CODE.InternalServerError
    )
  }
});
