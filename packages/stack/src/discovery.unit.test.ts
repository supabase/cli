import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import { deleteManagedStackPersistence, listStacks, resolveStackSummary } from "./discovery.ts";
import { projectKeyForProjectDir } from "./paths.ts";
import { stackMetadata } from "./StackMetadata.ts";
import type { StackState } from "./StateManager.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const defaultPorts = {
  apiPort: 54321,
  dbPort: 54322,
  authPort: 54323,
  postgrestPort: 54324,
  postgrestAdminPort: 54325,
  edgeRuntimePort: 54337,
  edgeRuntimeInspectorPort: 54338,
  realtimePort: 54326,
  storagePort: 54327,
  imgproxyPort: 54328,
  mailpitPort: 54329,
  mailpitSmtpPort: 54330,
  mailpitPop3Port: 54331,
  pgmetaPort: 54332,
  studioPort: 54333,
  analyticsPort: 54334,
  poolerPort: 54335,
  poolerApiPort: 54336,
} as const;

function writeStackMetadataFile(stackDir: string) {
  writeFileSync(
    join(stackDir, "stack.json"),
    JSON.stringify(
      stackMetadata({
        ports: defaultPorts,
        services: DEFAULT_VERSIONS,
        launch: { mode: "auto", excludedServices: [] },
      }),
      null,
      2,
    ),
  );
}

function writeStateFile(stackDir: string, state: StackState) {
  writeFileSync(join(stackDir, "state.json"), JSON.stringify(state, null, 2));
}

async function withTempCacheRoot(run: (cacheRoot: string) => Promise<void>) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "supabase-discovery-test-"));
  try {
    await run(cacheRoot);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}

describe("deleteManagedStackPersistence", () => {
  it("deletes a persisted stack directory when it exists", async () =>
    withTempCacheRoot(async (cacheRoot) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const projectDir = "/Users/test/Code/my-project";
          const stackDir = join(
            cacheRoot,
            "projects",
            projectKeyForProjectDir(projectDir),
            "stacks",
            "my-project",
          );
          mkdirSync(join(stackDir, "data"), { recursive: true });
          writeFileSync(
            join(stackDir, "stack.json"),
            JSON.stringify(
              stackMetadata({
                ports: {
                  apiPort: 54321,
                  dbPort: 54322,
                  authPort: 54323,
                  postgrestPort: 54324,
                  postgrestAdminPort: 54325,
                  edgeRuntimePort: 54337,
                  edgeRuntimeInspectorPort: 54338,
                  realtimePort: 54326,
                  storagePort: 54327,
                  imgproxyPort: 54328,
                  mailpitPort: 54329,
                  mailpitSmtpPort: 54330,
                  mailpitPop3Port: 54331,
                  pgmetaPort: 54332,
                  studioPort: 54333,
                  analyticsPort: 54334,
                  poolerPort: 54335,
                  poolerApiPort: 54336,
                },
                services: DEFAULT_VERSIONS,
                launch: { mode: "auto", excludedServices: [] },
              }),
            ),
          );
          writeFileSync(join(stackDir, "state.json"), "{}");

          yield* deleteManagedStackPersistence({
            cacheRoot,
            name: "my-project",
            cwd: projectDir,
            projectDir,
          });

          expect(existsSync(stackDir)).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
      );
    }));

  it("fails with NoRunningStackError when no persisted stack directory exists", async () =>
    withTempCacheRoot(async (cacheRoot) => {
      const exit = await Effect.runPromise(
        deleteManagedStackPersistence({
          cacheRoot,
          name: "missing-project",
          cwd: "/Users/test/Code/missing-project",
        }).pipe(Effect.provide(BunServices.layer), Effect.exit),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause)).toContain("NoRunningStackError");
      }
    }));
});

