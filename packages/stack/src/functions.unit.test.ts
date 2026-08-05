import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { resolveConfig } from "./StackConfigResolver.ts";
import { defaultJwtSecret, generateJwt } from "./JwtGenerator.ts";
import type { LocalJwtSigningKey, LocalJwtSigningMaterial } from "./LocalCredentials.ts";
import { resolveLocalCredentials } from "./LocalCredentials.ts";
import {
  clearFunctionsRuntimeConfig,
  configureFunctionsRuntime,
  functionsRuntimeConfigPath,
  ResolvedFunctionsBundleSchema,
  resolveFunctionsRuntimeConfig,
  type ResolvedFunctionsBundle,
} from "./functions.ts";
import { resolveFunctionEnvironment, verifyRequest } from "./services/edge-runtime-main.ts";

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "supabase-stack-functions-"));
}

function makeBundle(root: string): ResolvedFunctionsBundle {
  return {
    env: { SHARED: "shared-value", BUNDLE_ONLY: "bundle-value" },
    functions: [
      {
        name: "hello-world",
        verifyJWT: true,
        entrypointPath: join(root, "functions", "hello-world", "index.ts"),
        importMapPath: null,
        staticFiles: [join(root, "functions", "hello-world", "assets", "*")],
        env: { SHARED: "function-value", FUNCTION_ONLY: "function-value" },
      },
    ],
  };
}

function jwtWithInvalidSignature(algorithm?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "test-user" })).toString("base64url");
  return `${header}.${payload}.invalid`;
}

const localEs256Key: LocalJwtSigningKey = {
  kty: "EC",
  kid: "local-ec-test",
  use: "sig",
  alg: "ES256",
  crv: "P-256",
  x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
  y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
  d: "dIhR8wywJlqlua4y_yMq2SLhlFXDZJBCvFrY1DCHyVU",
};

