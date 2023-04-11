import { serve } from "https://deno.land/std@0.182.0/http/server.ts";
import * as jose from "https://deno.land/x/jose@v4.13.1/index.ts";

const JWT_SECRET = Deno.env.get("SUPABASE_INTERNAL_JWT_SECRET")!;
const HOST_PORT = Deno.env.get("SUPABASE_INTERNAL_HOST_PORT")!;
// OS stuff - we don't want to expose these to the functions.
const EXCLUDED_ENVS = ["HOME", "HOSTNAME", "PATH", "PWD"];
const FUNCTIONS_PATH = Deno.env.get("SUPABASE_INTERNAL_FUNCTIONS_PATH")!;
const DEBUG = Deno.env.get("SUPABASE_INTERNAL_DEBUG") === "true";

interface FunctionConfig {
  importMapPath: string;
  verifyJWT: boolean;
}

const functionsConfig: Record<
  string,
  FunctionConfig
> = (() => {
  const functionsConfig = {} as Record<string, FunctionConfig>;

  Object.entries(Deno.env.toObject()).forEach(([name, value]) => {
    const matches = name.match(
      /^SUPABASE_INTERNAL_(IMPORT_MAP_PATH|VERIFY_JWT)_(.+)$/,
    );
    if (!matches) {
      // skip
    } else if (matches[1] === "IMPORT_MAP_PATH") {
      const functionName = matches[2];
      functionsConfig[functionName] ??= {} as FunctionConfig;
      functionsConfig[functionName].importMapPath = value;
    } else if (matches[1] === "VERIFY_JWT") {
      const functionName = matches[2];
      functionsConfig[functionName] ??= {} as FunctionConfig;
      functionsConfig[functionName].verifyJWT = value === "true";
    }
  });

  if (DEBUG) {
    console.log("Functions config:", JSON.stringify(functionsConfig, null, 2));
  }

  return functionsConfig;
})();

const workerCache = {} as Record<string, { fetch: typeof fetch }>;

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

  const functionPath = `${FUNCTIONS_PATH}/${functionName}`;
  console.error(`serving the request with ${functionPath}`);

  const memoryLimitMb = 150;
  const workerTimeoutMs = 1 * 60 * 1000;
  const noModuleCache = false;
  const envVarsObj = Deno.env.toObject();
  const envVars = Object.entries(envVarsObj)
    .filter(([name, _]) =>
      !EXCLUDED_ENVS.includes(name) && !name.startsWith("SUPABASE_INTERNAL_")
    );
  try {
    if (functionName in workerCache) {
      return await workerCache[functionName].fetch(req);
    }

    const worker = await EdgeRuntime.userWorkers.create({
      servicePath: functionPath,
      memoryLimitMb,
      workerTimeoutMs,
      noModuleCache,
      // TODO: verify that this is configurable per-function
      importMapPath: functionsConfig[functionName].importMapPath,
      envVars,
    });
    workerCache[functionName] = worker;
    return await worker.fetch(req);
  } catch (e) {
    console.error(e);
    const error = { msg: e.toString() };
    return new Response(
      JSON.stringify(error),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}, {
  onListen: () => {
    console.log(
      `Serving functions on http://localhost:${HOST_PORT}/functions/v1/<function-name>`,
    );
  },
});
