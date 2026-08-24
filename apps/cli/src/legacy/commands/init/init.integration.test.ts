import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Stdio,
} from "effect";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  LegacyExperimentalFlag,
  LegacyWorkdirFlag,
  LegacyYesFlag,
} from "../../../shared/legacy/global-flags.ts";
import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { textOutputLayer } from "../../../shared/output/output.layer.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { stripAnsi } from "../../../../tests/helpers/ansi.ts";
import {
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import { useLegacyTempWorkdir } from "../../../../tests/helpers/legacy-mocks.ts";
import { legacyInit } from "./init.handler.ts";
import { makeLegacyViperEnvLayer } from "../../../shared/legacy/legacy-viper-env.ts";

const tempRoot = useLegacyTempWorkdir("supabase-legacy-init-");

function readProjectFile(...segments: string[]) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(...segments));
  }).pipe(Effect.provide(BunServices.layer));
}

function setup(
  cwd: string,
  opts: {
    experimental?: boolean;
    workdir?: Option.Option<string>;
    interactive?: boolean;
    stdinIsTty?: boolean;
    yes?: boolean;
    /** Piped stdin lines consumed by the non-TTY IDE-settings confirm reads. */
    stdinInput?: string;
    env?: Readonly<Record<string, string | undefined>>;
    platform?: NodeJS.Platform;
  } = {},
) {
  const out = mockOutput({ format: "text", interactive: opts.interactive ?? false });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value !== undefined) env[key] = value;
  }
  const configProvider = ConfigProvider.fromEnv({ env, preserveEmptyStrings: true });
  return {
    out,
    layer: Layer.mergeAll(
      BunServices.layer,
      out.layer,
      mockRuntimeInfo({ cwd, platform: opts.platform }),
      mockTty({
        stdinIsTty: opts.stdinIsTty ?? false,
        stdoutIsTty: opts.interactive ?? false,
      }),
      mockStdin(opts.stdinIsTty ?? false, opts.stdinInput),
      Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? false),
      Layer.succeed(LegacyWorkdirFlag, opts.workdir ?? Option.none()),
      Layer.succeed(LegacyYesFlag, opts.yes ?? false),
      Layer.succeed(CliArgs, { args: [] }),
      ConfigProvider.layer(configProvider),
      makeLegacyViperEnvLayer(configProvider),
    ),
  };
}

function findFailure(exit: Exit.Exit<unknown, unknown>): Record<string, unknown> {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    return {};
  }

  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  return Option.isSome(failure) ? (failure.value as Record<string, unknown>) : {};
}

/**
 * Renders a handler failure exactly like the real CLI does — `normalizeCause`
 * followed by the production text output layer's `fail` — and returns the
 * captured stderr writes (ANSI-stripped). This locks the composed two-line
 * stderr contract documented in SIDE_EFFECTS.md, not just the error fields.
 */
function renderFailureToStderr(exit: Exit.Exit<unknown, unknown>) {
  return Effect.gen(function* () {
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) {
      return [];
    }

    const writes: Array<string> = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(stripAnsi(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)));
      return true;
    }) as typeof process.stderr.write;

    yield* Effect.gen(function* () {
      const out = yield* Output;
      yield* out.fail(normalizeCause(exit.cause));
    }).pipe(
      Effect.provide(
        textOutputLayer.pipe(Layer.provide(Layer.mergeAll(mockTty({}), Stdio.layerTest({})))),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          process.stderr.write = originalWrite;
        }),
      ),
    );

    return writes;
  });
}

