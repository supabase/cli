import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Path, Redacted } from "effect";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { mockOutput, mockRuntimeInfo } from "../../../tests/helpers/mocks.ts";
import { experimentsDisable } from "./disable/disable.handler.ts";
import { experimentsEnable } from "./enable/enable.handler.ts";

const CONFIG_WITH_COMMENTS = `project_id = "demo"

[api]
enabled = true

# Experimental features may be deprecated any time
[experimental]
# Configures Postgres storage engine to use OrioleDB (S3)
orioledb_version = ""
`;

/** A temp project whose config file is `relativePath`, plus a reader for it. */
const project = Effect.fnUntraced(function* (
  contents: string,
  relativePath = "supabase/config.toml",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-experiments-" });
  const configPath = path.join(dir, relativePath);
  yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
  yield* fs.writeFileString(configPath, contents);
  return {
    dir,
    configPath,
    read: fs.readFileString(configPath),
  };
});

function setupExperiments(options: {
  readonly workdir: string;
  readonly format?: "text" | "json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
  readonly env?: Readonly<Record<string, string>>;
}) {
  const out = mockOutput({ format: options.format ?? "text" });
  return {
    out,
    layer: Layer.mergeAll(
      out.layer,
      mockRuntimeInfo({ cwd: options.workdir }),
      // Supplied rather than stubbed onto `process.env`: `ConfigProvider`'s default snapshots
      // the ambient environment once per runtime, so an ambient stub set by one test leaks into
      // every later one in the file.
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...options.env } })),
      Layer.succeed(CommandSettings, {
        profile: "supabase",
        apiUrl: "https://api.supabase.com",
        projectHost: "supabase.co",
        poolerHost: "pooler.supabase.com",
        dashboardUrl: "https://supabase.com/dashboard",
        accessToken: Option.some(Redacted.make("sbp_test")),
        projectId: Option.none(),
        workdir: options.workdir,
        explicitWorkdir: true,
        userAgent: "supabase",
      }),
      Layer.succeed(
        OutputFlag,
        options.goOutput === undefined ? Option.none() : Option.some(options.goOutput),
      ),
      BunServices.layer,
    ),
  };
}

