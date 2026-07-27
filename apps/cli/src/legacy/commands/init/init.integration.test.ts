import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  LegacyExperimentalFlag,
  LegacyWorkdirFlag,
  LegacyYesFlag,
} from "../../../shared/legacy/global-flags.ts";
import {
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import { legacyInit } from "./init.handler.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-legacy-init-"));
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
  } = {},
) {
  const out = mockOutput({ format: "text", interactive: opts.interactive ?? false });
  return {
    out,
    layer: Layer.mergeAll(
      BunServices.layer,
      out.layer,
      mockRuntimeInfo({ cwd }),
      mockTty({
        stdinIsTty: opts.stdinIsTty ?? false,
        stdoutIsTty: opts.interactive ?? false,
      }),
      mockStdin(opts.stdinIsTty ?? false, opts.stdinInput),
      Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? false),
      Layer.succeed(LegacyWorkdirFlag, opts.workdir ?? Option.none()),
      Layer.succeed(LegacyYesFlag, opts.yes ?? false),
      Layer.succeed(CliArgs, { args: [] }),
    ),
  };
}

function expectFailureTag(exit: Exit.Exit<unknown, unknown>, tag: string) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    return;
  }

  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isSome(failure)) {
    expect((failure.value as { _tag: string })._tag).toBe(tag);
  }
}

describe("legacy init", () => {
  it.live("creates config.toml natively without the Go proxy", () => {
    const tempDir = makeTempDir();

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

      const content = yield* Effect.tryPromise(() =>
        readFile(join(tempDir, "supabase", "config.toml"), "utf8"),
      );
      expect(content).toContain("major_version = 17");
      expect(out.stdoutText).toBe("Finished supabase init.\n");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("requires --experimental when --use-orioledb is set", () => {
    const tempDir = makeTempDir();

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

      expectFailureTag(exit, "InitExperimentalRequiredError");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("supports the hidden IDE flags natively", () => {
    const tempDir = makeTempDir();

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

      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, ".vscode", "extensions.json"), "utf8"),
        ),
      ).toContain('"recommendations"');
      expect(
        yield* Effect.tryPromise(() => readFile(join(tempDir, ".vscode", "settings.json"), "utf8")),
      ).toContain('"deno.enablePaths"');
      expect(
        yield* Effect.tryPromise(() => readFile(join(tempDir, ".idea", "deno.xml"), "utf8")),
      ).toContain('<component name="DenoSettings">');
      expect(out.stdoutText).toContain("Generated VS Code settings in .vscode/settings.json.");
      expect(out.stdoutText).toContain("Generated IntelliJ settings in .idea/deno.xml.");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("respects the legacy --workdir global flag", () => {
    const tempDir = makeTempDir();
    const workdir = join(tempDir, "nested");

    return Effect.gen(function* () {
      const { layer } = setup(tempDir, { workdir: Option.some("nested") });

      yield* legacyInit({
        interactive: false,
        useOrioledb: false,
        force: false,
        withVscodeWorkspace: false,
        withVscodeSettings: false,
        withIntellijSettings: false,
      }).pipe(Effect.provide(layer));

      const content = yield* Effect.tryPromise(() =>
        readFile(join(workdir, "supabase", "config.toml"), "utf8"),
      );
      expect(content).toContain("major_version = 17");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  // ---------------------------------------------------------------------------
  // `-i` + `--yes`/`SUPABASE_YES` — Go's `PromptForIDESettings` goes through
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
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, { interactive: true, stdinIsTty: true, yes: true });

      yield* legacyInit({ ...BASE_INIT_FLAGS, interactive: true }).pipe(Effect.provide(layer));

      // No clack prompt fired; the auto-accepted question was echoed to stderr.
      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y\n");
      // Go returns after writing VS Code settings — IntelliJ is never asked.
      expect(out.stderrText).not.toContain("IntelliJ");
      expect(
        yield* Effect.tryPromise(() => readFile(join(tempDir, ".vscode", "settings.json"), "utf8")),
      ).toContain('"deno.enablePaths"');
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("init -i with SUPABASE_YES=1 auto-accepts the VS Code prompt like --yes", () => {
    const tempDir = makeTempDir();
    const prev = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "1";

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, { interactive: true, stdinIsTty: true });

      yield* legacyInit({ ...BASE_INIT_FLAGS, interactive: true }).pipe(Effect.provide(layer));

      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y\n");
      expect(
        yield* Effect.tryPromise(() => readFile(join(tempDir, ".vscode", "settings.json"), "utf8")),
      ).toContain('"deno.enablePaths"');
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = prev;
        }),
      ),
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("init -i --yes writes VS Code settings even when stdout is piped (Go parity)", () => {
    // Go gates the IDE prompts on `-i` + a TTY stdin only (`cmd/init.go:40`); with
    // YES set no clack UI is rendered, so a piped stdout must not skip the write.
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const { layer, out } = setup(tempDir, { interactive: false, stdinIsTty: true, yes: true });

      yield* legacyInit({ ...BASE_INIT_FLAGS, interactive: true }).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain("Generate VS Code settings for Deno? [Y/n] y\n");
      expect(
        yield* Effect.tryPromise(() => readFile(join(tempDir, ".vscode", "settings.json"), "utf8")),
      ).toContain('"deno.enablePaths"');
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
