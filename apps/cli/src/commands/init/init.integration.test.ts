import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Stdio } from "effect";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { ExperimentalFlag, WorkdirFlag, YesFlag } from "../../command-internal/global-flags.ts";
import { normalizeCause } from "../../shared/output/normalize-error.ts";
import { textOutputLayer } from "../../shared/output/output.layer.ts";
import { Output } from "../../shared/output/output.service.ts";
import { stripAnsi } from "../../../tests/helpers/ansi.ts";
import { mockOutput, mockRuntimeInfo, mockStdin, mockTty } from "../../../tests/helpers/mocks.ts";
import { useTempWorkdir, withEnvVar } from "../../../tests/helpers/command-mocks.ts";
import { init } from "./init.handler.ts";

const tempRoot = useTempWorkdir("supabase-init-");

const readTextFile = (...segments: Array<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(...segments));
  }).pipe(Effect.provide(BunServices.layer));

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
    platform?: NodeJS.Platform;
  } = {},
) {
  const out = mockOutput({ format: "text", interactive: opts.interactive ?? false });
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
      Layer.succeed(ExperimentalFlag, opts.experimental ?? false),
      Layer.succeed(WorkdirFlag, opts.workdir ?? Option.none()),
      Layer.succeed(YesFlag, opts.yes ?? false),
      Layer.succeed(CliArgs, { args: [] }),
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
 * Renders a handler failure exactly like the real CLI does and returns the captured stderr
 * writes (ANSI-stripped). Locks the composed stderr contract from SIDE_EFFECTS.md, not just
 * the error fields.
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

describe("init", () => {
  it.live("creates config.toml natively without the Go proxy", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir);

      yield* init({
        interactive: false,
        useOrioledb: false,
        force: false,
        withVscodeWorkspace: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      }).pipe(Effect.provide(layer));

      const content = yield* readTextFile(tempDir, "supabase", "config.toml");
      expect(content).toContain("major_version = 17");
      expect(out.stdoutText).toBe("Finished supabase init.\n");
    });
  });

  it.live("requires --experimental when --use-orioledb is set, with cobra's exact wording", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer } = setup(tempDir, { experimental: false });

      const exit = yield* init({
        interactive: false,
        useOrioledb: true,
        force: false,
        withVscodeWorkspace: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      }).pipe(Effect.provide(layer), Effect.exit);

      const error = findFailure(exit);
      expect(error["_tag"]).toBe("InitExperimentalRequiredError");
      expect(error["message"]).toBe(`required flag(s) "experimental" not set`);
      expect(error["suggestion"]).toBeUndefined();

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

      yield* init(initFlags).pipe(Effect.provide(layer));
      const exit = yield* init(initFlags).pipe(Effect.provide(layer), Effect.exit);

      const error = findFailure(exit);
      expect(error["_tag"]).toBe("InitConfigExistsError");
      expect(error["message"]).toBe(
        "failed to create config file: open supabase/config.toml: file exists",
      );
      expect(error["suggestion"]).toBe(
        "Run supabase init --force to overwrite existing config file.",
      );

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

      yield* init(initFlags).pipe(Effect.provide(layer));
      const exit = yield* init(initFlags).pipe(Effect.provide(layer), Effect.exit);

      const error = findFailure(exit);
      expect(error["_tag"]).toBe("InitConfigExistsError");
      expect(error["message"]).toBe(
        "failed to create config file: open supabase\\config.toml: The file exists.",
      );
      expect(error["suggestion"]).toBe(
        "Run supabase init --force to overwrite existing config file.",
      );

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

      yield* init({
        interactive: false,
        useOrioledb: false,
        force: false,
        withVscodeWorkspace: true,
        withVscodeSettings: false,
        withIntellijSettings: true,
      }).pipe(Effect.provide(layer));

      expect(yield* readTextFile(tempDir, ".vscode", "extensions.json")).toContain(
        '"recommendations"',
      );
      expect(yield* readTextFile(tempDir, ".vscode", "settings.json")).toContain(
        '"deno.enablePaths"',
      );
      expect(yield* readTextFile(tempDir, ".idea", "deno.xml")).toContain(
        '<component name="DenoSettings">',
      );
      expect(out.stdoutText).toContain("Generated VS Code settings in .vscode/settings.json.");
      expect(out.stdoutText).toContain("Generated IntelliJ settings in .idea/deno.xml.");
    });
  });

  it.live("respects the legacy --workdir global flag", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer } = setup(tempDir, { workdir: Option.some("nested") });

      yield* init({
        interactive: false,
        useOrioledb: false,
        force: false,
        withVscodeWorkspace: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      }).pipe(Effect.provide(layer));

      const content = yield* readTextFile(tempDir, "nested", "supabase", "config.toml");
      expect(content).toContain("major_version = 17");
    });
  });

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

      yield* init({ ...BASE_INIT_FLAGS, interactive: true }).pipe(Effect.provide(layer));

      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y\n");
      expect(out.stderrText).not.toContain("IntelliJ");
      expect(yield* readTextFile(tempDir, ".vscode", "settings.json")).toContain(
        '"deno.enablePaths"',
      );
    });
  });

  it.live("init -i with SUPABASE_YES=1 auto-accepts the VS Code prompt like --yes", () => {
    const tempDir = tempRoot.current;

    return withEnvVar(
      "SUPABASE_YES",
      "1",
      Effect.gen(function* () {
        const { layer, out } = setup(tempDir, { interactive: true, stdinIsTty: true });

        yield* init({ ...BASE_INIT_FLAGS, interactive: true }).pipe(Effect.provide(layer));

        expect(out.promptConfirmCalls).toHaveLength(0);
        expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y\n");
        expect(yield* readTextFile(tempDir, ".vscode", "settings.json")).toContain(
          '"deno.enablePaths"',
        );
      }),
    );
  });

  it.live("init -i --yes writes VS Code settings even when stdout is piped (Go parity)", () => {
    const tempDir = tempRoot.current;

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, { interactive: false, stdinIsTty: true, yes: true });

      yield* init({ ...BASE_INIT_FLAGS, interactive: true }).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y\n");
      expect(yield* readTextFile(tempDir, ".vscode", "settings.json")).toContain(
        '"deno.enablePaths"',
      );
    });
  });
});