describe("experiments enable", () => {
  it.live("records the opt-in inside the existing [experimental] table, keeping comments", () =>
    Effect.gen(function* () {
      const repo = yield* project(CONFIG_WITH_COMMENTS);
      const { layer, out } = setupExperiments({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* experimentsEnable({ features: ["compute"] });

        expect(yield* repo.read).toBe(`${CONFIG_WITH_COMMENTS}compute = true\n`);
        expect(out.stdoutText).toBe(`Enabled compute in ${repo.configPath}.\n`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("creates the [experimental] table when the document has none", () =>
    Effect.gen(function* () {
      const repo = yield* project('project_id = "demo"\n');
      const { layer } = setupExperiments({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* experimentsEnable({ features: ["compute"] });
        expect(yield* repo.read).toContain("[experimental]");
        expect(yield* repo.read).toContain("compute = true");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("enables several experiments in one run and reports each", () =>
    Effect.gen(function* () {
      const repo = yield* project(CONFIG_WITH_COMMENTS);
      const { layer, out } = setupExperiments({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* experimentsEnable({ features: ["compute", "stack"] });

        const written = yield* repo.read;
        expect(written).toContain("compute = true");
        expect(written).toContain("stack = true");
        expect(out.stdoutText).toBe(
          `Enabled compute in ${repo.configPath}.\nEnabled stack in ${repo.configPath}.\n`,
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("reports a repeated name once", () =>
    Effect.gen(function* () {
      const repo = yield* project(CONFIG_WITH_COMMENTS);
      const { layer, out } = setupExperiments({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* experimentsEnable({ features: ["compute", "compute"] });
        expect(out.stdoutText).toBe(`Enabled compute in ${repo.configPath}.\n`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("leaves the file untouched when the experiment is already enabled", () =>
    Effect.gen(function* () {
      const repo = yield* project(`${CONFIG_WITH_COMMENTS}compute = true\n`);
      const { layer, out } = setupExperiments({ workdir: repo.dir });
      const before = yield* repo.read;

      return yield* Effect.gen(function* () {
        yield* experimentsEnable({ features: ["compute"] });
        expect(yield* repo.read).toBe(before);
        expect(out.stdoutText).toBe(`compute is already enabled in ${repo.configPath}.\n`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("edits a config.json project in place", () =>
    Effect.gen(function* () {
      const repo = yield* project(
        '{\n  "project_id": "demo",\n  "experimental": {\n    "orioledb_version": ""\n  }\n}\n',
        "supabase/config.json",
      );
      const { layer } = setupExperiments({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* experimentsEnable({ features: ["compute"] });
        // Asserted as text, not as a decoded object: the point is that the edit lands inside
        // the existing object with the file's own indentation intact.
        expect(yield* repo.read).toBe(
          '{\n  "project_id": "demo",\n  "experimental": {\n    "orioledb_version": "",\n    "compute": true\n  }\n}\n',
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("warns when an environment override will ignore what was written", () =>
    Effect.gen(function* () {
      const repo = yield* project(CONFIG_WITH_COMMENTS);
      const { layer, out } = setupExperiments({
        workdir: repo.dir,
        env: { SUPABASE_EXPERIMENTAL_COMPUTE: "0" },
      });

      return yield* Effect.gen(function* () {
        yield* experimentsEnable({ features: ["compute"] });
        expect(out.stdoutText).toContain(
          `Note: SUPABASE_EXPERIMENTAL_COMPUTE=0 takes precedence over ${repo.configPath}`,
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("treats an empty environment override as unset", () =>
    Effect.gen(function* () {
      const repo = yield* project(CONFIG_WITH_COMMENTS);
      const { layer, out } = setupExperiments({
        workdir: repo.dir,
        env: { SUPABASE_EXPERIMENTAL_COMPUTE: "" },
      });

      return yield* Effect.gen(function* () {
        yield* experimentsEnable({ features: ["compute"] });
        expect(out.stdoutText).not.toContain("takes precedence");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("emits a structured payload in json mode", () =>
    Effect.gen(function* () {
      const repo = yield* project(CONFIG_WITH_COMMENTS);
      const { layer, out } = setupExperiments({ workdir: repo.dir, format: "json" });

      return yield* Effect.gen(function* () {
        yield* experimentsEnable({ features: ["compute"] });
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            data: {
              config_path: repo.configPath,
              enabled: true,
              experiments: [
                { name: "compute", previous: false, changed: true, env_override: null },
              ],
            },
          }),
        );
        expect(out.stdoutText).toBe("");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("names the duplicate table header rather than silently leaving the flag off", () =>
    Effect.gen(function* () {
      const repo = yield* project(
        'project_id = "demo"\n\n[experimental]\ncompute = true\n\n[api]\nenabled = true\n\n[experimental]\norioledb_version = ""\n',
      );
      const { layer } = setupExperiments({ workdir: repo.dir });
      const before = yield* repo.read;

      return yield* Effect.gen(function* () {
        const exit = yield* experimentsEnable({ features: ["stack"] }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* repo.read).toBe(before);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("fails when no supabase project config exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-experiments-empty-" });
      const { layer } = setupExperiments({ workdir: dir });

      return yield* Effect.gen(function* () {
        const exit = yield* experimentsEnable({ features: ["compute"] }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("fails when the config file cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-experiments-dir-" });
      // A directory where the config file belongs: `exists` passes, the read does not.
      yield* fs.makeDirectory(path.join(dir, "supabase", "config.toml"), { recursive: true });
      const { layer } = setupExperiments({ workdir: dir });

      return yield* Effect.gen(function* () {
        const exit = yield* experimentsEnable({ features: ["compute"] }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("rejects -o before touching the config", () =>
    Effect.gen(function* () {
      const repo = yield* project(CONFIG_WITH_COMMENTS);
      const { layer } = setupExperiments({ workdir: repo.dir, goOutput: "json" });
      const before = yield* repo.read;

      return yield* Effect.gen(function* () {
        const exit = yield* experimentsEnable({ features: ["compute"] }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* repo.read).toBe(before);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});

describe("experiments disable", () => {
  it.live("records the opt-out for an enabled experiment", () =>
    Effect.gen(function* () {
      const repo = yield* project(`${CONFIG_WITH_COMMENTS}compute = true\n`);
      const { layer, out } = setupExperiments({ workdir: repo.dir });

      return yield* Effect.gen(function* () {
        yield* experimentsDisable({ features: ["compute"] });
        expect(yield* repo.read).toContain("compute = false");
        expect(out.stdoutText).toBe(`Disabled compute in ${repo.configPath}.\n`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // An absent key already resolves to off, so recording `false` would be churn.
  it.live("writes nothing for an experiment the config never mentions", () =>
    Effect.gen(function* () {
      const repo = yield* project(CONFIG_WITH_COMMENTS);
      const { layer, out } = setupExperiments({ workdir: repo.dir });
      const before = yield* repo.read;

      return yield* Effect.gen(function* () {
        yield* experimentsDisable({ features: ["stack"] });
        expect(yield* repo.read).toBe(before);
        expect(out.stdoutText).toBe(`stack is already disabled in ${repo.configPath}.\n`);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("emits a structured payload in json mode", () =>
    Effect.gen(function* () {
      const repo = yield* project(`${CONFIG_WITH_COMMENTS}compute = true\n`);
      const { layer, out } = setupExperiments({ workdir: repo.dir, format: "json" });

      return yield* Effect.gen(function* () {
        yield* experimentsDisable({ features: ["compute"] });
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            data: {
              config_path: repo.configPath,
              enabled: false,
              experiments: [{ name: "compute", previous: true, changed: true, env_override: null }],
            },
          }),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
