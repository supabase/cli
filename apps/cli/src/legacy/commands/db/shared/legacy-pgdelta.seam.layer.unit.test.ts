import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Sink, Stream } from "effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { LegacyNetworkIdFlag, LegacyProfileFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import {
  legacyIsMissingContainerInspectError,
  legacyResolveContainerInspectImageName,
  makeLegacyDeclarativeSeamLayer,
} from "./legacy-pgdelta.seam.layer.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";

const protocol = JSON.stringify({
  migrations: {
    containerId: "migrations-container",
    url: "postgresql://postgres@localhost:55432/postgres",
  },
  declarative: {
    containerId: "declarative-container",
    url: "postgresql://postgres@localhost:55433/postgres",
  },
});

function setup(
  options: {
    readonly stdout?: string;
    readonly interruptOnAck?: boolean;
    readonly cleanupDefectContainer?: string;
    readonly workdir?: string;
  } = {},
) {
  const state = {
    commands: [] as Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin: unknown;
      readonly stdout: unknown;
      readonly stderr: unknown;
    }>,
    stdin: "",
    childScopeClosed: 0,
    cleanupAttempts: [] as string[],
  };
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") return Effect.die("unexpected pipeline");
      state.commands.push({
        command: command.command,
        args: [...command.args],
        stdin: command.options.stdin,
        stdout: command.options.stdout,
        stderr: command.options.stderr,
      });
      const isProvisioner = command.command === "/fake/supabase-go";
      if (!isProvisioner) {
        const container = command.args.at(-1) ?? "";
        state.cleanupAttempts.push(container);
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(2),
            exitCode:
              container === options.cleanupDefectContainer
                ? Effect.die("cleanup defect")
                : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }
      const handle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.sync(() => {
          if (state.stdin !== "ack\n") throw new Error("exit awaited before ack");
          return ChildProcessSpawner.ExitCode(0);
        }),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            state.stdin += new TextDecoder().decode(chunk);
          }).pipe(Effect.andThen(options.interruptOnAck === true ? Effect.interrupt : Effect.void)),
        ),
        // Never terminate stdout: reading the full stream would deadlock before ack.
        stdout: Stream.make(new TextEncoder().encode(`${options.stdout ?? protocol}\n`)).pipe(
          Stream.concat(Stream.never),
        ),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
      return Effect.acquireRelease(Effect.succeed(handle), () =>
        Effect.sync(() => {
          state.childScopeClosed += 1;
        }),
      );
    }),
  );
  const config = Layer.succeed(LegacyCliConfig, {
    profile: "supabase",
    apiUrl: "https://api.supabase.com",
    projectHost: "supabase.co",
    poolerHost: "pooler.supabase.com",
    dashboardUrl: "https://supabase.com/dashboard",
    accessToken: Option.none(),
    projectId: Option.none(),
    workdir: options.workdir ?? resolve(process.cwd(), "../.."),
    userAgent: "test",
  });
  const dependencies = Layer.mergeAll(
    BunFileSystem.layer,
    BunPath.layer,
    spawner,
    config,
    Layer.succeed(LegacyNetworkIdFlag, Option.some("test-network")),
    Layer.succeed(LegacyProfileFlag, "snap"),
  );
  return {
    state,
    layer: makeLegacyDeclarativeSeamLayer({ binary: "/fake/supabase-go" }).pipe(
      Layer.provide(dependencies),
    ),
  };
}

