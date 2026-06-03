import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { LegacyExperimentalFlag, LegacyWorkdirFlag } from "../../../shared/legacy/global-flags.ts";
import { mockOutput, mockRuntimeInfo, mockTty } from "../../../../tests/helpers/mocks.ts";
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
      Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? false),
      Layer.succeed(LegacyWorkdirFlag, opts.workdir ?? Option.none()),
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
});
