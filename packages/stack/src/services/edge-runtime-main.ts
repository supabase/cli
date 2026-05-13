declare const Deno: any;
declare const EdgeRuntime: any;

const placeholder = {
  code: "FUNCTIONS_NOT_CONFIGURED",
  message: "Edge Functions are not configured for this local stack yet.",
};

const configPath =
  typeof Deno === "undefined"
    ? new URL("./functions-runtime-config.json", import.meta.url)
    : (Deno.env.get("FUNCTIONS_RUNTIME_CONFIG_PATH") ??
      new URL("./functions-runtime-config.json", import.meta.url));

async function loadConfig() {
  try {
    return JSON.parse(await Deno.readTextFile(configPath));
  } catch (error) {
    console.error(`Failed to load Edge Functions runtime config from ${configPath}`, error);
    return null;
  }
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let result = 0;
  for (let i = 0; i < left.byteLength; i++) {
    result |= left[i]! ^ right[i]!;
  }
  return result === 0;
}

async function isValidLocalJwt(secret: string, jwt: string) {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts;
  const decodedHeader = JSON.parse(new TextDecoder().decode(base64UrlToBytes(header!)));
  if (decodedHeader.alg !== "HS256") return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return bytesEqual(new Uint8Array(signed), base64UrlToBytes(signature!));
}

async function verifyRequest(req: Request, config: any, functionConfig: any) {
  if (!functionConfig.verifyJWT || req.method === "OPTIONS") return null;
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json({ msg: "Missing authorization header" }, { status: 401 });
  }
  const token = authHeader.slice("Bearer ".length);
  try {
    if (await isValidLocalJwt(config.jwtSecret, token)) return null;
  } catch (error) {
    console.error("JWT verification failed", error);
  }
  return Response.json({ msg: "Invalid JWT" }, { status: 401 });
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function fileUrl(path: string) {
  return new URL(`file://${path}`).href;
}

async function serveFunction(req: Request, config: any, functionName: string, functionConfig: any) {
  const authError = await verifyRequest(req, config, functionConfig);
  if (authError) return authError;

  const envVars = Object.entries({
    ...config.env,
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_ANON_KEY: config.publishableKey,
    SUPABASE_SERVICE_ROLE_KEY: config.secretKey,
    SUPABASE_DB_URL: config.dbUrl,
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: config.publishableKey }),
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: config.secretKey }),
  });

  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath: dirname(functionConfig.entrypointPath),
      memoryLimitMb: 256,
      workerTimeoutMs: 400000,
      noModuleCache: false,
      noNpm: false,
      importMapPath: functionConfig.importMapPath,
      envVars,
      forceCreate: false,
      customModuleRoot: "",
      cpuTimeSoftLimitMs: 1000,
      cpuTimeHardLimitMs: 2000,
      decoratorType: "tc39",
      maybeEntrypoint: fileUrl(functionConfig.entrypointPath),
      context: { useReadSyncFileAPI: true },
      staticPatterns: functionConfig.staticFiles,
    });
    return await worker.fetch(req);
  } catch (error) {
    console.error(`Failed to serve Function ${functionName}`, error);
    return Response.json(
      {
        code: "WORKER_ERROR",
        message: "Function failed to start or respond. Check edge-runtime logs for details.",
      },
      { status: 500 },
    );
  }
}

if (typeof Deno !== "undefined") {
  Deno.serve({
    handler: async (req: Request) => {
      const url = new URL(req.url);

      if (url.pathname === "/_internal/health") {
        return Response.json({ message: "ok" });
      }

      const config = await loadConfig();
      if (!config) return Response.json(placeholder, { status: 501 });

      const functionName = url.pathname.split("/").filter(Boolean)[0];
      const functionConfig = functionName ? config.functions[functionName] : undefined;
      if (!functionName || !functionConfig) {
        return new Response("Function not found", { status: 404 });
      }

      return serveFunction(req, config, functionName, functionConfig);
    },
    onListen: async () => {
      const config = await loadConfig();
      if (!config) return;
      const names = Object.keys(config.functions);
      const examples = names
        .slice(0, 5)
        .map((name) => ` - ${config.functionsUrl}/${name}`)
        .join("\n");
      console.log(
        `Serving functions on ${config.functionsUrl}/<function-name>${
          examples.length > 0 ? `\n${examples}` : ""
        }`,
      );
    },
  });
}

export default "";