describe("legacy init", () => {
  it.live("creates config.toml natively without the Go proxy", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir);

      yield* legacyInit({
        interactive: false,
        useOrioledb: false,
        force: false,
        withVscodeWorkspace: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      }).pipe(Effect.provide(layer));

      const content = yield* readProjectFile(tempDir, "supabase", "config.toml");
      expect(content).toContain("major_version = 17");
      expect(out.stdoutText).toBe("Finished supabase init.\n");
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("requires --experimental when --use-orioledb is set, with cobra's exact wording", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer } = setup(tempDir, { experimental: false });

      const exit = yield* legacyInit({
        interactive: false,
        useOrioledb: true,
        force: false,
        withVscodeWorkspace: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      }).pipe(Effect.provide(layer), Effect.exit);

      // `experimental` is marked required in PreRun, so the user sees
      // cobra's standard message. No suggestion — the text output layer
      // appends the generic `--debug` troubleshooting hint instead.
      const error = findFailure(exit);
      expect(error["_tag"]).toBe("LegacyInitExperimentalRequiredError");
      expect(error["message"]).toBe(`required flag(s) "experimental" not set`);
      expect(error["suggestion"]).toBeUndefined();

      // Composed stderr byte-matches `recoverAndExit`'s output.
      expect(yield* renderFailureToStderr(exit)).toEqual([
        `required flag(s) "experimental" not set\n`,
        "Try rerunning the command with --debug to troubleshoot the error.\n",
      ]);
    });
  });

  it.live("fails with Go's exact error when config.toml already exists", () => {
    const tempDir = tempRoot.current;

    const initFlags = {
      interactive: false,
      useOrioledb: false,
      force: false,
      withVscodeWorkspace: false,
      withVscodeSettings: false,
      withIntellijSettings: false,
    };

    return Effect.gen(function* () {
      const { layer } = setup(tempDir);

      yield* legacyInit(initFlags).pipe(Effect.provide(layer));
      const exit = yield* legacyInit(initFlags).pipe(Effect.provide(layer), Effect.exit);

      // Byte-matches the wrapped `O_EXCL` `*os.PathError` from
      // `utils.InitConfig` (`config.go:243-246`) plus its CmdSuggestion.
      const error = findFailure(exit);
      expect(error["_tag"]).toBe("LegacyInitConfigExistsError");
      expect(error["message"]).toBe(
        "failed to create config file: open supabase/config.toml: file exists",
      );
      expect(error["suggestion"]).toBe(
        "Run supabase init --force to overwrite existing config file.",
      );

      // Composed stderr byte-matches `recoverAndExit`'s output (Linux/macOS).
      expect(yield* renderFailureToStderr(exit)).toEqual([
        "failed to create config file: open supabase/config.toml: file exists\n",
        "Run supabase init --force to overwrite existing config file.\n",
      ]);
    });
  });

  it.live("renders the Windows form of the already-exists error on win32", () => {
    const tempDir = tempRoot.current;

    const initFlags = {
      interactive: false,
      useOrioledb: false,
      force: false,
      withVscodeWorkspace: false,
      withVscodeSettings: false,
      withIntellijSettings: false,
    };

    return Effect.gen(function* () {
      const { layer } = setup(tempDir, { platform: "win32" });

      yield* legacyInit(initFlags).pipe(Effect.provide(layer));
      const exit = yield* legacyInit(initFlags).pipe(Effect.provide(layer), Effect.exit);

      // On Windows, `utils.ConfigPath` is built with `filepath.Join`
      // (`utils/misc.go:82`) — backslash separator — and the `O_EXCL` open
      // fails with `ERROR_FILE_EXISTS`, rendered by `syscall.Errno.Error()` as
      // `The file exists.`. The suggestion is unchanged because
      // `errors.Is(err, os.ErrExist)` matches on Windows too.
      const error = findFailure(exit);
      expect(error["_tag"]).toBe("LegacyInitConfigExistsError");
      expect(error["message"]).toBe(
        "failed to create config file: open supabase\\config.toml: The file exists.",
      );
      expect(error["suggestion"]).toBe(
        "Run supabase init --force to overwrite existing config file.",
      );

      // Composed stderr byte-matches `recoverAndExit`'s output (Windows).
      expect(yield* renderFailureToStderr(exit)).toEqual([
        "failed to create config file: open supabase\\config.toml: The file exists.\n",
        "Run supabase init --force to overwrite existing config file.\n",
      ]);
    });
  });

  it.live("supports the hidden IDE flags natively", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir);

      yield* legacyInit({
        interactive: false,
        useOrioledb: false,
        force: false,
        withVscodeWorkspace: true,
        withVscodeSettings: false,
        withIntellijSettings: true,
      }).pipe(Effect.provide(layer));

      expect(yield* readProjectFile(tempDir, ".vscode", "extensions.json")).toContain(
        '"recommendations"',
      );
      expect(yield* readProjectFile(tempDir, ".vscode", "settings.json")).toContain(
        '"deno.enablePaths"',
      );
      expect(yield* readProjectFile(tempDir, ".idea", "deno.xml")).toContain(
        '<component name="DenoSettings">',
      );
      expect(out.stdoutText).toContain("Generated VS Code settings in .vscode/settings.json.");
      expect(out.stdoutText).toContain("Generated IntelliJ settings in .idea/deno.xml.");
    });
  });

  it.live("respects the legacy --workdir global flag", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const workdir = path.join(tempDir, "nested");
      const { layer } = setup(tempDir, { workdir: Option.some("nested") });

      yield* legacyInit({
        interactive: false,
        useOrioledb: false,
        force: false,
        withVscodeWorkspace: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      }).pipe(Effect.provide(layer));

      const content = yield* readProjectFile(workdir, "supabase", "config.toml");
      expect(content).toContain("major_version = 17");
    }).pipe(Effect.provide(BunServices.layer));
  });

  // ---------------------------------------------------------------------------
  // `-i` + `--yes`/`SUPABASE_YES` — `PromptForIDESettings` goes through
  // `PromptYesNo`, so the global YES auto-accepts the VS Code question with the
  // `[Y/n] y` stderr echo instead of prompting anyway (CLI-1974).
  // ---------------------------------------------------------------------------

  const BASE_INIT_FLAGS = {
    useOrioledb: false,
    force: false,
    withVscodeWorkspace: false,
    withVscodeSettings: false,
    withIntellijSettings: false,
  } as const;

  it.live("init -i --yes writes VS Code settings with the Go echo instead of prompting", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, { interactive: true, stdinIsTty: true, yes: true });

      yield* legacyInit({ ...BASE_INIT_FLAGS, interactive: true }).pipe(Effect.provide(layer));

      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y\n");
      // Go returns after writing VS Code settings — IntelliJ is never asked.
      expect(out.stderrText).not.toContain("IntelliJ");
      expect(yield* readProjectFile(tempDir, ".vscode", "settings.json")).toContain(
        '"deno.enablePaths"',
      );
    });
  });

  it.live("init -i with SUPABASE_YES=1 auto-accepts the VS Code prompt like --yes", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, {
        interactive: true,
        stdinIsTty: true,
        env: { SUPABASE_YES: "1" },
      });

      yield* legacyInit({ ...BASE_INIT_FLAGS, interactive: true }).pipe(Effect.provide(layer));

      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y\n");
      expect(yield* readProjectFile(tempDir, ".vscode", "settings.json")).toContain(
        '"deno.enablePaths"',
      );
    });
  });

  it.live("init -i --yes writes VS Code settings even when stdout is piped (Go parity)", () => {
    // Go gates the IDE prompts on `-i` + a TTY stdin only (`cmd/init.go:40`); with
    // YES set no clack UI is rendered, so a piped stdout must not skip the write.
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, { interactive: false, stdinIsTty: true, yes: true });

      yield* legacyInit({ ...BASE_INIT_FLAGS, interactive: true }).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y\n");
      expect(yield* readProjectFile(tempDir, ".vscode", "settings.json")).toContain(
        '"deno.enablePaths"',
      );
    });
  });
});
