import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Stack } from "@supabase/stack/effect";
import { streamPgDumpWithClient, transformManagedDumpLine } from "./pg-dump.run.ts";
import { dumpRoleScript } from "./pg-dump.scripts.ts";
import { expandScript } from "./pg-dump.env.ts";
import { NetworkIdFlag } from "./global-flags.ts";
import { DockerRun } from "./docker-run.service.ts";
import { BundledPostgresClient } from "./bundled-postgres-client.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { selection } from "../../tests/helpers/pins.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";

const stackFixture = (output: string | ReadonlyArray<Uint8Array>) => {
  const calls: Array<{ readonly args: ReadonlyArray<string>; readonly command: string }> = [];
  const stack = {
    commands: {
      run: (
        _tool: { readonly command: string },
        options: {
          readonly args?: ReadonlyArray<string>;
          readonly stdout: (bytes: Uint8Array) => Effect.Effect<void>;
        },
      ) =>
        Effect.gen(function* () {
          calls.push({ command: _tool.command, args: options.args ?? [] });
          yield* Effect.forEach(
            typeof output === "string" ? [new TextEncoder().encode(output)] : output,
            options.stdout,
            { discard: true },
          );
          return { jobId: "job", exitCode: 0 };
        }),
    },
  } as unknown as Stack;
  const layer = Layer.mergeAll(
    NodeServices.layer,
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
  );
  return { stack, calls, layer };
};

