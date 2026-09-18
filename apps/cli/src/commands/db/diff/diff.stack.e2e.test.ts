import { BunServices } from "@effect/platform-bun";
import { Config, Crypto, Effect, FileSystem, ManagedRuntime, Option, Path } from "effect";
import { afterAll, describe, expect, test } from "vitest";
import { makeTempCliProject, makeTempHome, runSupabase } from "../../../../tests/helpers/cli.ts";

const host = ManagedRuntime.make(BunServices.layer);
afterAll(() => host.dispose());
const selectedRuntime = Option.getOrUndefined(
  Effect.runSync(Config.option(Config.string("SUPABASE_STACK_E2E_RUNTIME"))),
);
const runtimes = ["native", "container"] as const;
const excluded = "rest,auth,realtime,storage,functions,studio,mail,analytics,pooler";
const baselineName = /^stack-shadow-baseline-[0-9a-f]{16}\.tar$/u;
const probeFunction =
  /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+"?public"?\s*\.\s*"?probe_fn"?\s*\(\)/i;

describe("CLI schema diff with registered shadow databases", () => {
  for (const runtime of runtimes) {
    test.skipIf(selectedRuntime !== undefined && selectedRuntime !== runtime)(
      `reuses and repairs ${runtime} shadow caches, then resets roles and migrations`,
      { timeout: 22 * 60_000 },
      // oxlint-disable-next-line effecttsgo/async-function -- Exercises the compiled CLI subprocess and its real database/cache boundaries.
      async () => {
        const home = makeTempHome();
        const project = await makeTempCliProject(`supabase-shadow-${runtime}-`);
        const cacheDir = await host.runPromise(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const configDir = path.join(project.dir, "supabase");
            yield* fs.makeDirectory(configDir, { recursive: true });
            yield* fs.writeFileString(
              path.join(configDir, "config.toml"),
              'project_id = "shadow-cache-e2e"\n[experimental]\nstack = true\n[db]\nmajor_version = 17\n',
            );
            return path.join(home.dir, "cache", "shadow-baseline");
          }),
        );
        const command = (args: string[], cache?: string, timeout = 180_000) =>
          runSupabase(args, {
            cwd: project.dir,
            home: home.dir,
            exitTimeoutMs: timeout,
            env: { SUPABASE_EXPERIMENTAL_STACK: "1", SUPABASE_SHADOW_CACHE: cache },
          });
        const cacheEntries = () =>
          host.runPromise(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const names = yield* fs.readDirectory(cacheDir);
              expect(names.some((name) => name.endsWith(".partial"))).toBe(false);
              return yield* Effect.forEach(
                names.filter((name) => baselineName.test(name)),
                (name) =>
                  Effect.gen(function* () {
                    const bytes = yield* fs.readFile(path.join(cacheDir, name));
                    const crypto = yield* Crypto.Crypto;
                    const digest = yield* crypto.digest("SHA-256", bytes);
                    return { name, size: bytes.length, digest: Array.from(digest) };
                  }),
              );
            }),
          );
        const failures: unknown[] = [];
        try {
          const started = await command(
            [
              "stack",
              "start",
              "--runtime",
              runtime === "container" ? "docker" : "native",
              "--exclude",
              excluded,
              "--preparation",
              "on-demand",
            ],
            undefined,
            480_000,
          );
          expect(started.exitCode, `${started.stdout}\n${started.stderr}`).toBe(0);
          const created = await command([
            "db",
            "query",
            "CREATE FUNCTION public.probe_fn() RETURNS integer LANGUAGE sql AS $$ SELECT 42; $$;",
            "--local",
          ]);
          expect(created.exitCode, created.stderr).toBe(0);

          const args = ["db", "diff", "--local", "--use-pg-delta"];
          const cold = await command(args);
          expect(cold.exitCode, `${cold.stdout}\n${cold.stderr}`).toBe(0);
          expect(cold.stdout).toMatch(probeFunction);
          const first = await cacheEntries();
          expect(first).toHaveLength(1);
          const warm = await command(args);
          expect(warm.exitCode, `${warm.stdout}\n${warm.stderr}`).toBe(0);
          expect(warm.stdout).toBe(cold.stdout);
          expect(await cacheEntries(), warm.stderr).toEqual(first);

          const baseline = first[0];
          if (baseline === undefined) throw new Error("Cold shadow did not publish a baseline");
          await host.runPromise(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              yield* fs.writeFileString(path.join(cacheDir, baseline.name), "invalid snapshot");
            }),
          );
          const repaired = await command(args);
          expect(repaired.exitCode, `${repaired.stdout}\n${repaired.stderr}`).toBe(0);
          expect(repaired.stderr).toContain("shadow baseline not cached");
          expect(repaired.stdout).toBe(cold.stdout);
          const replacement = await cacheEntries();
          expect(replacement).toHaveLength(1);
          expect(replacement[0]?.name).toBe(baseline.name);
          expect(replacement[0]?.size).toBeGreaterThan("invalid snapshot".length);

          const uncached = await command(args, "0");
          expect(uncached.exitCode, `${uncached.stdout}\n${uncached.stderr}`).toBe(0);
          expect(uncached.stdout).toBe(cold.stdout);
          expect(await cacheEntries()).toEqual(replacement);
          const primary = await command([
            "db",
            "query",
            "SELECT public.probe_fn() AS preserved",
            "--local",
          ]);
          expect(primary.exitCode, primary.stderr).toBe(0);
          expect(primary.stdout).toContain("42");

          await host.runPromise(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const configDir = path.join(project.dir, "supabase");
              const migrations = path.join(configDir, "migrations");
              yield* fs.makeDirectory(migrations, { recursive: true });
              yield* fs.writeFileString(
                path.join(configDir, "roles.sql"),
                "CREATE ROLE reset_reader;\n",
              );
              yield* fs.writeFileString(
                path.join(migrations, "20260916000000_reset_probe.sql"),
                "CREATE TABLE public.reset_probe (value integer PRIMARY KEY);\nGRANT SELECT ON public.reset_probe TO reset_reader;\n",
              );
              yield* fs.writeFileString(
                path.join(configDir, "seed.sql"),
                "INSERT INTO public.reset_probe VALUES (42);\n",
              );
            }),
          );
          for (let pass = 0; pass < 2; pass += 1) {
            const reset = await command(["db", "reset", "--local", "--yes"], "0", 300_000);
            const diagnostics =
              reset.exitCode === 0
                ? ""
                : (await command(["stack", "logs", "--tail", "100"])).stdout;
            expect(reset.exitCode, `${reset.stdout}\n${reset.stderr}\n${diagnostics}`).toBe(0);
            const restored = await command([
              "db",
              "query",
              "SELECT CASE WHEN (SELECT value FROM public.reset_probe) = 42 AND has_table_privilege('reset_reader', 'public.reset_probe', 'SELECT') AND to_regprocedure('public.probe_fn()') IS NULL AND EXISTS (SELECT 1 FROM pg_database WHERE datname = '_supabase') THEN 'reset_verified' ELSE 'reset_incomplete' END AS result",
              "--local",
            ]);
            expect(restored.exitCode, restored.stderr).toBe(0);
            expect(restored.stdout).toContain("reset_verified");
          }
        } catch (error) {
          failures.push(error);
        }
        const destroyed = await command(["stack", "destroy", "--yes"], undefined, 120_000);
        if (destroyed.exitCode !== 0)
          failures.push(new Error(`Stack cleanup failed in ${project.dir}: ${destroyed.stderr}`));
        if (failures.length > 0)
          throw new AggregateError(failures, `${runtime} shadow cache verification failed`);
      },
    );
  }
});
