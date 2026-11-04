import { randomUUID } from "node:crypto";

import { BunServices } from "@effect/platform-bun";
import { Cause, Data, Effect, Exit, FileSystem, Layer, Path, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { describe, expect } from "vitest";

import { overrideStackPorts } from "../../../../../tests/helpers/cli.ts";
import { type LiveFixtures, test } from "../../../../../tests/helpers/live.ts";

const STACK_TIMEOUT_MS = 15 * 60_000;
const ALLOWED_ORIGIN = "https://app.example.com";
const BLOCKED_ORIGIN = "https://evil.example.com";

class GatewayCorsLiveError extends Data.TaggedError("GatewayCorsLiveError")<{
  readonly message: string;
}> {}

const functionSource = `const allowedOrigin = ${JSON.stringify(ALLOWED_ORIGIN)};
Deno.serve((req) => {
  const allowed = req.headers.get("Origin") === allowedOrigin;
  const headers = new Headers({ "Access-Control-Allow-Credentials": "true", Vary: "Origin" });
  if (allowed) headers.set("Access-Control-Allow-Origin", allowedOrigin);
  if (req.method === "OPTIONS") return new Response(null, { status: allowed ? 204 : 403, headers });
  return new Response("ok", { headers });
});
`;

const ApiKeysSchema = Schema.Array(
  Schema.Struct({ api_key: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
);
const StackStartSchema = Schema.Struct({
  id: Schema.String,
  env: Schema.Struct({ API_URL: Schema.String, PUBLISHABLE_KEY: Schema.String }),
});

const recordedHeaders = [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
] as const;

interface Probe {
  readonly name: string;
  readonly method: "GET" | "OPTIONS" | "POST";
  readonly path: string;
  readonly headers: Record<string, string>;
}

function gatewayProbes(slug: string, jwtSlug: string, key: string): ReadonlyArray<Probe> {
  const preflight = {
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization, content-type",
  };
  const auth = { apikey: key, Authorization: `Bearer ${key}` };
  return [
    {
      name: "OPTIONS function, blocked origin",
      method: "OPTIONS",
      path: `/functions/v1/${slug}`,
      headers: { Origin: BLOCKED_ORIGIN, ...preflight },
    },
    {
      name: "OPTIONS function, allowed origin",
      method: "OPTIONS",
      path: `/functions/v1/${slug}`,
      headers: { Origin: ALLOWED_ORIGIN, ...preflight },
    },
    {
      name: "POST function, blocked origin",
      method: "POST",
      path: `/functions/v1/${slug}`,
      headers: { Origin: BLOCKED_ORIGIN, ...auth },
    },
    {
      name: "POST function, allowed origin",
      method: "POST",
      path: `/functions/v1/${slug}`,
      headers: { Origin: ALLOWED_ORIGIN, ...auth },
    },
    {
      name: "POST missing function",
      method: "POST",
      path: `/functions/v1/${slug}-missing`,
      headers: { Origin: BLOCKED_ORIGIN, ...auth },
    },
    {
      name: "OPTIONS missing function",
      method: "OPTIONS",
      path: `/functions/v1/${slug}-missing`,
      headers: { Origin: BLOCKED_ORIGIN, ...preflight },
    },
    {
      name: "POST verify_jwt function, invalid Bearer",
      method: "POST",
      path: `/functions/v1/${jwtSlug}`,
      headers: { Origin: BLOCKED_ORIGIN, apikey: key, Authorization: "Bearer invalid" },
    },
    {
      name: "OPTIONS /rest/v1/, foreign origin",
      method: "OPTIONS",
      path: "/rest/v1/",
      headers: { Origin: BLOCKED_ORIGIN, "Access-Control-Request-Method": "GET" },
    },
    {
      name: "OPTIONS /rest/v1/ with request headers, foreign origin",
      method: "OPTIONS",
      path: "/rest/v1/cors_probe_missing",
      headers: {
        Origin: BLOCKED_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, x-custom-header",
      },
    },
    {
      name: "GET missing table, foreign origin",
      method: "GET",
      path: "/rest/v1/cors_probe_missing",
      headers: { Origin: BLOCKED_ORIGIN, ...auth },
    },
  ];
}

const runProbes = (baseUrl: string, probes: ReadonlyArray<Probe>) =>
  Effect.forEach(probes, (probe) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.make(probe.method)(`${baseUrl}${probe.path}`).pipe(
          HttpClientRequest.setHeaders(probe.headers),
        ),
      );
      yield* response.text;
      return {
        probe: probe.name,
        status: response.status,
        ...Object.fromEntries(
          recordedHeaders.map((name) => [name, response.headers[name] ?? null]),
        ),
      };
    }),
  );

const requireSuccess = (
  result: { exitCode: number; stdout: string; stderr: string },
  step: string,
) =>
  result.exitCode === 0
    ? Effect.succeed(result.stdout)
    : Effect.fail(
        new GatewayCorsLiveError({
          message: `${step} failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`,
        }),
      );

