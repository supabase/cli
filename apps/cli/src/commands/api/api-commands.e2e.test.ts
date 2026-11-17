import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Data, Effect, FileSystem, Path, Schema } from "effect";

import { makeTempHome, requireCliSuccess, runSupabaseEffect } from "../../../tests/helpers/cli.ts";

class ApiCommandsE2eSetupError extends Data.TaggedError("ApiCommandsE2eSetupError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

const REF = "abcdefghijklmnopqrst";
const ACCESS_TOKEN = `sbp_${"a".repeat(40)}`;
const SEL = "ab".repeat(32);
const ENABLE_PATH = `/v2/projects/${REF}/warehouse/enable`;
const STATUS_PATH = `/v2/projects/${REF}/warehouse/setups/current`;

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface Served {
  readonly status: number;
  readonly body: string;
}

const json = (status: number, body: unknown): Served => ({
  status,
  body: JSON.stringify(body),
});

const statusBody = (state: string) =>
  json(200, {
    data: { type: "warehouse_setup", attributes: { selection_id: SEL, status: state } },
  });

/**
 * Runs the compiled CLI against a local Management API that answers `route`; the project
 * lookup every `--remote` run makes is answered here.
 */
const runWarehouse = (
  args: ReadonlyArray<string>,
  route: (request: { readonly method: string; readonly pathname: string }) => Served,
  options: { readonly stdin?: string } = {},
) =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const bodies: Array<string> = [];
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (incoming) =>
              runPromise(
                Effect.gen(function* () {
                  const { pathname } = new URL(incoming.url);
                  if (pathname === `/v1/projects/${REF}`) return Response.json({});
                  requests.push(`${incoming.method} ${pathname}`);
                  bodies.push(yield* Effect.promise(() => incoming.text()));
                  const served = route({ method: incoming.method, pathname });
                  return new Response(served.body, {
                    status: served.status,
                    headers: { "content-type": "application/json" },
                  });
                }),
              ),
          }),
        catch: (cause) => new ApiCommandsE2eSetupError({ cause }),
      }),
      (running) => Effect.promise(() => running.stop(true)),
    );
    const home = yield* makeTempHome.pipe(
      Effect.mapError((cause) => new ApiCommandsE2eSetupError({ cause })),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const profilePath = path.join(home.dir, "api-commands-profile.yaml");
    yield* fs.writeFileString(
      profilePath,
      [
        "name: api-commands-e2e",
        `api_url: "${server.url.origin}"`,
        `dashboard_url: "${server.url.origin}"`,
        'project_host: "example.invalid"',
        "",
      ].join("\n"),
    );
    const result = yield* runSupabaseEffect(["warehouse", ...args, `--remote=${REF}`], {
      cwd: home.dir,
      home: home.dir,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      env: {
        SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN,
        SUPABASE_EXPERIMENTAL_WAREHOUSE: "1",
        SUPABASE_NO_KEYRING: "1",
        SUPABASE_PROFILE: profilePath,
        SUPABASE_TELEMETRY_DISABLED: "1",
        SUPABASE_WORKDIR: home.dir,
        SUPABASE_YES: undefined,
      },
    });
    return { result, requests, bodies };
  }).pipe(Effect.scoped);

it.live("warehouse status reports a 409 as a conflict failure document on stderr", () =>
  Effect.gen(function* () {
    const { result } = yield* runWarehouse(["status", "-o", "json"], () =>
      json(409, {
        error: {
          code: "selection_conflict",
          message: "The selection changed",
          description: "Re-run enable.",
        },
      }),
    );

    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    const lastLine = result.stderr.trimEnd().split("\n").at(-1) ?? "";
    expect(decodeJson(lastLine)).toMatchObject({
      code: "conflict",
      status: 409,
      api_code: "selection_conflict",
      message: expect.stringContaining("The selection changed"),
    });
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("warehouse status keeps the API bytes when stdout is piped", () =>
  Effect.gen(function* () {
    const { result } = yield* runWarehouse(["status"], () => statusBody("succeeded"));

    requireCliSuccess(result, "warehouse status");
    expect(result.stdout, result.stderr).toBe(statusBody("succeeded").body);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("warehouse status --output-format text renders the response for people", () =>
  Effect.gen(function* () {
    const { result } = yield* runWarehouse(["status", "--output-format", "text"], () =>
      statusBody("succeeded"),
    );

    requireCliSuccess(result, "warehouse status --output-format text");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      result.stdout.endsWith(
        `Warehouse setup\n  Selection ID  ${SEL}\n  Status        succeeded\n`,
      ),
    ).toBe(true);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("warehouse enable without --yes refuses to run when stdin is piped", () =>
  Effect.gen(function* () {
    const { result, requests } = yield* runWarehouse(
      ["enable", "--schema", "public", "-o", "json"],
      () => json(202, {}),
      { stdin: "" },
    );

    expect(result.exitCode, result.stderr).toBe(2);
    expect(result.stdout).toBe("");
    const lastLine = result.stderr.trimEnd().split("\n").at(-1) ?? "";
    expect(decodeJson(lastLine)).toMatchObject({
      code: "usage_error",
      hint: expect.stringContaining("Pass --yes"),
    });
    expect(requests).toEqual([]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("warehouse enable --wait prints the final status read", () =>
  Effect.gen(function* () {
    const { result, requests } = yield* runWarehouse(
      ["enable", "--schema", "public", "--yes", "--wait", "--timeout", "30s", "-o", "json"],
      ({ method }) => {
        if (method === "POST") return json(202, { data: { attributes: { selection_id: SEL } } });
        return statusBody("succeeded");
      },
    );

    requireCliSuccess(result, "warehouse enable --wait");
    expect(result.stdout, result.stderr).toBe(statusBody("succeeded").body);
    expect(requests).toEqual([`POST ${ENABLE_PATH}`, `GET ${STATUS_PATH}`]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("warehouse enable --file - reads the request body piped on stdin", () =>
  Effect.gen(function* () {
    const accepted = `{"data":{"type":"warehouse_setup","attributes":{"selection_id":"${SEL}","status":"pending","future_field":{"nested":[1, 2]}}}}`;
    const body = '{"data":{"type":"warehouse_setup","attributes":{"schema":"public"}}}';
    const { result, requests, bodies } = yield* runWarehouse(
      ["enable", "--file", "-", "--yes", "-o", "json"],
      () => ({ status: 202, body: accepted }),
      { stdin: body },
    );

    requireCliSuccess(result, "warehouse enable --file -");
    expect(result.stdout, result.stderr).toBe(accepted);
    expect(requests).toEqual([`POST ${ENABLE_PATH}`]);
    expect(decodeJson(bodies[0] ?? "")).toEqual(decodeJson(body));
  }).pipe(Effect.provide(BunServices.layer)),
);