function requiredJwkField(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Generated JWK is missing ${field}`);
  }
  return value;
}

function localRs256Key(): LocalJwtSigningKey {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = privateKey.export({ format: "jwk" });
  return {
    kty: "RSA",
    kid: "local-rsa-test",
    use: "sig",
    alg: "RS256",
    n: requiredJwkField(key.n, "n"),
    e: requiredJwkField(key.e, "e"),
    d: requiredJwkField(key.d, "d"),
    p: requiredJwkField(key.p, "p"),
    q: requiredJwkField(key.q, "q"),
    dp: requiredJwkField(key.dp, "dp"),
    dq: requiredJwkField(key.dq, "dq"),
    qi: requiredJwkField(key.qi, "qi"),
  };
}

async function functionsAuthFixture(signing?: LocalJwtSigningMaterial) {
  const root = makeTempProject();
  const bundle = makeBundle(root);
  const stackConfig = await resolveConfig({
    functions: bundle,
    ...(signing === undefined ? {} : { credentials: { signing } }),
  });
  const runtimeConfig = resolveFunctionsRuntimeConfig(
    stackConfig,
    { hostname: "127.0.0.1" },
    bundle,
  );
  if (runtimeConfig === undefined) throw new Error("Functions runtime config was not resolved");
  return { root, runtimeConfig, token: stackConfig.anonJwt };
}

const authFailureCases = [
  {
    name: "returns the missing authorization error",
    code: "UNAUTHORIZED_NO_AUTH_HEADER",
    message: "Missing authorization header",
  },
  {
    name: "returns the invalid JWT format error",
    authorization: "Bearer not-a-jwt",
    code: "UNAUTHORIZED_INVALID_JWT_FORMAT",
    message: "Invalid JWT format",
  },
  {
    name: "returns the invalid JWT format error when the algorithm is missing",
    authorization: `Bearer ${jwtWithInvalidSignature()}`,
    code: "UNAUTHORIZED_INVALID_JWT_FORMAT",
    message: "Invalid JWT format",
  },
  {
    name: "returns the legacy JWT error",
    authorization: `Bearer ${jwtWithInvalidSignature("HS256")}`,
    code: "UNAUTHORIZED_LEGACY_JWT",
    message: "Invalid JWT",
  },
  {
    name: "returns the asymmetric JWT error",
    authorization: `Bearer ${jwtWithInvalidSignature("ES256")}`,
    code: "UNAUTHORIZED_ASYMMETRIC_JWT",
    message: "Invalid JWT",
  },
  {
    name: "returns the unsupported algorithm error",
    authorization: `Bearer ${jwtWithInvalidSignature("none")}`,
    code: "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM",
    message: "Unsupported JWT algorithm none",
  },
];

describe("stack Functions runtime config", () => {
  it("keeps runtime-owned Supabase values above shared and per-function env", () => {
    expect(
      Object.fromEntries(
        resolveFunctionEnvironment(
          {
            env: { SHARED: "shared", SUPABASE_URL: "shared-url" },
            supabaseUrl: "runtime-url",
            publishableKey: "runtime-publishable",
            secretKey: "runtime-secret",
            dbUrl: "runtime-db",
          },
          { SHARED: "function", SUPABASE_URL: "function-url" },
        ),
      ),
    ).toMatchObject({
      SHARED: "function",
      SUPABASE_URL: "runtime-url",
      SUPABASE_ANON_KEY: "runtime-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "runtime-secret",
      SUPABASE_DB_URL: "runtime-db",
    });
  });

  it("projects an explicit bundle without project discovery", async () => {
    const root = makeTempProject();
    const stackConfig = await resolveConfig({ functions: makeBundle(root) });
    const config = resolveFunctionsRuntimeConfig(
      stackConfig,
      { hostname: "127.0.0.1" },
      makeBundle(root),
    );

    expect(config?.env).toEqual({ SHARED: "shared-value", BUNDLE_ONLY: "bundle-value" });
    expect(config?.functions["hello-world"]).toEqual({
      verifyJWT: true,
      entrypointPath: join(root, "functions", "hello-world", "index.ts"),
      importMapPath: null,
      staticFiles: [join(root, "functions", "hello-world", "assets", "*")],
      env: { SHARED: "function-value", FUNCTION_ONLY: "function-value" },
    });

    await rm(root, { recursive: true, force: true });
  });

  it("validates paths, import maps, and unique function names", async () => {
    const decode = Schema.decodeUnknownSync(ResolvedFunctionsBundleSchema);
    const root = makeTempProject();
    const bundle = makeBundle(root);

    expect(decode(bundle).functions[0]?.importMapPath).toBeNull();
    expect(() =>
      decode({
        ...bundle,
        functions: [{ ...bundle.functions[0], entrypointPath: "./index.ts" }],
      }),
    ).toThrow("Expected an absolute path");
    expect(() =>
      decode({
        ...bundle,
        functions: [bundle.functions[0], bundle.functions[0]],
      }),
    ).toThrow("Duplicate function name: hello-world");

    await rm(root, { recursive: true, force: true });
  });

  it("keeps placeholder mode when no functions are supplied", async () => {
    const stackConfig = await resolveConfig({ functions: false });

    expect(
      resolveFunctionsRuntimeConfig(stackConfig, { hostname: "127.0.0.1" }, undefined),
    ).toBeUndefined();
    expect(
      resolveFunctionsRuntimeConfig(
        stackConfig,
        { hostname: "127.0.0.1" },
        {
          env: {},
          functions: [],
        },
      ),
    ).toBeUndefined();
  });

  it.live("atomically writes restrictive ephemeral config and removes it", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      const bundle = makeBundle(cwd);
      const stackConfig = yield* Effect.promise(() =>
        resolveConfig({ runtimeRoot: cwd, functions: bundle }),
      );
      yield* configureFunctionsRuntime(stackConfig, { hostname: "127.0.0.1" }, bundle);
      const filePath = functionsRuntimeConfigPath(stackConfig.runtimeRoot);
      const written = JSON.parse(yield* Effect.promise(() => readFile(filePath, "utf8"))) as {
        functions: Record<string, unknown>;
      };

      expect(Object.keys(written.functions)).toEqual(["hello-world"]);
      expect((yield* Effect.promise(() => stat(filePath))).mode & 0o777).toBe(0o600);
      expect(yield* Effect.promise(() => readdir(join(cwd, "edge-runtime")))).toEqual([
        "functions-runtime-config.json",
      ]);

      yield* clearFunctionsRuntimeConfig(stackConfig.runtimeRoot);
      expect(yield* Effect.promise(() => readdir(join(cwd, "edge-runtime")))).toEqual([]);
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.promise(() => rm(cwd, { recursive: true, force: true }))),
    );
  });
});

describe("stack Functions runtime auth", () => {
  const defaultVerificationJwks = resolveLocalCredentials(undefined).jwks;
  for (const { name, authorization, code, message } of authFailureCases) {
    it(name, async () => {
      const response = await verifyRequest(
        new Request("http://127.0.0.1/functions/v1/test", {
          headers: authorization === undefined ? undefined : { authorization },
        }),
        { verificationJwks: defaultVerificationJwks },
        { verifyJWT: true },
      );

      expect(response).not.toBeNull();
      if (response === null) return;

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("sb-error-code")).toBe(code);
      expect(response.headers.get("access-control-expose-headers")).toBe("sb-error-code");
      expect(await response.json()).toEqual({ code, message, msg: message });
    });
  }

  it("accepts a valid legacy JWT", async () => {
    const token = generateJwt(defaultJwtSecret, "anon");
    const response = await verifyRequest(
      new Request("http://127.0.0.1/functions/v1/test", {
        headers: { authorization: `Bearer ${token}` },
      }),
      { verificationJwks: defaultVerificationJwks },
      { verifyJWT: true },
    );

    expect(response).toBeNull();
  });

  it("accepts a lowercase bearer scheme", async () => {
    const token = generateJwt(defaultJwtSecret, "anon");
    const response = await verifyRequest(
      new Request("http://127.0.0.1/functions/v1/test", {
        headers: { authorization: `bearer ${token}` },
      }),
      { verificationJwks: defaultVerificationJwks },
      { verifyJWT: true },
    );

    expect(response).toBeNull();
  });

  it("verifies symmetric LocalCredentials through the secure runtime config", async () => {
    const fixture = await functionsAuthFixture();
    try {
      const response = await verifyRequest(
        new Request("http://127.0.0.1/functions/v1/test", {
          headers: { authorization: `Bearer ${fixture.token}` },
        }),
        fixture.runtimeConfig,
        { verifyJWT: true },
      );

      expect(response).toBeNull();
      expect(fixture.runtimeConfig).not.toHaveProperty("jwtSecret");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("selects and verifies the matching RS256 LocalCredentials key", async () => {
    const fixture = await functionsAuthFixture({
      _tag: "AsymmetricJwtKeys",
      legacySecret: defaultJwtSecret,
      keys: [localRs256Key()],
    });
    try {
      const response = await verifyRequest(
        new Request("http://127.0.0.1/functions/v1/test", {
          headers: { authorization: `Bearer ${fixture.token}` },
        }),
        fixture.runtimeConfig,
        { verifyJWT: true },
      );

      expect(response).toBeNull();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("selects and verifies the matching ES256 LocalCredentials key", async () => {
    const fixture = await functionsAuthFixture({
      _tag: "AsymmetricJwtKeys",
      legacySecret: defaultJwtSecret,
      keys: [localEs256Key],
    });
    try {
      const response = await verifyRequest(
        new Request("http://127.0.0.1/functions/v1/test", {
          headers: { authorization: `Bearer ${fixture.token}` },
        }),
        fixture.runtimeConfig,
        { verifyJWT: true },
      );

      expect(response).toBeNull();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
