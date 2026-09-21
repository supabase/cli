import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import type { Stack } from "@supabase/stack/effect";
import { streamPgDumpWithClient, transformManagedDumpLine } from "./pg-dump.run.ts";
import { NetworkIdFlag } from "./global-flags.ts";
import { DockerRun } from "./docker-run.service.ts";
import { BundledPostgresClient } from "./bundled-postgres-client.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";

const stackFixture = (output: string) => {
  const calls: Array<{ readonly args: ReadonlyArray<string>; readonly command: string }> = [];
  const stack = {
    tools: {
      run: (
        _tool: { readonly command: string },
        options: {
          readonly args?: ReadonlyArray<string>;
          readonly stdout: (bytes: Uint8Array) => Effect.Effect<void>;
        },
      ) =>
        Effect.gen(function* () {
          calls.push({ command: _tool.command, args: options.args ?? [] });
          yield* options.stdout(new TextEncoder().encode(output));
          return { jobId: "job", exitCode: 0 };
        }),
    },
  } as unknown as Stack;
  return { stack, calls };
};

describe("managed pg_dump runner", () => {
  it("keeps the managed dump filters equivalent to the CLI scripts", () => {
    const cases = [
      [
        'CREATE TABLE "public" (id integer);',
        "pg_dump --schema-only",
        {},
        'CREATE TABLE IF NOT EXISTS "public" (id integer);',
      ],
      ["\\unrestrict 123", "pg_dump --data-only", {}, "-- \\unrestrict 123"],
      ["--user-data", "pg_dump --data-only", { EXTRA_SED: "/^--/d" }, "--user-data"],
      ["\\restrict 123", "pg_dumpall --roles-only", { EXTRA_SED: "/^--/d" }, undefined],
      [
        'CREATE ROLE "postgres";',
        "pg_dumpall --roles-only",
        { RESERVED_ROLES: "postgres" },
        '-- CREATE ROLE "postgres";',
      ],
      [
        'ALTER ROLE "postgres" SET "statement_timeout" TO "5s";',
        "pg_dumpall --roles-only",
        { ALLOWED_CONFIGS: "statement_timeout" },
        'ALTER ROLE "postgres" SET "statement_timeout" TO "5s";',
      ],
      [
        '-- ALTER ROLE "postgres" SET "pgrst.db_schemas" TO "public";',
        "pg_dumpall --roles-only",
        { ALLOWED_CONFIGS: "pgrst.*", EXTRA_SED: "/^--/d" },
        'ALTER ROLE "postgres" SET "pgrst.db_schemas" TO "public";',
      ],
      [
        'GRANT "member" TO "dashboard_user";',
        "pg_dumpall --roles-only",
        { RESERVED_ROLES: "dashboard_user", EXTRA_SED: "/^--/d" },
        undefined,
      ],
      [
        'CREATE EXTENSION IF NOT EXISTS "pg_tle" WITH SCHEMA "pgtle";',
        "pg_dump --schema-only",
        {},
        'CREATE EXTENSION IF NOT EXISTS "pg_tle";',
      ],
      [
        'GRANT SELECT ON TABLE "public"."storage" TO "anon";',
        "pg_dump --schema-only",
        { EXCLUDED_SCHEMAS: "storage" },
        'GRANT SELECT ON TABLE "public"."storage" TO "anon";',
      ],
      [
        'REVOKE SELECT ON TABLE "storage" FROM "anon";',
        "pg_dump --schema-only",
        { EXCLUDED_SCHEMAS: "storage" },
        '-- REVOKE SELECT ON TABLE "storage" FROM "anon";',
      ],
      [
        'GRANT ALL ON FOREIGN DATA WRAPPER "wrapper" TO "authenticated";',
        "pg_dump --schema-only",
        {},
        'GRANT ALL ON FOREIGN DATA WRAPPER "wrapper" TO "authenticated";',
      ],
      [
        'GRANT ALL ON FOREIGN DATA WRAPPER "wrapper" TO "postgres" WITH GRANT OPTION;',
        "pg_dump --schema-only",
        {},
        '-- GRANT ALL ON FOREIGN DATA WRAPPER "wrapper" TO "postgres" WITH GRANT OPTION;',
      ],
    ] as const;

    for (const [input, script, env, expected] of cases)
      expect(transformManagedDumpLine(input, script, env)).toBe(expected);
  });

  it.live("keeps data dump filters and quoted extra flags in the Stack tool arguments", () => {
    const fixture = stackFixture("\\unrestrict 123\n");
    return streamPgDumpWithClient({
      image: "unused",
      script: "pg_dump --data-only",
      env: {
        PGHOST: "127.0.0.1",
        PGPORT: "54322",
        PGUSER: "postgres",
        PGDATABASE: "postgres",
        EXTRA_FLAGS: '--exclude-table "public"."Users"',
      },
      onStdout: () => Effect.void,
      client: { kind: "stack", stack: fixture.stack, command: "pg_dump", major: 17 },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          Layer.succeed(NetworkIdFlag, Option.none()),
          Layer.succeed(RuntimeInfo, {
            cwd: "/tmp",
            platform: "linux",
            arch: "x64",
            homeDir: "/tmp",
            execPath: "/usr/bin/bun",
            pid: 1,
          }),
          Layer.succeed(BundledPostgresClient, { run: () => Effect.die("unused") }),
          Layer.succeed(DockerRun, {
            run: () => Effect.die("unused"),
            runCapture: () => Effect.die("unused"),
            runStream: () => Effect.die("unused"),
          }),
          mockOutput().layer,
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(fixture.calls[0]?.args).toContain("--exclude-table");
          expect(fixture.calls[0]?.args).toContain('"public"."Users"');
        }),
      ),
    );
  });

  it.live("preserves schema filtering while streaming through the Stack tool", () => {
    const fixture = stackFixture(
      'CREATE TABLE "public" (id integer);\nGRANT ALL ON TABLE "auth" TO "postgres";\n',
    );
    const chunks: Array<Uint8Array> = [];
    expect(
      transformManagedDumpLine(
        'GRANT ALL ON TABLE "auth" TO "postgres";',
        "pg_dump --schema-only",
        { EXCLUDED_SCHEMAS: "auth|storage" },
      ),
    ).toContain("-- GRANT");
    return streamPgDumpWithClient({
      image: "unused",
      script: "pg_dump --schema-only",
      env: {
        PGHOST: "127.0.0.1",
        PGPORT: "54322",
        PGUSER: "postgres",
        PGDATABASE: "postgres",
        EXCLUDED_SCHEMAS: "auth|storage",
      },
      onStdout: (bytes) =>
        Effect.sync(() => {
          chunks.push(bytes);
        }),
      client: { kind: "stack", stack: fixture.stack, command: "pg_dump", major: 17 },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          Layer.succeed(NetworkIdFlag, Option.none()),
          Layer.succeed(RuntimeInfo, {
            cwd: "/tmp",
            platform: "linux",
            arch: "x64",
            homeDir: "/tmp",
            execPath: "/usr/bin/bun",
            pid: 1,
          }),
          Layer.succeed(BundledPostgresClient, { run: () => Effect.die("unused") }),
          Layer.succeed(DockerRun, {
            run: () => Effect.die("unused"),
            runCapture: () => Effect.die("unused"),
            runStream: () => Effect.die("unused"),
          }),
          mockOutput().layer,
        ),
      ),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.sync(() => {
          expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
          const output = new TextDecoder().decode(
            Uint8Array.from(chunks.flatMap((chunk) => [...chunk])),
          );
          expect(output).toContain('CREATE TABLE IF NOT EXISTS "public"');
          expect(output).toContain('-- GRANT ALL ON TABLE "auth"');
          expect(fixture.calls[0]?.args).toContain("--exclude-schema");
        }),
      ),
    );
  });
});
