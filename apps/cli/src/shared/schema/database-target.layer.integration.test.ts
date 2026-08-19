import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { CliConfig } from "../../next/config/cli-config.service.ts";
import { ProjectHome } from "../../next/config/project-home.service.ts";
import { ProjectLinkState } from "../../next/config/project-link-state.service.ts";
import { LinkedRemoteConnector } from "../database/linked-remote-connector.service.ts";
import { noLocalDatabaseFallbackLayer } from "../database/local-database-fallback.service.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { databaseTargetLayer } from "./database-target.layer.ts";
import { SchemaLinkedConnectionError } from "./schema-errors.ts";

const linkedState = {
  project: {
    ref: "abcdefghijklmnop",
    name: "demo",
    organization_id: "org",
    organization_slug: "org",
  },
  active_branch: { ref: "abcdefghijklmnop", name: "main", is_default: true },
  fetchedAt: "2026-01-01T00:00:00.000Z",
  versions: {},
};

function setup(opts: { readonly connectorUrl?: string; readonly linked?: boolean } = {}) {
  const deps = Layer.mergeAll(
    BunServices.layer,
    noLocalDatabaseFallbackLayer,
    Layer.succeed(
      ProjectHome,
      ProjectHome.of({
        projectRoot: "/tmp/project",
        supabaseDir: "/tmp/project/supabase",
        projectHomeDir: "/tmp/project/.supabase",
        projectLinkPath: "/tmp/project/.supabase/project.json",
        projectLocalVersionsPath: "/tmp/project/.supabase/local-versions.json",
        ensureProjectHomeDir: Effect.void,
        stackDir: () => "/tmp/stack",
        stackStatePath: () => "/tmp/stack/state",
        stackMetadataPath: () => "/tmp/stack/meta",
        stackDataDir: () => "/tmp/stack/data",
        stackLogsDir: () => "/tmp/stack/logs",
      }),
    ),
    Layer.succeed(
      RuntimeInfo,
      RuntimeInfo.of({
        cwd: "/tmp/project",
        platform: process.platform,
        arch: process.arch,
        homeDir: "/tmp/home",
        execPath: "/tmp/supabase",
        pid: 1,
      }),
    ),
    Layer.succeed(
      CliConfig,
      CliConfig.of({
        apiUrl: "https://api.supabase.com",
        dashboardUrl: "https://supabase.com/dashboard",
        projectHost: "supabase.co",
        telemetryPosthogHost: "https://example.com",
        telemetryPosthogKey: Option.none(),
        accessToken: Option.none(),
        noKeyring: Option.none(),
        supabaseHome: "/tmp/home/.supabase",
        debug: Option.none(),
        telemetryDebug: Option.none(),
        telemetryDisabled: Option.none(),
        doNotTrack: Option.none(),
      }),
    ),
    Layer.succeed(
      ProjectLinkState,
      ProjectLinkState.of({
        load: Effect.succeed(opts.linked === false ? Option.none() : Option.some(linkedState)),
        save: () => Effect.void,
        clear: Effect.void,
        getActiveBranch: Effect.succeed(Option.some(linkedState.active_branch)),
        setActiveBranch: () => Effect.void,
      }),
    ),
    Layer.succeed(
      LinkedRemoteConnector,
      LinkedRemoteConnector.of({
        connect: (projectRef) =>
          opts.connectorUrl !== undefined
            ? Effect.succeed(opts.connectorUrl)
            : new SchemaLinkedConnectionError({
                detail: `Linked project ${projectRef} has no connection string in this environment.`,
                suggestion: "Use the stable CLI.",
              }),
      }),
    ),
  );
  return databaseTargetLayer.pipe(Layer.provide(deps));
}

function restoreEnv(name: "DATABASE_URL" | "SUPABASE_DB_URL", previous: string | undefined) {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

describe("databaseTargetLayer linked resolve", () => {
  it.live("treats DATABASE_URL as an unverifiable URL target even when unlinked", () => {
    const previous = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = "postgresql://postgres:secret@other.example/postgres";
    return Effect.gen(function* () {
      const targets = yield* DatabaseTargetResolver;
      const target = yield* targets.resolve({ kind: "linked" });
      expect(target.kind).toBe("url");
      expect(target.projectRef).toBeUndefined();
      expect(target.connectionSource).toBe("env");
      expect(target.identity).toBe("connection-string");
    }).pipe(
      Effect.provide(setup({ linked: false })),
      Effect.ensuring(Effect.sync(() => restoreEnv("DATABASE_URL", previous))),
    );
  });

  it.live("builds the socket from the linked connector when no env URL is set", () => {
    const previousDb = process.env["DATABASE_URL"];
    const previousSupa = process.env["SUPABASE_DB_URL"];
    delete process.env["DATABASE_URL"];
    delete process.env["SUPABASE_DB_URL"];
    return Effect.gen(function* () {
      const targets = yield* DatabaseTargetResolver;
      const target = yield* targets.resolve({ kind: "linked" });
      expect(target.kind).toBe("linked");
      expect(target.projectRef).toBe("abcdefghijklmnop");
      expect(target.connectionString).toBe("postgresql://postgres:from-link@db.example/postgres");
      expect(target.connectionVerified).toBe(true);
    }).pipe(
      Effect.provide(
        setup({ connectorUrl: "postgresql://postgres:from-link@db.example/postgres" }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          restoreEnv("DATABASE_URL", previousDb);
          restoreEnv("SUPABASE_DB_URL", previousSupa);
        }),
      ),
    );
  });
});
