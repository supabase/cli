import { expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Schema } from "effect";

import { makeTempHome, requireCliSuccess, runSupabaseEffect } from "../../../tests/helpers/cli.ts";

const ACCESS_TOKEN = `sbp_${"a".repeat(40)}`;
const PROFILE = {
  gotrue_id: "5a5c1690-8f6f-4b95-b76c-97b80a8868fc",
  primary_email: "person@example.com",
  username: "person",
};

it.live("shows the authenticated profile through the CLI", () =>
  Effect.gen(function* () {
    let request:
      | {
          readonly method: string;
          readonly pathname: string;
          readonly authorization: string | null;
        }
      | undefined;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(incoming) {
            const url = new URL(incoming.url);
            if (incoming.method === "GET" && url.pathname === "/v1/profile") {
              request = {
                method: incoming.method,
                pathname: url.pathname,
                authorization: incoming.headers.get("authorization"),
              };
              return Response.json(PROFILE);
            }
            return new Response("not found", { status: 404 });
          },
        }),
      ),
      (running) => Effect.promise(() => running.stop(true)),
    );
    const home = yield* Effect.acquireRelease(
      Effect.sync(() => makeTempHome()),
      (owned) => Effect.sync(() => owned[Symbol.dispose]()),
    );

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const profilePath = path.join(home.dir, "whoami-profile.yaml");
    yield* fs.writeFileString(
      profilePath,
      [
        "name: whoami-e2e",
        `api_url: "${server.url.origin}"`,
        `dashboard_url: "${server.url.origin}"`,
        'project_host: "example.invalid"',
        "",
      ].join("\n"),
    );

    const result = yield* runSupabaseEffect(["whoami", "--output-format", "json"], {
      cwd: home.dir,
      home: home.dir,
      env: {
        SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN,
        SUPABASE_PROFILE: profilePath,
        SUPABASE_WORKDIR: home.dir,
      },
    });

    requireCliSuccess(result, "whoami --output-format json");
    const payload: unknown = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      result.stdout,
    );
    expect(payload, result.stderr).toEqual({
      id: PROFILE.gotrue_id,
      email: PROFILE.primary_email,
      username: PROFILE.username,
    });
    expect(request).toEqual({
      method: "GET",
      pathname: "/v1/profile",
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
