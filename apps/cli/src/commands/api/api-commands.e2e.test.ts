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

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeLines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => decodeJson(line));

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

it.live("warehouse status prints the consolidated status as text when stdout is piped", () =>
  Effect.gen(function* () {
    const response = json(200, {
      data: {
        type: "warehouse_context",
        id: REF,
        attributes: {
          enabled: true,
          status: "ready",
          configured_readiness: "ready",
          query_connectivity: "not_checked",
          tables: { status: "available", items: [] },
          replication: { status: "not_started", apply_lag: null },
          capabilities: { replication_add: false, replication_remove: false },
        },
      },
    });
    const { result, requests } = yield* runWarehouse(["status"], () => response);

    requireCliSuccess(result, "warehouse status");
    expect(result.stdout).toBe(
      [
        "Warehouse context",
        `  ID                    ${REF}`,
        "  Enabled               yes",
        "  Status                ready",
        "  Configured readiness  ready",
        "  Query connectivity    not_checked",
        "  Tables",
        "    Status  available",
        "    Items   -",
        "  Replication",
        "    Status     not_started",
        "    Apply lag  -",
        "  Capabilities",
        "    Replication add     no",
        "    Replication remove  no",
        "",
      ].join("\n"),
    );
    expect(requests).toEqual([`GET /v2/projects/${REF}/warehouse/status`]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("warehouse enable --wait --output-format stream-json logs progress before the result", () =>
  Effect.gen(function* () {
    const accepted = json(202, { data: { attributes: { selection_id: SEL } } });
    const { result } = yield* runWarehouse(
      ["enable", "--schema", "public", "--wait", "--yes", "--output-format", "stream-json"],
      (request) => (request.method === "POST" ? accepted : statusBody("succeeded")),
    );

    requireCliSuccess(result, "warehouse enable --wait stream-json");
    const frames = decodeLines(result.stdout) as ReadonlyArray<{ type: string }>;
    expect(frames.at(-1)).toEqual({
      type: "result",
      data: decodeJson(accepted.body),
      timestamp: expect.any(String),
    });
    expect(frames.filter((frame) => frame.type === "result")).toHaveLength(1);
    expect(frames.slice(0, -1).every((frame) => frame.type === "log")).toBe(true);
    expect(frames.length).toBeGreaterThan(1);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("warehouse enable --file - reads the request body piped on stdin", () =>
  Effect.gen(function* () {
    const accepted = `{"data":{"type":"warehouse_setup","attributes":{"selection_id":"${SEL}","status":"pending","future_field":{"nested":[1, 2]}}}}`;
    const body = '{"data":{"type":"warehouse_setup","attributes":{"schema":"public"}}}';
    const { result, requests, bodies } = yield* runWarehouse(
      ["enable", "--file", "-", "--yes", "--output-format", "json"],
      () => ({ status: 202, body: accepted }),
      { stdin: body },
    );

    requireCliSuccess(result, "warehouse enable --file -");
    expect(result.stdout, result.stderr).toBe(accepted);
    expect(requests).toEqual([`POST ${ENABLE_PATH}`]);
    expect(decodeJson(bodies[0] ?? "")).toEqual(decodeJson(body));
  }).pipe(Effect.provide(BunServices.layer)),
);
