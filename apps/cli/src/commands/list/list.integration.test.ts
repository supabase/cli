import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stackMetadata } from "@supabase/stack/effect";
import { list } from "./list.handler.ts";
import { ProjectHome } from "../../config/project-home.service.ts";
import { mockOutput, withEnv } from "../../../tests/helpers/mocks.ts";

function writeStackMetadata(stackDir: string, apiPort: number, dbPort: number) {
  writeFileSync(
    join(stackDir, "stack.json"),
    JSON.stringify(
      stackMetadata({
        ports: {
          apiPort,
          dbPort,
          authPort: 54323,
          postgrestPort: 54324,
          postgrestAdminPort: 54325,
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
        services: {
          postgres: "17.6.1.081",
          postgrest: "14.5",
          auth: "2.188.0-rc.15",
          realtime: "2.78.10",
          storage: "1.41.8",
          imgproxy: "v3.8.0",
          mailpit: "v1.22.3",
          pgmeta: "0.96.1",
          studio: "2026.03.04-sha-0043607",
          analytics: "1.34.7",
          vector: "0.28.1-alpine",
          pooler: "2.7.4",
        },
        launch: { mode: "auto", excludedServices: [] },
      }),
      null,
      2,
    ),
  );
}

describe("list handler", () => {
  it.live("lists all known local stacks for the project", () => {
    const out = mockOutput();
    const home = mkdtempSync(join(tmpdir(), "supabase-list-test-"));
    const projectRoot = join(home, "repo");
    const projectHomeDir = join(projectRoot, ".supabase");
    const defaultDir = join(projectHomeDir, "stacks", "default");
    const previewDir = join(projectHomeDir, "stacks", "preview");
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(previewDir, { recursive: true });
    writeStackMetadata(defaultDir, 54321, 54322);
    writeStackMetadata(previewDir, 55321, 55322);

    const projectHomeLayer = Layer.succeed(
      ProjectHome,
      ProjectHome.of({
        projectRoot,
        supabaseDir: join(projectRoot, "supabase"),
        projectHomeDir,
        projectLinkPath: join(projectHomeDir, "project.json"),
        projectLocalVersionsPath: join(projectHomeDir, "local-versions.json"),
        ensureProjectHomeDir: Effect.void,
        stackDir: (name: string) => join(projectHomeDir, "stacks", name),
        stackStatePath: (name: string) => join(projectHomeDir, "stacks", name, "state.json"),
        stackMetadataPath: (name: string) => join(projectHomeDir, "stacks", name, "stack.json"),
        stackDataDir: (name: string) => join(projectHomeDir, "stacks", name, "data"),
        stackLogsDir: (name: string) => join(projectHomeDir, "stacks", name, "logs"),
      }),
    );

    return Effect.gen(function* () {
      yield* list();
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Known local Supabase stacks." }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "default: stopped | API 54321 | DB 54322",
        }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "preview: stopped | API 55321 | DB 55322",
        }),
      );
    }).pipe(
      Effect.provide(projectHomeLayer),
      Effect.provide(out.layer),
      Effect.provide(BunServices.layer),
      Effect.provide(withEnv({ SUPABASE_HOME: home, PWD: projectRoot })),
    );
  });

  it.live("shows an empty-state message when no stacks are known", () => {
    const out = mockOutput();
    const home = mkdtempSync(join(tmpdir(), "supabase-list-empty-test-"));

    return Effect.gen(function* () {
      yield* list();
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: "No local Supabase stacks are known for this project.",
        }),
      );
    }).pipe(
      Effect.provide(out.layer),
      Effect.provide(BunServices.layer),
      Effect.provide(withEnv({ SUPABASE_HOME: home })),
    );
  });

  it.live("emits structured stack summaries in json mode", () => {
    const out = mockOutput({ format: "json", interactive: false });
    const home = mkdtempSync(join(tmpdir(), "supabase-list-json-test-"));
    const projectRoot = join(home, "repo");
    const projectHomeDir = join(projectRoot, ".supabase");
    const defaultDir = join(projectHomeDir, "stacks", "default");
    mkdirSync(defaultDir, { recursive: true });
    writeStackMetadata(defaultDir, 54321, 54322);

    const projectHomeLayer = Layer.succeed(
      ProjectHome,
      ProjectHome.of({
        projectRoot,
        supabaseDir: join(projectRoot, "supabase"),
        projectHomeDir,
        projectLinkPath: join(projectHomeDir, "project.json"),
        projectLocalVersionsPath: join(projectHomeDir, "local-versions.json"),
        ensureProjectHomeDir: Effect.void,
        stackDir: (name: string) => join(projectHomeDir, "stacks", name),
        stackStatePath: (name: string) => join(projectHomeDir, "stacks", name, "state.json"),
        stackMetadataPath: (name: string) => join(projectHomeDir, "stacks", name, "stack.json"),
        stackDataDir: (name: string) => join(projectHomeDir, "stacks", name, "data"),
        stackLogsDir: (name: string) => join(projectHomeDir, "stacks", name, "logs"),
      }),
    );

    return Effect.gen(function* () {
      yield* list();
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Known local Supabase stacks.",
          data: {
            stacks: [
              {
                name: "default",
                running: false,
                ports: expect.objectContaining({ apiPort: 54321, dbPort: 54322 }),
                started_at: undefined,
              },
            ],
          },
        }),
      );
    }).pipe(
      Effect.provide(projectHomeLayer),
      Effect.provide(out.layer),
      Effect.provide(BunServices.layer),
      Effect.provide(withEnv({ SUPABASE_HOME: home, PWD: projectRoot })),
    );
  });
});