describe("LegacyDeclarativeSeam next shadow protocol", () => {
  it.effect("acks only after acquisition and cleans both containers on caller failure", () => {
    const { layer, state } = setup({ cleanupDefectContainer: "declarative-container" });
    return Effect.gen(function* () {
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const seam = yield* LegacyDeclarativeSeam;
          const databases = yield* seam.provisionNextPlanShadows({
            schema: ["public", "extensions"],
            projectRef: "linked-project",
          });
          expect(state.stdin).toBe("ack\n");
          expect(databases).toEqual({
            migrationsUrl: "postgresql://postgres:postgres@localhost:55432/postgres",
            declarativeUrl: "postgresql://postgres:postgres@localhost:55433/postgres",
          });
          return yield* Effect.fail("caller failed");
        }),
      ).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(state.cleanupAttempts).toEqual(["declarative-container", "migrations-container"]);
      expect(state.childScopeClosed).toBe(1);
      expect(state.commands[0]).toEqual({
        command: "/fake/supabase-go",
        args: [
          "db",
          "__shadow",
          "--mode",
          "pgdelta-next-plan",
          "--schema",
          "public,extensions",
          "--network-id",
          "test-network",
          "--project-ref",
          "linked-project",
          "--profile",
          "snap",
        ],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("owns and cleans only the migrated container for a database diff", () => {
    const migrationsProtocol = JSON.stringify({
      migrations: {
        containerId: "migrations-container",
        url: "postgresql://postgres@localhost:55432/postgres",
      },
    });
    const { layer, state } = setup({ stdout: migrationsProtocol });
    return Effect.gen(function* () {
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const seam = yield* LegacyDeclarativeSeam;
          const database = yield* seam.provisionNextMigrationsShadow({ schema: ["public"] });
          expect(state.stdin).toBe("ack\n");
          expect(database).toEqual({
            migrationsUrl: "postgresql://postgres:postgres@localhost:55432/postgres",
          });
          return yield* Effect.fail("caller failed");
        }),
      ).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(state.cleanupAttempts).toEqual(["migrations-container"]);
      expect(state.childScopeClosed).toBe(1);
      expect(state.commands[0]?.args).toContain("pgdelta-next-migrations");
    }).pipe(Effect.provide(layer));
  });

  it.effect("has both cleanup finalizers installed when the ack write is interrupted", () => {
    const { layer, state } = setup({ interruptOnAck: true });
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const seam = yield* LegacyDeclarativeSeam;
          yield* seam.provisionNextPlanShadows({ schema: [] });
        }),
      ).pipe(Effect.exit);
      expect(state.stdin).toBe("ack\n");
      expect(state.cleanupAttempts).toEqual(["declarative-container", "migrations-container"]);
      expect(state.childScopeClosed).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not ack malformed output and leaves cleanup with Go", () => {
    const { layer, state } = setup({ stdout: '{"migrations":{}}' });
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const seam = yield* LegacyDeclarativeSeam;
          yield* seam.provisionNextPlanShadows({ schema: [] });
        }),
      ).pipe(Effect.exit);
      expect(state.stdin).toBe("");
      expect(state.cleanupAttempts).toEqual([]);
      expect(state.childScopeClosed).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not ack when the database password cannot be read", () => {
    const workdir = mkdtempSync(join(tmpdir(), "supabase-next-shadow-"));
    mkdirSync(join(workdir, "supabase"));
    writeFileSync(join(workdir, "supabase", "config.toml"), "[db\ninvalid");
    const { layer, state } = setup({ workdir });
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const seam = yield* LegacyDeclarativeSeam;
          yield* seam.provisionNextPlanShadows({ schema: [] });
        }),
      ).pipe(Effect.exit);
      expect(state.stdin).toBe("");
      expect(state.cleanupAttempts).toEqual([]);
      expect(state.childScopeClosed).toBe(1);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(workdir, { recursive: true, force: true }))),
    );
  });
});

describe("legacyIsMissingContainerInspectError", () => {
  it("matches Docker and Podman missing-container stderr", () => {
    expect(legacyIsMissingContainerInspectError("Error: No such container: supabase_db_test")).toBe(
      true,
    );
    expect(legacyIsMissingContainerInspectError("Error: no such container: supabase_db_test")).toBe(
      true,
    );
  });

  it("does not match unrelated inspect failures", () => {
    expect(legacyIsMissingContainerInspectError("Cannot connect to the Docker daemon")).toBe(false);
  });
});

describe("legacyResolveContainerInspectImageName", () => {
  it("reads Docker's config image from inspect JSON", () => {
    expect(
      legacyResolveContainerInspectImageName(
        JSON.stringify([{ Config: { Image: "public.ecr.aws/supabase/postgres:17.4.1.056" } }]),
      ),
    ).toBe("public.ecr.aws/supabase/postgres:17.4.1.056");
  });

  it("prefers Podman's image name from inspect JSON", () => {
    expect(
      legacyResolveContainerInspectImageName(
        JSON.stringify([
          {
            Image: "sha256:0123456789",
            ImageName: "public.ecr.aws/supabase/postgres:17.4.1.056",
          },
        ]),
      ),
    ).toBe("public.ecr.aws/supabase/postgres:17.4.1.056");
  });

  it("keeps raw formatter output as a compatibility fallback", () => {
    expect(legacyResolveContainerInspectImageName("supabase/postgres:15.1.0")).toBe(
      "supabase/postgres:15.1.0",
    );
  });

  it("returns empty when JSON inspect output has no image-name field", () => {
    expect(legacyResolveContainerInspectImageName(JSON.stringify([{ Image: "sha256:0123" }]))).toBe(
      "",
    );
  });
});