describe("managed pg_dump runner", () => {
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
      'GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";',
      "pg_dumpall --roles-only",
      { RESERVED_ROLES: "supabase_realtime_admin" },
      '-- GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";',
    ],
    [
      'GRANT ALL ON PARAMETER "log_min_messages" TO "supabase_admin" WITH GRANT OPTION;',
      "pg_dumpall --roles-only",
      { RESERVED_ROLES: "supabase_.*" },
      '-- GRANT ALL ON PARAMETER "log_min_messages" TO "supabase_admin" WITH GRANT OPTION;',
    ],
    [
      'GRANT SET ON PARAMETER "log_min_messages" TO "app_user";',
      "pg_dumpall --roles-only",
      { RESERVED_ROLES: "supabase_.*" },
      'GRANT SET ON PARAMETER "log_min_messages" TO "app_user";',
    ],
    [
      `ALTER ROLE "app_user" SET "myapp.restore_sql" TO 'GRANT SET ON PARAMETER "log_min_messages" TO "postgres";';`,
      "pg_dumpall --roles-only",
      { RESERVED_ROLES: "postgres" },
      `ALTER ROLE "app_user" SET "myapp.restore_sql" TO 'GRANT SET ON PARAMETER "log_min_messages" TO "postgres";';`,
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

  it("keeps the managed dump filters equivalent to the CLI scripts", () => {
    for (const [input, script, env, expected] of cases)
      expect(transformManagedDumpLine(input, script, env)).toBe(expected);
  });

  it.live.skipIf(process.platform === "win32")("filters role dumps through the CLI script", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const [input, script, env, expected] of cases) {
        if (!script.includes("pg_dumpall")) continue;
        const child = yield* spawner.spawn(
          ChildProcess.make(
            "bash",
            ["-c", `pg_dumpall() { printf '%s\\n' "$DUMP_INPUT"; }\n${dumpRoleScript}`],
            {
              env: {
                PGHOST: "127.0.0.1",
                PGPORT: "5432",
                PGUSER: "postgres",
                PGPASSWORD: "",
                PGDATABASE: "postgres",
                RESERVED_ROLES: "",
                ALLOWED_CONFIGS: "",
                EXTRA_SED: "",
                ...env,
                DUMP_INPUT: input,
              },
              stdin: "ignore",
              stderr: "inherit",
            },
          ),
        );
        const [exitCode, stdout] = yield* Effect.all(
          [child.exitCode, Stream.mkString(Stream.decodeText(child.stdout))],
          { concurrency: "unbounded" },
        );
        expect(exitCode).toBe(0);
        expect(stdout).toBe(`${expected === undefined ? "" : `${expected}\n`}RESET ALL;\n`);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

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
      client: { kind: "stack", stack: fixture.stack, command: "pg_dump", pin: selection.database },
    }).pipe(
      Effect.provide(fixture.layer),
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
      client: { kind: "stack", stack: fixture.stack, command: "pg_dump", pin: selection.database },
    }).pipe(
      Effect.provide(fixture.layer),
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

describe("role dump parameter grants", () => {
  const comment = "-- A comment with an unmatched quote: '\n";
  const settings = `ALTER ROLE "app'role" SET "pgrst.db_schemas" TO 'public';
ALTER ROLE "app_user" SET "pgrst.multiline_sql" TO 'SELECT 1;
GRANT SET ON PARAMETER "log_min_messages" TO "postgres";
SELECT 2;';
ALTER ROLE "app_user" SET "pgrst.escaped_sql" TO E'backslash\\\\''quote''
GRANT SET ON PARAMETER "log_min_messages" TO "postgres";
last line';
`;
  const reservedGrant = 'GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";';
  const customGrant = 'GRANT SET ON PARAMETER "log_lock_waits" TO "app_user";';
  const quotedCustomGrant = 'GRANT SET ON PARAMETER "log_lock_waits" TO "postgres""custom";';
  const input = `${comment}${settings}${reservedGrant}\n${customGrant}\n${quotedCustomGrant}\n`;

  for (const keepComments of [false, true]) {
    const env = {
      PGHOST: "unused",
      PGPORT: "5432",
      PGUSER: "postgres",
      PGPASSWORD: "",
      PGDATABASE: "postgres",
      RESERVED_ROLES: "postgres|supabase_.*",
      ALLOWED_CONFIGS: "pgrst.*",
      EXTRA_SED: keepComments ? "" : "/^--/d",
    };
    const expected = `${keepComments ? comment : ""}${settings}${keepComments ? `-- ${reservedGrant}\n` : ""}${customGrant}\n${quotedCustomGrant}\nRESET ALL;\n`;

    it.live(
      `preserves quoted settings across Stack chunks with keep-comments=${keepComments}`,
      () => {
        const bytes = new TextEncoder().encode(input);
        const fixture = stackFixture(
          Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) =>
            bytes.slice(i * 7, (i + 1) * 7),
          ),
        );
        return Effect.gen(function* () {
          let output = "";
          const result = yield* streamPgDumpWithClient({
            image: "unused",
            script: dumpRoleScript,
            env,
            onStdout: (chunk) =>
              Effect.sync(() => {
                output += new TextDecoder().decode(chunk);
              }),
            client: {
              kind: "stack",
              stack: fixture.stack,
              command: "pg_dumpall",
              pin: selection.database,
            },
          });
          expect(result.exitCode).toBe(0);
          expect(output).toBe(expected);
        }).pipe(Effect.provide(fixture.layer));
      },
    );

    describe.skipIf(process.platform === "win32")("Bash script", () => {
      const longSetting = `ALTER ROLE "app_user" SET "myapp.large" TO '${"x".repeat(512 * 1024)}';\n`;
      for (const dryRun of [false, true]) {
        it.live(
          `preserves long quoted settings with keep-comments=${keepComments}, dry-run=${dryRun}`,
          () =>
            Effect.gen(function* () {
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const script = dryRun ? expandScript(dumpRoleScript, env) : dumpRoleScript;
              const child = yield* spawner.spawn(
                ChildProcess.make("bash", ["-c", `pg_dumpall() { cat; }\n${script}`], {
                  env,
                  stdin: Stream.make(new TextEncoder().encode(`${longSetting}${input}`)),
                  stderr: "inherit",
                }),
              );
              const [exitCode, output] = yield* Effect.all(
                [child.exitCode, Stream.mkString(Stream.decodeText(child.stdout))],
                { concurrency: "unbounded" },
              );
              expect(exitCode).toBe(0);
              expect(output).toBe(`${longSetting}${expected}`);
            }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        );

        it.live(
          `preserves role setting bytes with keep-comments=${keepComments}, dry-run=${dryRun}`,
          () =>
            Effect.gen(function* () {
              const encoder = new TextEncoder();
              const setting = Uint8Array.from([
                ...encoder.encode('ALTER ROLE "app_user" SET "myapp.bytes" TO \'café'),
                0xff,
                ...encoder.encode("';\n"),
              ]);
              const bytes = Uint8Array.from([...setting, ...encoder.encode(`${reservedGrant}\n`)]);
              const expectedBytes = Uint8Array.from([
                ...setting,
                ...encoder.encode(`${keepComments ? `-- ${reservedGrant}\n` : ""}RESET ALL;\n`),
              ]);
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const script = dryRun ? expandScript(dumpRoleScript, env) : dumpRoleScript;
              /* Keep sed byte-oriented so its existing locale behavior cannot mask awk's. */
              const child = yield* spawner.spawn(
                ChildProcess.make(
                  "bash",
                  ["-c", `pg_dumpall() { cat; }\nsed() { LC_ALL=C command sed "$@"; }\n${script}`],
                  {
                    env: {
                      ...env,
                      LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
                    },
                    stdin: Stream.make(bytes),
                    stderr: "inherit",
                  },
                ),
              );
              const [exitCode, chunks] = yield* Effect.all(
                [child.exitCode, Stream.runCollect(child.stdout)],
                { concurrency: "unbounded" },
              );
              expect(exitCode).toBe(0);
              expect(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))).toEqual(expectedBytes);
            }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        );
      }
    });
  }
});
