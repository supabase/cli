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

interface Jwk {
  readonly kty?: string;
  readonly kid?: string;
}

interface Jwks {
  readonly keys: ReadonlyArray<Jwk>;
}

// Asymmetric algorithms supported during the migration to new JWT keys, mapped
// to the WebCrypto import/verify parameters used to validate their signatures.
const ASYMMETRIC_ALGORITHMS = {
  ES256: {
    kty: "EC",
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    verifyParams: { name: "ECDSA", hash: "SHA-256" },
  },
  RS256: {
    kty: "RSA",
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verifyParams: { name: "RSASSA-PKCS1-v1_5" },
  },
};

type AsymmetricAlgorithm = keyof typeof ASYMMETRIC_ALGORITHMS;

async function verifyLegacyHs256(secret: string, signingInput: string, signature: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBytes(signature),
    new TextEncoder().encode(signingInput),
  );
}

export async function verifyWithJwks(
  alg: AsymmetricAlgorithm,
  kid: string | undefined,
  signingInput: string,
  signature: string,
  jwks: Jwks,
) {
  const spec = ASYMMETRIC_ALGORITHMS[alg];
  const data = new TextEncoder().encode(signingInput);
  const sig = base64UrlToBytes(signature);
  // Match by key type, and by `kid` when both the token and the key carry one.
  // Keys without a `kid` stay eligible so single-key sets that omit it (some
  // issuers do) still verify — mirroring the more lenient Go-side behavior.
  const candidates = jwks.keys.filter(
    (key) =>
      key.kty === spec.kty && (kid === undefined || key.kid === undefined || key.kid === kid),
  );
  for (const jwk of candidates) {
    try {
      const key = await crypto.subtle.importKey("jwk", jwk, spec.importParams, false, ["verify"]);
      if (await crypto.subtle.verify(spec.verifyParams, key, sig, data)) return true;
    } catch {
      // Not a usable/matching key (bad import or wrong signature) — try the next
      // candidate. Logging here fires per key per request, so stay quiet.
    }
  }
  return false;
}

function toJwks(value: unknown): Jwks {
  if (value !== null && typeof value === "object" && "keys" in value && Array.isArray(value.keys)) {
    return { keys: value.keys };
  }
  return { keys: [] };
}

function parseLocalJwks(jwks: string): Jwks {
  try {
    return toJwks(JSON.parse(jwks));
  } catch {
    return { keys: [] };
  }
}

// Cache the well-known JWKS per URL so asymmetric verification does not refetch
// `/auth/v1/.well-known/jwks.json` on every request.
const remoteJwksCache = new Map<string, Promise<Jwks>>();

function fetchRemoteJwks(jwksUrl: string): Promise<Jwks> {
  const cached = remoteJwksCache.get(jwksUrl);
  if (cached) return cached;
  const pending = fetch(jwksUrl)
    .then((res) => {
      // Without this, a non-2xx response with a JSON body (e.g. a 502/404 from
      // the gateway during startup) would parse into an empty key set and be
      // cached permanently, rejecting every asymmetric token until restart.
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
      return res.json();
    })
    .then(toJwks)
    .then((jwks) => {
      // Don't cache an empty key set: the auth service may not have published
      // its keys yet, so allow a refetch on the next request instead.
      if (jwks.keys.length === 0) remoteJwksCache.delete(jwksUrl);
      return jwks;
    });
  pending.catch(() => remoteJwksCache.delete(jwksUrl));
  remoteJwksCache.set(jwksUrl, pending);
  return pending;
}

// Reject expired (`exp`) or not-yet-valid (`nbf`) tokens regardless of
// signature, matching the Go/Docker runtime (jose / golang-jwt validate these
// by default). A small clock-skew window avoids spurious failures locally.
export function areClaimsValid(payload: string): boolean {
  let claims: { exp?: unknown; nbf?: unknown };
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  } catch {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  const skew = 60;
  if (typeof claims.exp === "number" && claims.exp + skew < now) return false;
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) return false;
  return true;
}

// Hybrid JWT verification: asymmetric (ES256 | RS256) tokens are verified
// against the JWKS, with the legacy symmetric secret (HS256) as a fallback.
// Mirrors the Go CLI runtime (supabase/cli#4721, #4985) during the migration
// to the new asymmetric JWT keys.
export async function verifyHybridJwt(config: any, jwt: string) {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts;
  const signingInput = `${header}.${payload}`;

  let decodedHeader: { alg?: string; kid?: string };
  try {
    decodedHeader = JSON.parse(new TextDecoder().decode(base64UrlToBytes(header!)));
  } catch (error) {
    console.error("Failed to decode JWT header", error);
    return false;
  }

  if (!areClaimsValid(payload!)) return false;

  try {
    if (decodedHeader.alg === "HS256") {
      return await verifyLegacyHs256(config.jwtSecret, signingInput, signature!);
    }
    if (decodedHeader.alg === "ES256" || decodedHeader.alg === "RS256") {
      const { alg, kid } = decodedHeader;
      // The CLI-injected `config.jwks` is currently symmetric-only (an `oct`
      // key derived from jwtSecret), so it never matches an ES256/RS256 token
      // today — this local check is future-proofing for when the stack config
      // grows asymmetric signing keys. Real asymmetric verification currently
      // resolves through the auth service's well-known endpoint below.
      const localJwks = parseLocalJwks(config.jwks);
      if (await verifyWithJwks(alg, kid, signingInput, signature!, localJwks)) {
        return true;
      }
      const jwksUrl = new URL("/auth/v1/.well-known/jwks.json", config.supabaseUrl).href;
      const remoteJwks = await fetchRemoteJwks(jwksUrl);
      return await verifyWithJwks(alg, kid, signingInput, signature!, remoteJwks);
    }
  } catch (error) {
    console.error("JWT verification failed", error);
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
