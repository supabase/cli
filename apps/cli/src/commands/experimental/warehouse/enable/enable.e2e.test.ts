import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Data, Effect, FileSystem, Path, Schema } from "effect";
import {
  makeTempHome,
  requireCliSuccess,
  runSupabaseEffect,
} from "../../../../../tests/helpers/cli.ts";

class WarehouseServerError extends Data.TaggedError("WarehouseServerError")<{
  readonly cause: unknown;
}> {}

it.live("enables Warehouse through the compiled CLI and keeps JSON stdout clean", () =>
  Effect.gen(function* () {
    const ref = "abcdefghijklmnopqrst";
    const tables = [{ id: 1234, schema: "public", name: "orders" }];
    const requests: string[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              const path = new URL(request.url).pathname;
              if (!path.startsWith(`/v2/projects/${ref}/warehouse/`))
                return new Response("not found", { status: 404 });
              requests.push(`${request.method} ${path}`);
              if (request.method === "POST")
                return Response.json(
                  {
                    data: {
                      type: "warehouse_setup",
                      id: ref,
                      attributes: {
                        accepted: true,
                        selection_id: "a".repeat(64),
                        selected_tables: tables,
                        pipeline_id: "101",
                        tables: [],
                      },
                    },
                  },
                  { status: 202 },
                );
              return Response.json({
                data: {
                  type: "warehouse_setup",
                  id: ref,
                  attributes: {
                    status: "succeeded",
                    setup_status: "complete",
                    replication_state: "streaming",
                    tables: tables.map((table) => ({
                      ...table,
                      state: "live",
                      replication_state: "following_wal",
                      copy_name: "public.orders",
                    })),
                    dns: {
                      status: "ready",
                      hostname: "warehouse.example.com",
                      region: "eu-west-1",
                    },
                    steps: [],
                    fdw_status: null,
                  },
                },
              });
            },
          }),
        catch: (cause) => new WarehouseServerError({ cause }),
      }),
      (running) => Effect.promise(() => running.stop(true)),
    );
    const home = yield* makeTempHome;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const profile = path.join(home.dir, "profile.yaml");
    yield* fs.writeFileString(
      profile,
      `name: warehouse-e2e\napi_url: ${server.url.origin}\ndashboard_url: ${server.url.origin}\nproject_host: example.invalid\n`,
    );
    const gated = yield* runSupabaseEffect(
      ["warehouse", "enable", "--schema", "public", `--remote=${ref}`, "--yes"],
      {
        cwd: home.dir,
        home: home.dir,
        env: {
          SUPABASE_PROFILE: profile,
          SUPABASE_WORKDIR: home.dir,
          SUPABASE_EXPERIMENTAL_WAREHOUSE: "1",
          SUPABASE_EXPERIMENTAL: "0",
        },
      },
    );
    expect(gated.exitCode, gated.stderr).toBe(2);
    expect(gated.stderr).toContain("must set the --experimental flag");
    expect(requests).toEqual([]);
    const result = yield* runSupabaseEffect(
      [
        "warehouse",
        "enable",
        "--schema",
        "public",
        `--remote=${ref}`,
        "--wait",
        "--experimental",
        "--table",
        "orders",
        "--yes",
        "--output-format",
        "json",
      ],
      {
        cwd: home.dir,
        home: home.dir,
        env: {
          SUPABASE_ACCESS_TOKEN: `sbp_${"a".repeat(40)}`,
          SUPABASE_PROFILE: profile,
          SUPABASE_WORKDIR: home.dir,
          SUPABASE_EXPERIMENTAL_WAREHOUSE: "1",
        },
      },
    );
    requireCliSuccess(result, "warehouse enable");
    const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      result.stdout,
    );
    expect(payload, result.stderr).toMatchObject({
      data: {
        type: "warehouse_setup",
        id: ref,
        attributes: { status: "succeeded", replication_state: "streaming" },
      },
    });
    expect(requests).toEqual([
      `POST /v2/projects/${ref}/warehouse/enable`,
      `GET /v2/projects/${ref}/warehouse/setups/current`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
