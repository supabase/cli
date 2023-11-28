import { serve } from "https://deno.land/std@0.182.0/http/server.ts";
import * as jose from "https://deno.land/x/jose@v4.13.1/index.ts";

const JWT_SECRET = Deno.env.get("SUPABASE_INTERNAL_JWT_SECRET")!;
const HOST_PORT = Deno.env.get("SUPABASE_INTERNAL_HOST_PORT")!;
// OS stuff - we don't want to expose these to the functions.
const EXCLUDED_ENVS = ["HOME", "HOSTNAME", "PATH", "PWD"];
const FUNCTIONS_PATH = Deno.env.get("SUPABASE_INTERNAL_FUNCTIONS_PATH")!;
const DEBUG = Deno.env.get("SUPABASE_INTERNAL_DEBUG") === "true";
const FUNCTIONS_CONFIG_STRING = Deno.env.get(
  "SUPABASE_INTERNAL_FUNCTIONS_CONFIG",
)!;

interface FunctionConfig {
  importMapPath: string;
  verifyJWT: boolean;
}

enum WorkerErrors {
  InvalidWorkerCreation = "InvalidWorkerCreation",
  InvalidWorkerResponse = "InvalidWorkerResponse",
}

function respondWith(payload: any, status: number, customHeaders = {}) {
  const headers = { ...customHeaders };
  let body = null;
  if (payload) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }
  const res = new Response(body, {
    status,
    headers,
  });
  return res;
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
  } catch (err) {
    console.error(err);
    return false;
  }
  return true;
}

serve(async (req: Request) => {
  const url = new URL(req.url);
  const { pathname } = url;

  // handle health checks
  if (pathname === "/_internal/health") {
    return new Response(
      JSON.stringify({ "message": "ok" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const pathParts = pathname.split("/");
  const functionName = pathParts[1];

  if (!functionName || !(functionName in functionsConfig)) {
    return new Response("Function not found", { status: 404 });
  }

  if (req.method !== "OPTIONS" && functionsConfig[functionName].verifyJWT) {
    try {
      const token = getAuthToken(req);
      const isValidJWT = await verifyJWT(token);

      if (!isValidJWT) {
        return new Response(
          JSON.stringify({ msg: "Invalid JWT" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
    } catch (e) {
      console.error(e);
      return new Response(
        JSON.stringify({ msg: e.toString() }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  const servicePath = `${FUNCTIONS_PATH}/${functionName}`;
  console.error(`serving the request with ${servicePath}`);

  const memoryLimitMb = 150;
  const workerTimeoutMs = 400 * 1000;
  const noModuleCache = false;
  const envVarsObj = Deno.env.toObject();
  const envVars = Object.entries(envVarsObj)
    .filter(([name, _]) =>
      !EXCLUDED_ENVS.includes(name) && !name.startsWith("SUPABASE_INTERNAL_")
    );
  const forceCreate = true;
  const customModuleRoot = ""; // empty string to allow any local path
  const cpuTimeSoftLimitMs = 10000;
  const cpuTimeHardLimitMs = 20000;
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
    });
    const controller = new AbortController();

    const { signal } = controller;
    // Note: Requests are aborted after 200s (same config as in production)
    // TODO: make this configuarable
    setTimeout(() => controller.abort(), 200 * 1000);
    return await worker.fetch(req, { signal });
  } catch (e) {
    console.error(e);
    if (e.name === WorkerErrors.InvalidWorkerCreation) {
      return respondWith(
        {
          code: "BOOT_ERROR",
          message: "Worker failed to boot (please check logs)",
        },
        503,
      );
    }
    if (e.name === WorkerErrors.InvalidWorkerResponse) {
      return respondWith(
        {
          code: "WORKER_LIMIT",
          message:
            "Worker failed to respond due to an error or resource limit (please check logs)",
        },
        546, // custom error code
      );
    }
    return respondWith(
      {
        code: Status.InternalServerError,
        message: "Request failed due to a server error",
      },
      Status.InternalServerError,
    );
  }
}, {
  onListen: () => {
    console.log(
      `Serving functions on http://127.0.0.1:${HOST_PORT}/functions/v1/<function-name>`,
    );
  },
});
