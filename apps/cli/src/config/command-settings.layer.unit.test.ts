import { describe, expect, it } from "@effect/vitest";
import { BunPath, BunServices } from "@effect/platform-bun";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
} from "effect";
import { vi } from "vitest";

import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { DebugFlag, ProfileFlag, WorkdirFlag } from "../command-internal/global-flags.ts";
import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { mockRuntimeInfo } from "../../tests/helpers/mocks.ts";
import { debugLoggerLayer } from "../command-internal/debug-logger.layer.ts";
import { ProfileLoadError } from "../command-internal/profile-load.ts";
import { commandSettingsLayer } from "./command-settings.layer.ts";
import { CommandSettings } from "./command-settings.service.ts";

const path = Effect.runSync(Effect.provide(Path.Path, BunPath.layer));

function makeLayer(opts: {
  profileFlag?: string;
  workdirFlag?: Option.Option<string>;
  env?: Record<string, string | undefined>;
  cwd?: string;
  home?: string;
  debug?: boolean;
  /** Raw argv for explicit `--profile` detection. */
  argv?: ReadonlyArray<string>;
}) {
  const profileFlag = opts.profileFlag ?? "supabase";
  const workdirFlag = opts.workdirFlag ?? Option.none<string>();
  return commandSettingsLayer.pipe(
    Layer.provide(debugLoggerLayer),
    Layer.provide(Layer.succeed(DebugFlag, opts.debug ?? false)),
    Layer.provide(Layer.succeed(ProfileFlag, profileFlag)),
    Layer.provide(Layer.succeed(WorkdirFlag, workdirFlag)),
    Layer.provide(Layer.succeed(CliArgs, { args: opts.argv ?? [] })),
    // Reads <homeDir>/.supabase/profile through the real filesystem, so homeDir must be a
    // per-test directory to avoid leaking stale profile files between runs.
    Layer.provide(
      mockRuntimeInfo({
        cwd: opts.cwd ?? "/test/cwd",
        homeDir: opts.home ?? path.join(tempRoot.current, "home"),
      }),
    ),
    Layer.provide(BunServices.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord(opts.env ?? {}, { preserveEmptyStrings: true }),
      ),
    ),
  );
}

// Profile load failures surface as layer-build failures.
function configExit(opts: Parameters<typeof makeLayer>[0]) {
  return Effect.service(CommandSettings).pipe(Effect.provide(makeLayer(opts)), Effect.exit);
}

function expectProfileLoadFailure(exit: Exit.Exit<unknown, unknown>, ...fragments: string[]) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    // A typed failure, not a defect — only expected errors render cleanly.
    const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
    expect(error).toBeInstanceOf(ProfileLoadError);
    const message = (error as ProfileLoadError).message;
    for (const fragment of fragments) {
      expect(message).toContain(fragment);
    }
  }
}

const tempRoot = useTempWorkdir("supabase-cli-settings-");

