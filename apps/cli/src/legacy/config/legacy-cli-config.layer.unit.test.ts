import { describe, expect, it } from "@effect/vitest";
import { BunPath, BunServices } from "@effect/platform-bun";
import { Cause, Effect, FileSystem, Exit, Layer, Option, Path, Redacted } from "effect";
import { vi } from "vitest";

import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyProfileFlag,
  LegacyWorkdirFlag,
} from "../../shared/legacy/global-flags.ts";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";
import { legacyDebugLoggerLayer } from "../shared/legacy-debug-logger.layer.ts";
import { LegacyProfileLoadError } from "../shared/legacy-profile-load.ts";
import { legacyCliConfigLayer } from "./legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "./legacy-cli-config.service.ts";

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
  const configLayer = legacyCliConfigLayer.pipe(
    Layer.provide(legacyDebugLoggerLayer),
    Layer.provide(Layer.succeed(LegacyDebugFlag, opts.debug ?? false)),
    Layer.provide(Layer.succeed(LegacyProfileFlag, profileFlag)),
    Layer.provide(Layer.succeed(LegacyWorkdirFlag, workdirFlag)),
    Layer.provide(Layer.succeed(CliArgs, { args: opts.argv ?? [] })),
    // The layer reads `<homeDir>/.supabase/profile` through the real BunServices
    // filesystem, so homeDir must default to a per-test directory — a shared
    // fixed path would leak stale profile files between runs and machines.
    Layer.provide(
      mockRuntimeInfo({
        cwd: opts.cwd ?? "/test/cwd",
        homeDir: opts.home ?? path.join(tempRoot.current, "home"),
      }),
    ),
    Layer.provide(BunServices.layer),
    Layer.provide(processEnvLayer(opts.env ?? {})),
  );
  return Layer.mergeAll(configLayer, BunServices.layer);
}

// Profile load failures surface as layer-build failures (Go: PersistentPreRunE).
function configExit(opts: Parameters<typeof makeLayer>[0]) {
  return Effect.exit(LegacyCliConfig.pipe(Effect.provide(makeLayer(opts))));
}

function profileFixtureLayer(fixtures: ReadonlyArray<readonly [string, string]>) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      for (const [filePath, contents] of fixtures) {
        yield* fs.makeDirectory(pathService.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, contents);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
}

function makeLayerWithFixtures(
  opts: Parameters<typeof makeLayer>[0],
  fixtures: ReadonlyArray<readonly [string, string]>,
) {
  return makeLayer(opts).pipe(Layer.provide(profileFixtureLayer(fixtures)));
}

function configExitWithFixtures(
  opts: Parameters<typeof makeLayer>[0],
  fixtures: ReadonlyArray<readonly [string, string]>,
) {
  return Effect.exit(LegacyCliConfig.pipe(Effect.provide(makeLayerWithFixtures(opts, fixtures))));
}

function expectProfileLoadFailure(exit: Exit.Exit<unknown, unknown>, ...fragments: string[]) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    // A typed failure, not a defect — only expected errors render cleanly.
    const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
    expect(error).toBeInstanceOf(LegacyProfileLoadError);
    const message = (error as LegacyProfileLoadError).message;
    for (const fragment of fragments) {
      expect(message).toContain(fragment);
    }
  }
}

const tempRoot = useLegacyTempWorkdir("supabase-legacy-cli-config-");
const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));