const stackEnv = { SUPABASE_EXPERIMENTAL_STACK: "1" };

function startStack(cliEffect: LiveFixtures["cliEffect"]) {
  return Effect.acquireRelease(
    cliEffect(["stack", "start", "--runtime", "docker", "--eager", "--output-format", "json"], {
      env: stackEnv,
      exitTimeoutMs: STACK_TIMEOUT_MS,
    }).pipe(
      Effect.flatMap((result) => requireSuccess(result, "stack start")),
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(StackStartSchema))),
    ),
    (stack) =>
      cliEffect(["stack", "destroy", "--stack-id", stack.id, "--yes"], { env: stackEnv }).pipe(
        Effect.flatMap((result) => requireSuccess(result, "stack destroy")),
        Effect.orDie,
      ),
  );
}

function deployFunctions(cliEffect: LiveFixtures["cliEffect"], ref: string, slugs: string[]) {
  const deleteAll = Effect.forEach(slugs, (slug) =>
    cliEffect(["functions", "delete", slug, "--yes", `--remote=${ref}`]).pipe(
      Effect.flatMap((result) =>
        /not found|does not exist/iu.test(`${result.stdout}\n${result.stderr}`)
          ? Effect.void
          : requireSuccess(result, `functions delete ${slug}`),
      ),
      Effect.exit,
    ),
  ).pipe(
    Effect.flatMap((exits) => {
      const failures = exits.filter(Exit.isFailure);
      return failures.length === 0
        ? Effect.void
        : Effect.die(new AggregateError(failures.map((exit) => Cause.squash(exit.cause))));
    }),
  );
  return Effect.acquireRelease(Effect.void, () => deleteAll).pipe(
    Effect.andThen(cliEffect(["functions", "deploy", "--yes", `--remote=${ref}`])),
    Effect.flatMap((result) => requireSuccess(result, "functions deploy")),
  );
}

describe("stack gateway CORS (live)", () => {
  test(
    "answers function and REST probes like the platform gateway",
    { timeout: STACK_TIMEOUT_MS * 2 },
    ({ cliEffect, project, workspace }) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const suffix = randomUUID().slice(0, 8);
            const slug = `cors-probe-${suffix}`;
            const jwtSlug = `cors-probe-jwt-${suffix}`;
            for (const name of [slug, jwtSlug]) {
              const directory = path.join(workspace.path, "supabase", "functions", name);
              yield* fs.makeDirectory(directory, { recursive: true });
              yield* fs.writeFileString(path.join(directory, "index.ts"), functionSource);
            }
            const configPath = path.join(workspace.path, "supabase", "config.toml");
            yield* Effect.promise(() => overrideStackPorts(workspace.path));
            const config = yield* fs.readFileString(configPath);
            yield* fs.writeFileString(
              configPath,
              `${config.replace("[experimental]\n", "[experimental]\nstack = true\n")}\n[functions.${slug}]\nverify_jwt = false\n\n[functions.${jwtSlug}]\nverify_jwt = true\n`,
            );

            const keys = yield* cliEffect([
              "projects",
              "api-keys",
              "--output",
              "json",
              `--remote=${project.ref}`,
            ]).pipe(
              Effect.flatMap((result) => requireSuccess(result, "projects api-keys")),
              Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ApiKeysSchema))),
            );
            const publishableKey = keys
              .map((key) => key.api_key)
              .find((key) => key?.startsWith("sb_publishable_"));
            if (publishableKey == null) {
              return yield* new GatewayCorsLiveError({ message: "no publishable key on project" });
            }
            const stagingUrl = project.functionsUrl.replace(/\/functions\/v1$/u, "");

            yield* deployFunctions(cliEffect, project.ref, [slug, jwtSlug]);
            const probes = gatewayProbes(slug, jwtSlug, publishableKey);
            const readiness = probes.filter(
              (probe) => probe.name === "POST function, allowed origin",
            );
            // A fresh deploy can briefly answer 404 before the edge picks it up.
            yield* runProbes(stagingUrl, readiness).pipe(
              Effect.filterOrFail(
                (rows) => rows[0]?.status === 200,
                (rows) =>
                  new GatewayCorsLiveError({
                    message: `function not ready: ${JSON.stringify(rows[0])}`,
                  }),
              ),
              Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
            );
            const staging = yield* runProbes(stagingUrl, probes);

            const stack = yield* startStack(cliEffect);
            const local = yield* runProbes(
              stack.env.API_URL,
              gatewayProbes(slug, jwtSlug, stack.env.PUBLISHABLE_KEY),
            );

            expect(local).toEqual(staging);
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              BunServices.layer,
              FetchHttpClient.layer,
              Layer.succeed(HttpClient.TracerPropagationEnabled, false),
            ),
          ),
        ),
      ),
  );
});