describe("commandSettingsLayer", () => {
  it.effect("reads updated values from a live provider through CommandSettings", () => {
    const env: Record<string, string | undefined> = {
      SUPABASE_PROJECT_ID: "first-project",
    };
    const layer = makeLayer({ cwd: tempRoot.current, env });
    const readSettings = () => Effect.service(CommandSettings).pipe(Effect.provide(layer));

    return Effect.gen(function* () {
      const first = yield* readSettings();
      env.SUPABASE_PROJECT_ID = "second-project";
      const second = yield* readSettings();

      expect(first.projectId).toEqual(Option.some("first-project"));
      expect(second.projectId).toEqual(Option.some("second-project"));
    });
  });

  it.effect("reads case-insensitive environment keys through CommandSettings", () => {
    const target: Record<string, string | undefined> = {
      supabase_project_id: "windows-project",
    };
    const env = new Proxy(target, {
      getOwnPropertyDescriptor: (_target, property) => {
        const key = String(property).toLowerCase();
        if (!Object.hasOwn(target, key)) return undefined;
        return { configurable: true, enumerable: true, writable: true, value: target[key] };
      },
      get: (_target, property) => target[String(property).toLowerCase()],
    });
    return Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.projectId).toEqual(Option.some("windows-project"));
    }).pipe(Effect.provide(makeLayer({ cwd: tempRoot.current, env })));
  });

  it.effect("defaults to supabase profile and api.supabase.com when no flags or env", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.profile).toBe("supabase");
      expect(config.profileEnvValue).toEqual(Option.none());
      expect(config.apiUrl).toBe("https://api.supabase.com");
      expect(config.projectHost).toBe("supabase.co");
      expect(config.poolerHost).toBe("supabase.com");
      expect(config.dashboardUrl).toBe("https://supabase.com/dashboard");
    }).pipe(Effect.provide(makeLayer({ cwd: tempRoot.current }))),
  );

  it.effect("uses SUPABASE_PROFILE env when the flag is left at default", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.profile).toBe("supabase-staging");
      expect(config.profileEnvValue).toEqual(Option.some("supabase-staging"));
      expect(config.apiUrl).toBe("https://api.supabase.green");
      expect(config.projectHost).toBe("supabase.red");
      expect(config.poolerHost).toBe("supabase.green");
    }).pipe(
      Effect.provide(
        makeLayer({ env: { SUPABASE_PROFILE: "supabase-staging" }, cwd: tempRoot.current }),
      ),
    ),
  );

  it.effect("captures SUPABASE_WORKDIR verbatim, preserving an empty string", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.workdirEnvValue).toEqual(Option.some(""));
    }).pipe(Effect.provide(makeLayer({ env: { SUPABASE_WORKDIR: "" }, cwd: tempRoot.current }))),
  );

  it.effect("captures an absent SUPABASE_WORKDIR as none", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(Option.isNone(config.workdirEnvValue)).toBe(true);
    }).pipe(Effect.provide(makeLayer({ env: {}, cwd: tempRoot.current }))),
  );

  it.effect("captures GITHUB_TOKEN as a redacted option", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(Option.isSome(config.githubToken)).toBe(true);
      if (Option.isSome(config.githubToken)) {
        expect(Redacted.value(config.githubToken.value)).toBe("gh-tok");
      }
    }).pipe(
      Effect.provide(
        makeLayer({
          env: { SUPABASE_DB_PASSWORD: "db-pw", GITHUB_TOKEN: "gh-tok" },
          cwd: tempRoot.current,
        }),
      ),
    ),
  );

  it.effect("captures an empty GITHUB_TOKEN as none", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(Option.isNone(config.githubToken)).toBe(true);
    }).pipe(Effect.provide(makeLayer({ env: { GITHUB_TOKEN: "" }, cwd: tempRoot.current }))),
  );

  it.effect("preserves an empty SUPABASE_PROFILE without selecting a profile", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.profile).toBe("supabase");
      expect(config.profileEnvValue).toEqual(Option.some(""));
    }).pipe(Effect.provide(makeLayer({ env: { SUPABASE_PROFILE: "" }, cwd: tempRoot.current }))),
  );

  it.effect("uses supabase-local profile and localhost API URL", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.apiUrl).toBe("http://localhost:8080");
    }).pipe(Effect.provide(makeLayer({ profileFlag: "supabase-local", cwd: tempRoot.current }))),
  );

  it.effect("resolves the snap profile API URL and project host", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.apiUrl).toBe("https://cloudapi.snap.com");
      expect(config.projectHost).toBe("snapcloud.dev");
    }).pipe(Effect.provide(makeLayer({ profileFlag: "snap", cwd: tempRoot.current }))),
  );

  it.effect("reads the persisted ~/.supabase/profile file when no flag/env is set", () => {
    const home = path.join(tempRoot.current, "home");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(home, ".supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(home, ".supabase", "profile"), "supabase-staging\n");
      const config = yield* Effect.provide(
        Effect.service(CommandSettings),
        makeLayer({ home, cwd: tempRoot.current }),
      );
      expect(config.profile).toBe("supabase-staging");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("reads the persisted profile file from SUPABASE_HOME when configured", () => {
    const home = path.join(tempRoot.current, "home");
    const supabaseHome = path.join(tempRoot.current, "custom-supabase-home");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(supabaseHome, { recursive: true });
      yield* fs.writeFileString(path.join(supabaseHome, "profile"), "supabase-staging\n");
      const config = yield* Effect.provide(
        Effect.service(CommandSettings),
        makeLayer({ home, cwd: tempRoot.current, env: { SUPABASE_HOME: supabaseHome } }),
      );
      expect(config.profile).toBe("supabase-staging");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("debug logs the persisted profile file source", () => {
    const home = path.join(tempRoot.current, "home");
    const profilePath = path.join(home, ".supabase", "profile");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(home, ".supabase"), { recursive: true });
      yield* fs.writeFileString(profilePath, "supabase-staging\n");
      const config = yield* Effect.provide(
        Effect.service(CommandSettings),
        makeLayer({ home, cwd: tempRoot.current, debug: true }),
      );
      expect(config.profile).toBe("supabase-staging");
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
        `Loading profile from file: ${profilePath}\n`,
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => stderr.mockRestore())),
      Effect.provide(BunServices.layer),
    );
  });

  it.effect("flag and env take precedence over the persisted profile file", () => {
    const home = path.join(tempRoot.current, "home");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(home, ".supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(home, ".supabase", "profile"), "supabase-staging");
      const config = yield* Effect.provide(
        Effect.service(CommandSettings),
        makeLayer({ home, cwd: tempRoot.current, env: { SUPABASE_PROFILE: "supabase-local" } }),
      );
      // SUPABASE_PROFILE wins over the file.
      expect(config.profile).toBe("supabase-local");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("fails when SUPABASE_PROFILE is neither a known name nor a readable file", () =>
    Effect.gen(function* () {
      const exit = yield* configExit({
        env: { SUPABASE_PROFILE: "rogue-profile" },
        cwd: tempRoot.current,
      });
      expectProfileLoadFailure(exit, "failed to read profile: unsupported config file type");
    }),
  );

  it.effect("fails when --profile names a non-existent profile instead of falling back", () =>
    Effect.gen(function* () {
      const exit = yield* configExit({ profileFlag: "resms", cwd: tempRoot.current });
      expectProfileLoadFailure(exit, "failed to read profile: unsupported config file type");
    }),
  );

  it.effect("matches built-in profile names case-insensitively", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.profile).toBe("supabase-staging");
      expect(config.apiUrl).toBe("https://api.supabase.green");
    }).pipe(Effect.provide(makeLayer({ profileFlag: "SUPABASE-STAGING", cwd: tempRoot.current }))),
  );

  it.effect("explicit --profile supabase shadows an unloadable SUPABASE_PROFILE", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.profile).toBe("supabase");
      expect(config.apiUrl).toBe("https://api.supabase.com");
    }).pipe(
      Effect.provide(
        makeLayer({
          argv: ["link", "--profile", "supabase"],
          env: { SUPABASE_PROFILE: "rogue-profile" },
          cwd: tempRoot.current,
        }),
      ),
    ),
  );

  it.effect("resolves repeated --profile occurrences last-wins", () =>
    Effect.gen(function* () {
      // The Effect parser is first-wins ("rogue-profile"); the last occurrence wins.
      const config = yield* CommandSettings;
      expect(config.profile).toBe("supabase");
    }).pipe(
      Effect.provide(
        makeLayer({
          argv: ["link", "--profile", "rogue-profile", "--profile", "supabase"],
          profileFlag: "rogue-profile",
          cwd: tempRoot.current,
        }),
      ),
    ),
  );

  it.effect("fails when the last --profile occurrence is unloadable", () =>
    Effect.gen(function* () {
      const exit = yield* configExit({
        argv: ["link", "--profile", "supabase", "--profile", "resms"],
        profileFlag: "supabase",
        cwd: tempRoot.current,
      });
      expectProfileLoadFailure(exit, "failed to read profile: unsupported config file type");
    }),
  );

  it.effect("explicit --profile supabase shadows an unloadable persisted profile file", () => {
    const home = path.join(tempRoot.current, "home");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(home, ".supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(home, ".supabase", "profile"), "resms\n");
      const config = yield* Effect.provide(
        Effect.service(CommandSettings),
        makeLayer({ argv: ["login", "--profile=supabase"], home, cwd: tempRoot.current }),
      );
      expect(config.profile).toBe("supabase");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("loads api_url, name, pooler_host, and dashboard_url from a YAML profile file", () => {
    const profilePath = path.join(tempRoot.current, "profile.yaml");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        profilePath,
        [
          "name: cli-e2e",
          'api_url: "http://127.0.0.1:9999"',
          "project_host: localhost",
          "pooler_host: staging.example.com",
          'dashboard_url: "http://127.0.0.1:9999"',
        ].join("\n"),
      );
      const config = yield* Effect.provide(
        Effect.service(CommandSettings),
        makeLayer({ env: { SUPABASE_PROFILE: profilePath }, cwd: tempRoot.current }),
      );
      expect(config.profile).toBe("cli-e2e");
      expect(config.profileEnvValue).toEqual(Option.some(profilePath));
      expect(config.apiUrl).toBe("http://127.0.0.1:9999");
      expect(config.projectHost).toBe("localhost");
      expect(config.poolerHost).toBe("staging.example.com");
      // dashboard_url feeds the connect-failure hint; cli-e2e points it at its replay server.
      expect(config.dashboardUrl).toBe("http://127.0.0.1:9999");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("keeps pooler_host empty when a YAML profile omits it", () => {
    const profilePath = path.join(tempRoot.current, "no-pooler.yaml");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        profilePath,
        [
          "name: cli-e2e",
          'api_url: "http://127.0.0.1:9999"',
          'dashboard_url: "http://127.0.0.1:9999"',
          "project_host: localhost",
        ].join("\n"),
      );
      const config = yield* Effect.provide(
        Effect.service(CommandSettings),
        makeLayer({ env: { SUPABASE_PROFILE: profilePath }, cwd: tempRoot.current }),
      );
      expect(config.projectHost).toBe("localhost");
      // An absent pooler_host disables the MITM domain assertion rather
      // than falling back to supabase.com.
      expect(config.poolerHost).toBe("");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("fails when a YAML profile omits required keys", () => {
    const profilePath = path.join(tempRoot.current, "no-host.yaml");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        profilePath,
        ["name: cli-e2e", 'api_url: "http://127.0.0.1:9999"'].join("\n"),
      );
      const exit = yield* configExit({
        env: { SUPABASE_PROFILE: profilePath },
        cwd: tempRoot.current,
      });
      expectProfileLoadFailure(
        exit,
        "invalid profile:",
        "dashboard_url is required",
        "project_host is required",
      );
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("fails when SUPABASE_PROFILE points to a non-existent file", () =>
    Effect.gen(function* () {
      const missingPath = path.join(tempRoot.current, "missing.yaml");
      const exit = yield* configExit({
        env: { SUPABASE_PROFILE: missingPath },
        cwd: tempRoot.current,
      });
      expectProfileLoadFailure(
        exit,
        `failed to read profile: open ${missingPath}: no such file or directory`,
      );
    }),
  );

  it.effect("fails when SUPABASE_PROFILE points to malformed YAML", () => {
    const profilePath = path.join(tempRoot.current, "broken.yaml");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(profilePath, "::: not yaml :::\n[unbalanced");
      const exit = yield* configExit({
        env: { SUPABASE_PROFILE: profilePath },
        cwd: tempRoot.current,
      });
      expectProfileLoadFailure(exit, "failed to read profile: invalid config file:");
    }).pipe(Effect.provide(BunServices.layer));
  });

  // Files written by older, more lenient CLI versions may still exist on disk and must
  // still fail validation.
  it.effect("fails when the persisted profile file names an unloadable profile", () => {
    const home = path.join(tempRoot.current, "home");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(home, ".supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(home, ".supabase", "profile"), "resms\n");
      const exit = yield* configExit({ home, cwd: tempRoot.current });
      expectProfileLoadFailure(exit, "failed to read profile: unsupported config file type");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("ignores SUPABASE_API_URL", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.apiUrl).toBe("https://api.supabase.com");
    }).pipe(
      Effect.provide(
        makeLayer({ env: { SUPABASE_API_URL: "https://nope.example.com" }, cwd: tempRoot.current }),
      ),
    ),
  );

  it.effect("captures SUPABASE_ACCESS_TOKEN as a Redacted value", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(Option.isSome(config.accessToken)).toBe(true);
      if (Option.isSome(config.accessToken)) {
        expect(Redacted.value(config.accessToken.value)).toBe("sbp_test");
      }
    }).pipe(
      Effect.provide(
        makeLayer({ env: { SUPABASE_ACCESS_TOKEN: "sbp_test" }, cwd: tempRoot.current }),
      ),
    ),
  );

  it.effect("captures SUPABASE_PROJECT_ID env", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(Option.getOrUndefined(config.projectId)).toBe("myrefabcdefghijklmno");
    }).pipe(
      Effect.provide(
        makeLayer({ env: { SUPABASE_PROJECT_ID: "myrefabcdefghijklmno" }, cwd: tempRoot.current }),
      ),
    ),
  );

  it.effect(
    "preserves an empty profile value while treating empty credentials and workdir as absent",
    () =>
      Effect.gen(function* () {
        const config = yield* CommandSettings;
        expect(config.profileEnvValue).toEqual(Option.some(""));
        expect(Option.isNone(config.accessToken)).toBe(true);
        expect(Option.isNone(config.projectId)).toBe(true);
        expect(config.workdir).toBe(tempRoot.current);
        expect(config.explicitWorkdir).toBe(false);
      }).pipe(
        Effect.provide(
          makeLayer({
            env: {
              SUPABASE_PROFILE: "",
              SUPABASE_ACCESS_TOKEN: "",
              SUPABASE_PROJECT_ID: "",
              SUPABASE_WORKDIR: "",
            },
            cwd: tempRoot.current,
          }),
        ),
      ),
  );

  it.effect("prefers --workdir flag over env and walk-up", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.workdir).toBe("/flag/workdir");
      expect(config.explicitWorkdir).toBe(true);
    }).pipe(
      Effect.provide(
        makeLayer({
          workdirFlag: Option.some("/flag/workdir"),
          env: { SUPABASE_WORKDIR: "/env/workdir" },
          cwd: tempRoot.current,
        }),
      ),
    ),
  );

  it.effect("uses SUPABASE_WORKDIR env when flag is unset", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.workdir).toBe("/env/workdir");
      expect(config.explicitWorkdir).toBe(true);
    }).pipe(
      Effect.provide(
        makeLayer({ env: { SUPABASE_WORKDIR: "/env/workdir" }, cwd: tempRoot.current }),
      ),
    ),
  );

  it.effect(
    "an empty --workdir flag falls through to SUPABASE_WORKDIR env, which is still explicit",
    () =>
      Effect.gen(function* () {
        const config = yield* CommandSettings;
        expect(config.workdir).toBe("/env/workdir");
        expect(config.explicitWorkdir).toBe(true);
      }).pipe(
        Effect.provide(
          makeLayer({
            workdirFlag: Option.some(""),
            env: { SUPABASE_WORKDIR: "/env/workdir" },
            cwd: tempRoot.current,
          }),
        ),
      ),
  );

  it.effect("an empty --workdir flag with no env falls through to the walk-up", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.workdir).toBe(tempRoot.current);
      expect(config.explicitWorkdir).toBe(false);
    }).pipe(Effect.provide(makeLayer({ workdirFlag: Option.some(""), cwd: tempRoot.current }))),
  );

  it.effect("resolves a relative --workdir flag against the real cwd", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.workdir).toBe(tempRoot.current);
    }).pipe(Effect.provide(makeLayer({ workdirFlag: Option.some("."), cwd: tempRoot.current }))),
  );

  it.effect("resolves a relative --workdir flag with a subdirectory against the real cwd", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.workdir).toBe(path.join(tempRoot.current, "sub"));
    }).pipe(Effect.provide(makeLayer({ workdirFlag: Option.some("sub"), cwd: tempRoot.current }))),
  );

  it.effect("resolves a relative SUPABASE_WORKDIR env value against the real cwd", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.workdir).toBe(tempRoot.current);
    }).pipe(Effect.provide(makeLayer({ env: { SUPABASE_WORKDIR: "." }, cwd: tempRoot.current }))),
  );

  it.effect("keeps an absolute --workdir flag unchanged", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.workdir).toBe("/flag/workdir");
    }).pipe(
      Effect.provide(
        makeLayer({ workdirFlag: Option.some("/flag/workdir"), cwd: tempRoot.current }),
      ),
    ),
  );

  it.effect("walks up from CWD looking for supabase/config.toml", () => {
    const projectRoot = path.join(tempRoot.current, "project");
    const nested = path.join(projectRoot, "deep", "child");

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        'project_id = "x"\n',
      );
      const config = yield* Effect.provide(
        Effect.service(CommandSettings),
        makeLayer({ cwd: nested }),
      );
      expect(config.workdir).toBe(projectRoot);
      expect(config.explicitWorkdir).toBe(false);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("walks up from CWD to a project that only has supabase/config.json", () => {
    const projectRoot = path.join(tempRoot.current, "json-project");
    const nested = path.join(projectRoot, "apps", "web");

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.json"),
        '{"project_id":"x"}\n',
      );
      const config = yield* Effect.provide(
        Effect.service(CommandSettings),
        makeLayer({ cwd: nested }),
      );
      expect(config.workdir).toBe(projectRoot);
      expect(config.explicitWorkdir).toBe(false);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("uses an explicit --workdir below a config.json project verbatim", () => {
    const projectRoot = path.join(tempRoot.current, "json-project");
    const below = path.join(projectRoot, "apps", "web");

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), { recursive: true });
      yield* fs.makeDirectory(below, { recursive: true });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.json"),
        '{"project_id":"x"}\n',
      );
      const config = yield* Effect.provide(
        Effect.service(CommandSettings),
        makeLayer({ workdirFlag: Option.some(below), cwd: projectRoot }),
      );
      expect(config.workdir).toBe(below);
      expect(config.explicitWorkdir).toBe(true);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("picks the directory holding both config files over an enclosing project", () => {
    const outer = path.join(tempRoot.current, "outer");
    const inner = path.join(outer, "packages", "inner");
    const nested = path.join(inner, "src");

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(outer, "supabase"), { recursive: true });
      yield* fs.makeDirectory(path.join(inner, "supabase"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* fs.writeFileString(
        path.join(outer, "supabase", "config.json"),
        '{"project_id":"outer"}\n',
      );
      yield* fs.writeFileString(
        path.join(inner, "supabase", "config.json"),
        '{"project_id":"inner"}\n',
      );
      yield* fs.writeFileString(
        path.join(inner, "supabase", "config.toml"),
        'project_id = "inner"\n',
      );
      const config = yield* Effect.provide(
        Effect.service(CommandSettings),
        makeLayer({ cwd: nested }),
      );
      expect(config.workdir).toBe(inner);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("falls back to CWD when no supabase/config.toml found", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      expect(config.workdir).toBe(tempRoot.current);
      expect(config.explicitWorkdir).toBe(false);
    }).pipe(Effect.provide(makeLayer({ cwd: tempRoot.current }))),
  );

  it.effect("populates userAgent from CLI_VERSION", () =>
    Effect.gen(function* () {
      const config = yield* CommandSettings;
      // The sentinel `0.0.0-dev` value applies when SUPABASE_CLI_VERSION is unset (tests).
      expect(config.userAgent).toMatch(/^SupabaseCLI\//);
    }).pipe(Effect.provide(makeLayer({ cwd: tempRoot.current }))),
  );
});