describe("legacyCliConfigLayer", () => {
  it.effect("defaults to supabase profile and api.supabase.com when no flags or env", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("supabase");
      expect(config.apiUrl).toBe("https://api.supabase.com");
      expect(config.projectHost).toBe("supabase.co");
      expect(config.poolerHost).toBe("supabase.com");
      expect(config.dashboardUrl).toBe("https://supabase.com/dashboard");
    }).pipe(Effect.provide(makeLayer({ cwd: tempRoot.current }))),
  );

  it.effect("uses SUPABASE_PROFILE env when the flag is left at default", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("supabase-staging");
      expect(config.apiUrl).toBe("https://api.supabase.green");
      expect(config.projectHost).toBe("supabase.red");
      expect(config.poolerHost).toBe("supabase.green");
    }).pipe(
      Effect.provide(
        makeLayer({ env: { SUPABASE_PROFILE: "supabase-staging" }, cwd: tempRoot.current }),
      ),
    ),
  );

  it.effect("uses supabase-local profile and localhost API URL", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.apiUrl).toBe("http://localhost:8080");
    }).pipe(Effect.provide(makeLayer({ profileFlag: "supabase-local", cwd: tempRoot.current }))),
  );

  it.effect("resolves the snap profile API URL and project host", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
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
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("supabase-staging");
    }).pipe(
      Effect.provide(
        makeLayerWithFixtures({ home, cwd: tempRoot.current }, [
          [path.join(home, ".supabase", "profile"), "supabase-staging\n"],
        ]),
      ),
    );
  });

  it.effect("reads the persisted profile file from SUPABASE_HOME when configured", () => {
    const home = path.join(tempRoot.current, "home");
    const supabaseHome = path.join(tempRoot.current, "custom-supabase-home");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(supabaseHome, { recursive: true });
      yield* fs.writeFileString(path.join(supabaseHome, "profile"), "supabase-staging\n");
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("supabase-staging");
    }).pipe(
      Effect.provide(
        makeLayerWithFixtures(
          { home, cwd: tempRoot.current, env: { SUPABASE_HOME: supabaseHome } },
          [[path.join(supabaseHome, "profile"), "supabase-staging\n"]],
        ),
      ),
    );
  });

  it.effect("debug logs the persisted profile file source", () => {
    const home = path.join(tempRoot.current, "home");
    const profilePath = path.join(home, ".supabase", "profile");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(home, ".supabase"), { recursive: true });
      yield* fs.writeFileString(profilePath, "supabase-staging\n");
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("supabase-staging");
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
        `Loading profile from file: ${profilePath}\n`,
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => stderr.mockRestore())),
      Effect.provide(
        makeLayerWithFixtures({ home, cwd: tempRoot.current, debug: true }, [
          [profilePath, "supabase-staging\n"],
        ]),
      ),
    );
  });

  it.effect("flag and env take precedence over the persisted profile file", () => {
    const home = path.join(tempRoot.current, "home");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(home, ".supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(home, ".supabase", "profile"), "supabase-staging");
      const config = yield* LegacyCliConfig;
      // SUPABASE_PROFILE wins over the file.
      expect(config.profile).toBe("supabase-local");
    }).pipe(
      Effect.provide(
        makeLayerWithFixtures(
          { home, cwd: tempRoot.current, env: { SUPABASE_PROFILE: "supabase-local" } },
          [[path.join(home, ".supabase", "profile"), "supabase-staging"]],
        ),
      ),
    );
  });

  // Go fails hard on an unloadable profile — never falls back to the built-in
  // `supabase` profile and its keyring token (supabase/cli#6091).
  it.effect(
    "fails when SUPABASE_PROFILE is neither a known name nor a readable file — Go parity",
    () =>
      Effect.gen(function* () {
        const exit = yield* configExit({
          env: { SUPABASE_PROFILE: "rogue-profile" },
          cwd: tempRoot.current,
        });
        expectProfileLoadFailure(exit, "failed to read profile: Unsupported Config Type");
      }),
  );

  it.effect("fails when --profile names a non-existent profile instead of falling back", () =>
    Effect.gen(function* () {
      const exit = yield* configExit({ profileFlag: "resms", cwd: tempRoot.current });
      expectProfileLoadFailure(exit, "failed to read profile: Unsupported Config Type");
    }),
  );

  it.effect("matches built-in profile names case-insensitively — Go strings.EqualFold", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("supabase-staging");
      expect(config.apiUrl).toBe("https://api.supabase.green");
    }).pipe(Effect.provide(makeLayer({ profileFlag: "SUPABASE-STAGING", cwd: tempRoot.current }))),
  );

  // pflag `Changed`: an explicitly passed flag counts even at its default value.
  it.effect(
    "explicit --profile supabase shadows an unloadable SUPABASE_PROFILE — pflag Changed",
    () =>
      Effect.gen(function* () {
        const config = yield* LegacyCliConfig;
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

  it.effect("resolves repeated --profile occurrences last-wins — pflag parity", () =>
    Effect.gen(function* () {
      // The Effect parser is first-wins ("rogue-profile"); pflag keeps the last.
      const config = yield* LegacyCliConfig;
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

  it.effect("fails when the last --profile occurrence is unloadable — pflag parity", () =>
    Effect.gen(function* () {
      const exit = yield* configExit({
        argv: ["link", "--profile", "supabase", "--profile", "resms"],
        profileFlag: "supabase",
        cwd: tempRoot.current,
      });
      expectProfileLoadFailure(exit, "failed to read profile: Unsupported Config Type");
    }),
  );

  it.effect("explicit --profile supabase shadows an unloadable persisted profile file", () => {
    const home = path.join(tempRoot.current, "home");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(home, ".supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(home, ".supabase", "profile"), "resms\n");
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("supabase");
    }).pipe(
      Effect.provide(
        makeLayerWithFixtures(
          { argv: ["login", "--profile=supabase"], home, cwd: tempRoot.current },
          [[path.join(home, ".supabase", "profile"), "resms\n"]],
        ),
      ),
    );
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
      const config = yield* LegacyCliConfig;
      expect(config.profile).toBe("cli-e2e");
      expect(config.apiUrl).toBe("http://127.0.0.1:9999");
      expect(config.projectHost).toBe("localhost");
      expect(config.poolerHost).toBe("staging.example.com");
      // Go reads `dashboard_url` from the profile (used by the connect-failure hint);
      // the cli-e2e harness points it at the replay server for parity.
      expect(config.dashboardUrl).toBe("http://127.0.0.1:9999");
    }).pipe(
      Effect.provide(
        makeLayerWithFixtures({ env: { SUPABASE_PROFILE: profilePath }, cwd: tempRoot.current }, [
          [
            profilePath,
            'name: cli-e2e\napi_url: "http://127.0.0.1:9999"\nproject_host: localhost\npooler_host: staging.example.com\ndashboard_url: "http://127.0.0.1:9999"',
          ],
        ]),
      ),
    );
  });

  it.effect("keeps pooler_host empty when a YAML profile omits it — Go omitempty", () => {
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
      const config = yield* LegacyCliConfig;
      expect(config.projectHost).toBe("localhost");
      // An absent pooler_host disables the MITM domain assertion rather
      // than falling back to supabase.com.
      expect(config.poolerHost).toBe("");
    }).pipe(
      Effect.provide(
        makeLayerWithFixtures({ env: { SUPABASE_PROFILE: profilePath }, cwd: tempRoot.current }, [
          [
            profilePath,
            'name: cli-e2e\napi_url: "http://127.0.0.1:9999"\ndashboard_url: "http://127.0.0.1:9999"\nproject_host: localhost',
          ],
        ]),
      ),
    );
  });

  it.effect("fails when a YAML profile omits required keys — Go validator parity", () => {
    const profilePath = path.join(tempRoot.current, "no-host.yaml");
    return Effect.gen(function* () {
      const exit = yield* configExitWithFixtures(
        { env: { SUPABASE_PROFILE: profilePath }, cwd: tempRoot.current },
        [[profilePath, 'name: cli-e2e\napi_url: "http://127.0.0.1:9999"']],
      );
      expectProfileLoadFailure(
        exit,
        "invalid profile:",
        "Field validation for 'DashboardURL' failed on the 'required' tag",
        "Field validation for 'ProjectHost' failed on the 'required' tag",
      );
    });
  });

  it.effect("fails when SUPABASE_PROFILE points to a non-existent file — Go parity", () =>
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

  it.effect("fails when SUPABASE_PROFILE points to malformed YAML — Go parity", () => {
    const profilePath = path.join(tempRoot.current, "broken.yaml");
    return Effect.gen(function* () {
      const exit = yield* configExitWithFixtures(
        { env: { SUPABASE_PROFILE: profilePath }, cwd: tempRoot.current },
        [[profilePath, "::: not yaml :::\n[unbalanced"]],
      );
      expectProfileLoadFailure(exit, "failed to read profile: While parsing config:");
    });
  });

  // Files written by older lenient versions still exist and must fail like Go.
  it.effect("fails when the persisted profile file names an unloadable profile", () => {
    const home = path.join(tempRoot.current, "home");
    return Effect.gen(function* () {
      const exit = yield* configExitWithFixtures({ home, cwd: tempRoot.current }, [
        [path.join(home, ".supabase", "profile"), "resms\n"],
      ]);
      expectProfileLoadFailure(exit, "failed to read profile: Unsupported Config Type");
    });
  });

  it.effect("ignores SUPABASE_API_URL — Go parity", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.apiUrl).toBe("https://api.supabase.com");
    }).pipe(
      Effect.provide(
        makeLayer({ env: { SUPABASE_API_URL: "https://nope.example.com" }, cwd: tempRoot.current }),
      ),
    ),
  );

  it.effect("captures SUPABASE_ACCESS_TOKEN as a Redacted value", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
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
      const config = yield* LegacyCliConfig;
      expect(Option.getOrUndefined(config.projectId)).toBe("myrefabcdefghijklmno");
    }).pipe(
      Effect.provide(
        makeLayer({ env: { SUPABASE_PROJECT_ID: "myrefabcdefghijklmno" }, cwd: tempRoot.current }),
      ),
    ),
  );

  it.effect("prefers --workdir flag over env and walk-up", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.workdir).toBe("/flag/workdir");
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
      const config = yield* LegacyCliConfig;
      expect(config.workdir).toBe("/env/workdir");
    }).pipe(
      Effect.provide(
        makeLayer({ env: { SUPABASE_WORKDIR: "/env/workdir" }, cwd: tempRoot.current }),
      ),
    ),
  );

  // Every later reader of the resolved workdir — including the
  // `Config.ProjectId` cwd-basename default — must see the real absolute
  // directory, never the raw flag/env string. A relative `--workdir
  // .`/`SUPABASE_WORKDIR=.` must therefore resolve to an absolute path
  // here too, not stay `"."` (which would later basename to an empty
  // project id).
  it.effect("resolves a relative --workdir flag against the real cwd", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.workdir).toBe(tempRoot.current);
    }).pipe(Effect.provide(makeLayer({ workdirFlag: Option.some("."), cwd: tempRoot.current }))),
  );

  it.effect("resolves a relative --workdir flag with a subdirectory against the real cwd", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.workdir).toBe(path.join(tempRoot.current, "sub"));
    }).pipe(Effect.provide(makeLayer({ workdirFlag: Option.some("sub"), cwd: tempRoot.current }))),
  );

  it.effect("resolves a relative SUPABASE_WORKDIR env value against the real cwd", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.workdir).toBe(tempRoot.current);
    }).pipe(Effect.provide(makeLayer({ env: { SUPABASE_WORKDIR: "." }, cwd: tempRoot.current }))),
  );

  it.effect("keeps an absolute --workdir flag unchanged", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
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
      const config = yield* LegacyCliConfig;
      expect(config.workdir).toBe(projectRoot);
    }).pipe(
      Effect.provide(
        makeLayerWithFixtures({ cwd: nested }, [
          [path.join(projectRoot, "supabase", "config.toml"), 'project_id = "x"\n'],
        ]),
      ),
    );
  });

  it.effect("falls back to CWD when no supabase/config.toml found", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      expect(config.workdir).toBe(tempRoot.current);
    }).pipe(Effect.provide(makeLayer({ cwd: tempRoot.current }))),
  );

  it.effect("populates userAgent from CLI_VERSION", () =>
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      // The sentinel `0.0.0-dev` value applies when SUPABASE_CLI_VERSION is unset (tests).
      expect(config.userAgent).toMatch(/^SupabaseCLI\//);
    }).pipe(Effect.provide(makeLayer({ cwd: tempRoot.current }))),
  );
});
