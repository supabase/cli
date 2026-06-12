declare const Deno: any;
declare const EdgeRuntime: any;

// Surface of the Deno-only `jsr:@panva/jose@6` module used by this script.
// We hand-type it (rather than importing its types) because the bun workspace
// type-checker cannot resolve the `jsr:` specifier.
type JwksResolver = (...args: ReadonlyArray<unknown>) => Promise<CryptoKey>;
type JwtVerifyKey = Uint8Array | JwksResolver;
interface Jose {
  decodeProtectedHeader(token: string): { readonly alg?: string };
  jwtVerify(jwt: string, key: JwtVerifyKey): Promise<unknown>;
  createLocalJWKSet(jwks: { readonly keys: ReadonlyArray<unknown> }): JwksResolver;
  createRemoteJWKSet(url: URL): JwksResolver;
}

// jose is loaded lazily via dynamic import so it only resolves inside the edge
// runtime. The specifier is typed as `string` so the workspace type-checker
// (which also compiles this text-embedded file) does not try to resolve the
// Deno-only `jsr:` module.
let josePromise: Promise<Jose> | null = null;
function loadJose(): Promise<Jose> {
  const specifier: string = "jsr:@panva/jose@6";
  return (josePromise ??= import(specifier));
}

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

async function isValidLegacyJwt(jose: Jose, jwtSecret: string, jwt: string) {
  try {
    await jose.jwtVerify(jwt, new TextEncoder().encode(jwtSecret));
    return true;
  } catch (error) {
    console.error("Symmetric legacy JWT verification failed", error);
    return false;
  }
}

function createLocalJwks(jose: Jose, jwks: string): JwksResolver | null {
  try {
    return jose.createLocalJWKSet(JSON.parse(jwks));
  } catch {
    return null;
  }
}

async function isValidAsymmetricJwt(jose: Jose, jwks: string, jwksUrl: string, jwt: string) {
  // Prefer the JWKS injected by the CLI. If it has no key matching the token
  // (e.g. an asymmetric key minted elsewhere is absent from the local set),
  // fall back to the auth service's well-known JWKS endpoint.
  const localJwks = createLocalJwks(jose, jwks);
  if (localJwks) {
    try {
      await jose.jwtVerify(jwt, localJwks);
      return true;
    } catch {
      // No matching/valid local key — try the remote JWKS below.
    }
  }
  try {
    await jose.jwtVerify(jwt, jose.createRemoteJWKSet(new URL(jwksUrl)));
    return true;
  } catch (error) {
    console.error("Asymmetric JWT verification failed", error);
    return false;
  }
}

// Hybrid JWT verification: asymmetric (ES256 | RS256) tokens are verified
// against the JWKS, with the legacy symmetric secret (HS256) as a fallback.
// Mirrors the Go CLI runtime (supabase/cli#4721, #4985) during the migration
// to the new asymmetric JWT keys.
async function verifyHybridJwt(config: any, jwt: string) {
  const jose = await loadJose();

  let alg: string | undefined;
  try {
    ({ alg } = jose.decodeProtectedHeader(jwt));
  } catch (error) {
    console.error("Failed to decode JWT header", error);
    return false;
  }

  if (alg === "HS256") {
    return isValidLegacyJwt(jose, config.jwtSecret, jwt);
  }
  if (alg === "ES256" || alg === "RS256") {
    const jwksUrl = new URL("/auth/v1/.well-known/jwks.json", config.supabaseUrl).href;
    return isValidAsymmetricJwt(jose, config.jwks, jwksUrl, jwt);
  }
  return false;
}

async function verifyRequest(req: Request, config: any, functionConfig: any) {
  if (!functionConfig.verifyJWT || req.method === "OPTIONS") return null;
  const bearerToken = req.headers.get("authorization")?.slice("Bearer ".length);
  const sbApiKeyCompatibilityToken = req.headers.get("sb-api-key")?.replace("Bearer", "")?.trim();

  if (!bearerToken && !sbApiKeyCompatibilityToken) {
    return Response.json({ msg: "Missing authorization header" }, { status: 401 });
  }

  // NOTE:(kallebysantos) Compatibility mode is triggered when all conditions match:
  // - API proxy mints a temp token
  // - Original bearer is not present or is ApiKey
  const token =
    !bearerToken || bearerToken.startsWith("sb_") ? sbApiKeyCompatibilityToken : bearerToken;

  if (!token) {
    return Response.json({ msg: "Auth header is not 'Bearer {token}'" }, { status: 401 });
  }

  if (await verifyHybridJwt(config, token)) return null;
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
    SUPABASE_JWKS: config.jwks,
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
