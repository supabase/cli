import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
} from "../../../../../../tests/helpers/command-mocks.ts";
import type { ApiHandler } from "../../../../../../tests/helpers/command-mocks.ts";
import { withSparkProjectRead } from "../../../../../../tests/helpers/spark-project-handler.ts";
import { mockOutput, mockStdin } from "../../../../../../tests/helpers/mocks.ts";
import { YesFlag } from "../../../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../../../command-internal/target/target-policy.ts";
import type { OutputFormat } from "../../../../../shared/output/types.ts";
import { sparkMigrationFetch } from "./fetch.handler.ts";

const REF = "abcdefghijklmnopqrst";

const HISTORY = JSON.stringify([
  { version: "20260101000000", name: "todos", sql: "create table public.todos (id bigint)" },
  {
    version: "20260202000000",
    name: "add_labels",
    sql: "create table public.labels (\n  id bigint primary key\n);\ncreate index labels_id on public.labels (id)",
  },
]);

const answer =
  (body: string, status = 201): ApiHandler =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })));

const workdir = useTempWorkdir("spark-migration-fetch-");

function setup(opts: {
  readonly body: string;
  readonly format?: OutputFormat;
  readonly pipedAnswer?: string;
}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({ handler: withSparkProjectRead(answer(opts.body)) });
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: workdir.current }),
      stdin: mockStdin(false, opts.pipedAnswer),
    }),
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "none" }),
    Layer.succeed(YesFlag, false),
  );
  return { layer, out, api };
}

const linked = {
  remote: Option.some({ _tag: "Ref", ref: REF } as const),
  linked: false,
  projectRef: Option.none<string>(),
};

const migrationFile = Effect.fnUntraced(function* (name: string) {
  const path = yield* Path.Path;
  return path.join(workdir.current, "supabase", "migrations", name);
});

const writeLocalMigration = Effect.fnUntraced(function* (name: string, sql: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* migrationFile(name);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, sql);
});

const readLocalMigration = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(yield* migrationFile(name));
});

describe("spark migration fetch integration", () => {
  it.effect("writes one file per history row, read with a read-only query on the project", () => {
    const { layer, out, api } = setup({ body: HISTORY, format: "json" });
    return Effect.gen(function* () {
      yield* sparkMigrationFetch(linked);

      expect(api.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
        `GET /v1/projects/${REF}`,
        `POST /v1/projects/${REF}/database/query`,
      ]);
      expect(api.requests[1]?.body).toMatchObject({ read_only: true });
      expect(yield* readLocalMigration("20260101000000_todos.sql")).toBe(
        "create table public.todos (id bigint);\n",
      );
      expect(yield* readLocalMigration("20260202000000_add_labels.sql")).toBe(
        "create table public.labels (\n  id bigint primary key\n);\ncreate index labels_id on public.labels (id);\n",
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migration history fetched",
          data: {
            files: [
              yield* migrationFile("20260101000000_todos.sql"),
              yield* migrationFile("20260202000000_add_labels.sql"),
            ],
          },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("declining the overwrite prompt reads no history and keeps the local file", () => {
    const { layer, api } = setup({ body: HISTORY, pipedAnswer: "n\n" });
    return Effect.gen(function* () {
      yield* writeLocalMigration("20260101000000_todos.sql", "-- written by hand\n");

      const exit = yield* sparkMigrationFetch(linked).pipe(Effect.exit);

      expect(String(exit)).toContain("OperationCanceledError");
      expect(api.requests.map((r) => r.method)).toEqual(["GET"]);
      expect(yield* readLocalMigration("20260101000000_todos.sql")).toBe("-- written by hand\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails on a history answer that is not rows of version, name and sql", () => {
    const { layer } = setup({ body: '[{"version":20260101000000,"name":"todos"}]' });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const exit = yield* sparkMigrationFetch(linked).pipe(Effect.exit);

      expect(String(exit)).toContain("unexpected migration history response");
      expect(yield* fs.exists(yield* migrationFile("20260101000000_todos.sql"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
