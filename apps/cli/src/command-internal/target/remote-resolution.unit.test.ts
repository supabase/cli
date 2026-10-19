import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Sink, Stdio, Stream } from "effect";
import { vi } from "vitest";

import { stripAnsi } from "../../../tests/helpers/ansi.ts";
import { mockCommandSettings } from "../../../tests/helpers/command-mocks.ts";
import { mockTty } from "../../../tests/helpers/mocks.ts";
import { rootCommandForFeatures } from "../../cli/root.ts";
import { CliArgs, type CliArgsShape } from "../../shared/cli/cli-args.service.ts";
import { prepareCliArgs } from "../../shared/cli/run.ts";
import {
  jsonOutputLayer,
  streamJsonOutputLayer,
  textOutputLayer,
} from "../../shared/output/output.layer.ts";
import { Output } from "../../shared/output/output.service.ts";
import { CommandRuntime } from "../../shared/runtime/command-runtime.service.ts";
import type { Tty } from "../../shared/runtime/tty.service.ts";
import { warnTargetDeprecations } from "./remote-resolution.ts";
import type { TargetDeprecation } from "./target-selector.ts";

const clack = vi.hoisted(() => ({
  log: { message: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn() },
}));

vi.mock("@clack/prompts", () => ({
  log: clack.log,
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(),
}));

const sink = (chunks: Array<string>) =>
  Sink.forEach((item: string | Uint8Array) =>
    Effect.sync(() => {
      chunks.push(typeof item === "string" ? item : new TextDecoder().decode(item));
    }),
  );

const PAYLOAD = "export type Database = {}\n";
const linkedAlias: TargetDeprecation = {
  kind: "remote-alias",
  flags: ["--linked"],
  remote: { _tag: "Linked" },
};

const runWith = (
  outputLayer: Layer.Layer<Output, never, Stdio.Stdio | Tty>,
  deprecations: ReadonlyArray<TargetDeprecation>,
  command: {
    readonly path: ReadonlyArray<string>;
    readonly cliArgs: CliArgsShape;
  } = {
    path: ["gen", "types"],
    cliArgs: {
      args: ["gen", "types", "--linked"],
      operandPlaceholders: () => ["<NAME=VALUE>..."],
    },
  },
) => {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const stdio = Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.empty,
      stdout: () => sink(stdout),
      stderr: () => sink(stderr),
    }),
  );
  return Effect.gen(function* () {
    yield* warnTargetDeprecations(deprecations);
    const output = yield* Output;
    yield* output.raw(PAYLOAD);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        outputLayer,
        mockCommandSettings({ workdir: "/unused" }),
        Layer.succeed(CliArgs, command.cliArgs),
        Layer.succeed(
          CommandRuntime,
          CommandRuntime.of({ commandPath: command.path, commandRunId: "run" }),
        ),
      ).pipe(Layer.provide(Layer.merge(stdio, mockTty()))),
    ),
    Effect.map(() => ({ stdout: stdout.join(""), stderr: stderr.join("") })),
  );
};

describe("warnTargetDeprecations", () => {
  it.effect.each([
    { format: "text", layer: textOutputLayer },
    { format: "json", layer: jsonOutputLayer },
    { format: "stream-json", layer: streamJsonOutputLayer },
  ])("leaves stdout to the payload in $format mode", ({ layer }) =>
    Effect.gen(function* () {
      const remoteRun = yield* runWith(layer, []);
      const aliasRun = yield* runWith(layer, [linkedAlias]);

      expect(aliasRun.stdout).toBe(PAYLOAD);
      expect(aliasRun.stdout).toBe(remoteRun.stdout);
      expect(remoteRun.stderr).toBe("");
      expect(stripAnsi(aliasRun.stderr)).toBe(
        "Warning: --linked is deprecated and will be removed in v4. Use --remote instead: supabase gen types <NAME=VALUE>... --remote\n",
      );
      expect(clack.log.warn).not.toHaveBeenCalled();
    }),
  );
});

describe("warnTargetDeprecations on the raw command line", () => {
  const root = rootCommandForFeatures();
  const REF = "abcdefghijklmnopqrst";

  const warningFor = (
    argv: ReadonlyArray<string>,
    path: ReadonlyArray<string>,
    deprecation: TargetDeprecation,
  ) =>
    Effect.gen(function* () {
      const run = yield* runWith(textOutputLayer, [deprecation], {
        path,
        cliArgs: prepareCliArgs(root, argv),
      });
      return stripAnsi(run.stderr);
    });

  it.effect("shows an operand placeholder in place of a secret value", () =>
    Effect.gen(function* () {
      const stderr = yield* warningFor(
        ["secrets", "set", "FOO=hunter2", `--project-ref=${REF}`],
        ["secrets", "set"],
        { kind: "remote-alias", flags: ["--project-ref"], remote: { _tag: "Ref", ref: REF } },
      );

      expect(stderr).toBe(
        `Warning: --project-ref is deprecated and will be removed in v4. Use --remote=<ref> instead: supabase secrets set <NAME=VALUE>... --remote=${REF}\n`,
      );
      expect(stderr).not.toContain("hunter2");
    }),
  );

  it.effect("keeps a SQL operand out of the warning", () =>
    Effect.gen(function* () {
      const stderr = yield* warningFor(
        ["db", "query", "select 'hunter2' as pw", "--linked"],
        ["db", "query"],
        { kind: "remote-alias", flags: ["--linked"], remote: { _tag: "Linked" } },
      );

      expect(stderr).toBe(
        "Warning: --linked is deprecated and will be removed in v4. Use --remote instead: supabase db query <sql> --remote\n",
      );
      expect(stderr).not.toContain("hunter2");
    }),
  );

  it.effect("keeps another flag's database URL and password out of the warning", () =>
    Effect.gen(function* () {
      const stderr = yield* warningFor(
        ["db", "diff", "--from=postgresql://u:hunter2@h/db", "--to=local", "--local"],
        ["db", "diff"],
        { kind: "local" },
      );

      expect(stderr).toBe(
        "Warning: --local isn't needed (local is the default) and will be removed in v4: supabase db diff\n",
      );
      expect(stderr).not.toContain("hunter2");
    }),
  );

  it.effect("keeps the -- tail out of the warning", () =>
    Effect.gen(function* () {
      const stderr = yield* warningFor(
        ["functions", "deploy", "--linked", "--", "--token=hunter2"],
        ["functions", "deploy"],
        { kind: "remote-alias", flags: ["--linked"], remote: { _tag: "Linked" } },
      );

      expect(stderr).toBe(
        "Warning: --linked is deprecated and will be removed in v4. Use --remote instead: supabase functions deploy <Function name>... --remote\n",
      );
      expect(stderr).not.toContain("hunter2");
    }),
  );

  it.effect("never echoes a database URL given to --db-url", () =>
    Effect.gen(function* () {
      const url = "postgresql://u:hunter2@h/db";
      const stderr = yield* warningFor(["db", "push", `--db-url=${url}`], ["db", "push"], {
        kind: "remote-alias",
        flags: ["--db-url"],
        remote: { _tag: "DbUrl", url },
      });

      expect(stderr).toContain("supabase db push --remote=<db-url>");
      expect(stderr).not.toContain("hunter2");
    }),
  );
});
