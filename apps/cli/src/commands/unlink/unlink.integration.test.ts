import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { mockOutput, mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { cliConfigLayer } from "../../config/cli-config.layer.ts";
import { projectContextLayer } from "../../config/project-context.layer.ts";
import { projectHomeLayer } from "../../config/project-home.layer.ts";
import { ProjectHome } from "../../config/project-home.service.ts";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { ProjectLinkState } from "../../config/project-link-state.service.ts";
import { unlink } from "./unlink.handler.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-unlink-command-"));
}

function buildLayer(opts: { cwd: string; env?: Record<string, string> }) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.env?.SUPABASE_HOME ? join(opts.env.SUPABASE_HOME, "..") : join(opts.cwd, ".home"),
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  const discoveredProjectContextLayer = projectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
  const discoveredCliConfigLayer = cliConfigLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredProjectContextLayer),
  );
  const discoveredProjectHomeLayer = projectHomeLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredProjectContextLayer),
    Layer.provide(discoveredCliConfigLayer),
  );
  const discoveredProjectLinkStateLayer = projectLinkStateLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(discoveredProjectHomeLayer),
  );
  const out = mockOutput({ format: "text", interactive: false });

  return {
    out,
    layer: Layer.mergeAll(
      BunServices.layer,
      runtimeInfoLayer,
      envLayer,
      discoveredProjectContextLayer,
      discoveredCliConfigLayer,
      discoveredProjectHomeLayer,
      discoveredProjectLinkStateLayer,
      out.layer,
    ),
  };
}

describe("unlink handler", () => {
  it.live("clears only cached link state and leaves project config unchanged", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");
    const projectRef = "abcdefghijklmnopqrst";
    const initialConfig = `project_id = "${projectRef}"\n`;

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(projectRoot, "supabase", "config.toml"), initialConfig),
      );

      const { layer, out } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
      });
      const { projectHome, linkState } = yield* Effect.gen(function* () {
        return {
          projectHome: yield* ProjectHome,
          linkState: yield* ProjectLinkState,
        };
      }).pipe(Effect.provide(layer));

      yield* projectHome.ensureProjectHomeDir;
      yield* linkState.save({
        ref: projectRef,
        name: "Linked Project",
        fetchedAt: "2026-03-20T12:00:00.000Z",
        versions: { postgres: "17.6.1.090" },
      });

      yield* unlink().pipe(Effect.provide(layer));

      const configContent = yield* Effect.tryPromise(() =>
        readFile(join(projectRoot, "supabase", "config.toml"), "utf8"),
      );
      expect(configContent).toBe(initialConfig);

      const cached = yield* linkState.load;
      expect(Option.isNone(cached)).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Local project unlinked." }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "outro",
          message: `Unlinked local project from Linked Project (${projectRef}).`,
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("succeeds without requiring a local Supabase config", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(projectRoot, { recursive: true }));

      const { layer, out } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
      });
      const linkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));

      yield* unlink().pipe(Effect.provide(layer));

      const cached = yield* linkState.load;
      expect(Option.isNone(cached)).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Local project is already unlinked." }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
