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
  const workerTimeoutMs = 1 * 60 * 1000;
  const noModuleCache = false;
  const envVarsObj = Deno.env.toObject();
  const envVars = Object.entries(envVarsObj)
    .filter(([name, _]) =>
      !EXCLUDED_ENVS.includes(name) && !name.startsWith("SUPABASE_INTERNAL_")
    );
  const forceCreate = true;
  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb,
      workerTimeoutMs,
      noModuleCache,
      importMapPath: functionsConfig[functionName].importMapPath,
      envVars,
      forceCreate,
    });
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
