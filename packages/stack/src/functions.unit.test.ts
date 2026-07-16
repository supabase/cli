import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveConfig } from "./createStack.ts";
import { defaultJwtSecret, generateJwt } from "./JwtGenerator.ts";
import {
  configureFunctionsRuntime,
  functionsRuntimeConfigPath,
  resolveFunctionsRuntimeConfig,
} from "./functions.ts";
import { verifyRequest } from "./services/edge-runtime-main.ts";

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "supabase-stack-functions-"));
}

async function writeProject(cwd: string) {
  await mkdir(join(cwd, "supabase", "functions", "hello-world"), { recursive: true });
  await mkdir(join(cwd, "supabase", "functions", "disabled-function"), { recursive: true });
  await writeFile(
    join(cwd, "supabase", "functions", "hello-world", "index.ts"),
    "Deno.serve(() => Response.json({ ok: true }));\n",
  );
  await writeFile(
    join(cwd, "supabase", "functions", "disabled-function", "index.ts"),
    "Deno.serve(() => Response.json({ disabled: true }));\n",
  );
  await writeFile(
    join(cwd, "supabase", ".env"),
    "CONFIG_ONLY=from-project-env\nSHARED=from-project-env\n",
  );
  await writeFile(
    join(cwd, "supabase", "functions", ".env"),
    "FILE_ONLY=from-functions-env\nSHARED=from-functions-env\n",
  );
  await writeFile(
    join(cwd, "supabase", "config.json"),
    JSON.stringify({
      functions: {
        "hello-world": {
          verify_jwt: true,
          env: {
            CONFIG_ONLY: "env(CONFIG_ONLY)",
            SHARED: "env(SHARED)",
          },
        },
        "disabled-function": {
          enabled: false,
        },
      },
    }),
  );
}

function jwtWithInvalidSignature(algorithm: string): string {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "test-user" })).toString("base64url");
  return `${header}.${payload}.invalid`;
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
  it.live("auto-detects enabled functions from projectDir", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProject(cwd));
      const stackConfig = yield* Effect.promise(() => resolveConfig({ projectDir: cwd }));
      const config = yield* resolveFunctionsRuntimeConfig(stackConfig, {
        hostname: "127.0.0.1",
      });

      expect(config).toBeDefined();
      expect(Object.keys(config!.functions)).toEqual(["hello-world"]);
      expect(config!.functions["hello-world"]).toEqual({
        verifyJWT: true,
        entrypointPath: join(cwd, "supabase", "functions", "hello-world", "index.ts"),
        importMapPath: "",
        staticFiles: [],
      });
      expect(config!.env).toMatchObject({
        FILE_ONLY: "from-functions-env",
        CONFIG_ONLY: "from-project-env",
        SHARED: "from-project-env",
      });
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.promise(() => rm(cwd, { recursive: true, force: true }))),
    );
  });

  it.live("supports explicit env files and disabling JWT verification", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProject(cwd));
      yield* Effect.promise(() => writeFile(join(cwd, "custom.env"), "FILE_ONLY=custom\n"));
      const stackConfig = yield* Effect.promise(() =>
        resolveConfig({
          projectDir: cwd,
          functions: {
            envFile: "custom.env",
            noVerifyJwt: true,
          },
        }),
      );
      const config = yield* resolveFunctionsRuntimeConfig(stackConfig, {
        hostname: "127.0.0.1",
      });

      expect(config!.env.FILE_ONLY).toBe("custom");
      expect(config!.functions["hello-world"]?.verifyJWT).toBe(false);
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.promise(() => rm(cwd, { recursive: true, force: true }))),
    );
  });

  it.live("keeps placeholder mode when Functions are disabled", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProject(cwd));
      const stackConfig = yield* Effect.promise(() =>
        resolveConfig({ projectDir: cwd, functions: false }),
      );
      const config = yield* resolveFunctionsRuntimeConfig(stackConfig, {
        hostname: "127.0.0.1",
      });

      expect(config).toBeUndefined();
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.promise(() => rm(cwd, { recursive: true, force: true }))),
    );
  });

  it.live("writes generated runtime config into the stack runtime directory", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProject(cwd));
      const stackConfig = yield* Effect.promise(() => resolveConfig({ projectDir: cwd }));
      yield* configureFunctionsRuntime(stackConfig, { hostname: "127.0.0.1" });
      const written = JSON.parse(
        yield* Effect.promise(() =>
          readFile(functionsRuntimeConfigPath(stackConfig.runtimeRoot), "utf8"),
        ),
      ) as { functions: Record<string, unknown> };

      expect(Object.keys(written.functions)).toEqual(["hello-world"]);
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.promise(() => rm(cwd, { recursive: true, force: true }))),
    );
  });
});

describe("stack Functions runtime auth", () => {
  for (const { name, authorization, code, message } of authFailureCases) {
    it(name, async () => {
      const response = await verifyRequest(
        new Request("http://127.0.0.1/functions/v1/test", {
          headers: authorization === undefined ? undefined : { authorization },
        }),
        { jwtSecret: defaultJwtSecret },
        { verifyJWT: true },
      );

      expect(response).not.toBeNull();
      if (response === null) return;

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("sb-error-code")).toBe(code);
      expect(await response.json()).toEqual({ code, message, msg: message });
    });
  }

  it("accepts a valid legacy JWT", async () => {
    const token = generateJwt(defaultJwtSecret, "anon");
    const response = await verifyRequest(
      new Request("http://127.0.0.1/functions/v1/test", {
        headers: { authorization: `Bearer ${token}` },
      }),
      { jwtSecret: defaultJwtSecret },
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
      { jwtSecret: defaultJwtSecret },
      { verifyJWT: true },
    );

    expect(response).toBeNull();
  });
});