describe("stack discovery", () => {
  it("lists a stopped stack from durable stack metadata", async () =>
    withTempCacheRoot(async (cacheRoot) => {
      const stackDir = join(cacheRoot, "projects", "project-a", "stacks", "default");
      mkdirSync(stackDir, { recursive: true });
      writeStackMetadataFile(stackDir);

      const summaries = await Effect.runPromise(
        listStacks({ cacheRoot, projectStateRoot: join(cacheRoot, "projects", "project-a") }).pipe(
          Effect.provide(BunServices.layer),
        ),
      );

      expect(summaries).toEqual([
        expect.objectContaining({
          name: "default",
          running: false,
          ports: expect.objectContaining({ apiPort: 54321, dbPort: 54322 }),
          versions: DEFAULT_VERSIONS,
        }),
      ]);
    }));

  it("lists a running stack with live runtime details", async () =>
    withTempCacheRoot(async (cacheRoot) => {
      const projectStateRoot = join(cacheRoot, "projects", "project-a");
      const stackDir = join(projectStateRoot, "stacks", "default");
      mkdirSync(stackDir, { recursive: true });
      writeStackMetadataFile(stackDir);
      writeStateFile(stackDir, {
        pid: process.pid,
        name: "default",
        projectDir: "/Users/test/Code/project-a",
        apiPort: 54321,
        dbPort: 54322,
        ports: defaultPorts,
        socketPath: "/tmp/supabase/default/daemon.sock",
        startedAt: "2026-03-24T10:00:00.000Z",
        url: "http://127.0.0.1:54321",
        dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        publishableKey: "pk",
        secretKey: "sk",
        anonJwt: "anon",
        serviceRoleJwt: "service-role",
        serviceEndpoints: {},
        services: {
          postgres: "17.6.1.081",
        },
      });

      const summaries = await Effect.runPromise(
        listStacks({ cacheRoot, projectStateRoot }).pipe(Effect.provide(BunServices.layer)),
      );

      expect(summaries).toEqual([
        expect.objectContaining({
          name: "default",
          running: true,
          url: "http://127.0.0.1:54321",
          dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
          startedAt: "2026-03-24T10:00:00.000Z",
        }),
      ]);
    }));

  it("resolves one stack summary by name", async () =>
    withTempCacheRoot(async (cacheRoot) => {
      const projectStateRoot = join(cacheRoot, "projects", "project-a");
      const stackDir = join(projectStateRoot, "stacks", "default");
      mkdirSync(stackDir, { recursive: true });
      writeStackMetadataFile(stackDir);

      const summary = await Effect.runPromise(
        resolveStackSummary({ cacheRoot, projectStateRoot, name: "default" }).pipe(
          Effect.provide(BunServices.layer),
        ),
      );

      expect(summary).toEqual(
        expect.objectContaining({
          name: "default",
          running: false,
        }),
      );
    }));

  it("fails when stack metadata is malformed instead of skipping it", async () =>
    withTempCacheRoot(async (cacheRoot) => {
      const projectStateRoot = join(cacheRoot, "projects", "project-a");
      const stackDir = join(projectStateRoot, "stacks", "default");
      mkdirSync(stackDir, { recursive: true });
      writeFileSync(join(stackDir, "stack.json"), "{");

      const exit = await Effect.runPromise(
        listStacks({ cacheRoot, projectStateRoot }).pipe(
          Effect.provide(BunServices.layer),
          Effect.exit,
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toMatchObject({ _tag: "InvalidStackMetadataError" });
        }
      }
    }));

  it("fails when stack state is malformed instead of skipping it", async () =>
    withTempCacheRoot(async (cacheRoot) => {
      const projectStateRoot = join(cacheRoot, "projects", "project-a");
      const stackDir = join(projectStateRoot, "stacks", "default");
      mkdirSync(stackDir, { recursive: true });
      writeStackMetadataFile(stackDir);
      writeFileSync(join(stackDir, "state.json"), "{");

      const exit = await Effect.runPromise(
        resolveStackSummary({ cacheRoot, projectStateRoot, name: "default" }).pipe(
          Effect.provide(BunServices.layer),
          Effect.exit,
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toMatchObject({ _tag: "InvalidStackStateError" });
        }
      }
    }));
});
