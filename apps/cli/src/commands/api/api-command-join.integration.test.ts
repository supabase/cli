import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { openApiOperationIdMap } from "@supabase/api/effect";
import openApiSpec from "@supabase/api/openapi.json";
import { Console, Effect, Layer, Predicate, Schema, Stdio } from "effect";
import { CliOutput, Command } from "effect/cli";

import { deriveApiCommands } from "../../../scripts/api-command-derive.ts";
import { ExperimentalFlag, GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
  withConfigEnv,
} from "../../../tests/helpers/command-mocks.ts";
import {
  fakeConsole,
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTelemetryRuntime,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import type { ApiNoun } from "./api-command-policy.ts";
import { withApiCommands } from "./runtime.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Predicate.isObject(value) && !Array.isArray(value);

const OPERATIONS = {
  "v1-list-migration-history": { group: "fixture", method: "list" },
  "v1-get-a-migration": { group: "fixture.inner", method: "get" },
  "v1-apply-a-migration": { group: "fixture.fresh", method: "create" },
};

const fixtureSpec = () => {
  const spec: Record<string, unknown> = structuredClone(openApiSpec);
  for (const item of Object.values(isRecord(spec["paths"]) ? spec["paths"] : {})) {
    for (const operation of Object.values(isRecord(item) ? item : {})) {
      if (!isRecord(operation)) continue;
      const operationId = String(operation["operationId"]);
      if (!Object.hasOwn(OPERATIONS, operationId)) continue;
      operation["x-operation"] = Reflect.get(OPERATIONS, operationId);
      operation["x-scalar-stability"] = "experimental";
    }
  }
  return spec;
};

/** `fixture` and `fixture inner` are hand-written; only `fixture fresh` needs a description. */
const fixtureNoun: ApiNoun = {
  feature: "warehouse",
  groups: { fresh: "Fresh fixtures" },
};

const derived = deriveApiCommands({
  spec: fixtureSpec(),
  generated: Object.keys(OPERATIONS),
  nouns: { fixture: fixtureNoun },
  operationIdMap: openApiOperationIdMap,
  handWritten: {
    groups: new Set(["fixture", "fixture inner"]),
    leaves: new Set(["fixture ping", "fixture inner pong"]),
    sealed: new Set(),
  },
});

const pong = Command.make("pong", {}, () => Console.log("handwritten pong")).pipe(
  Command.withDescription("Answer from the inner group"),
);
const inner = Command.make("inner").pipe(
  Command.withDescription("Hand-written inner group"),
  Command.withSubcommands([pong]),
);
const ping = Command.make("ping", {}, () => Console.log("handwritten ping")).pipe(
  Command.withDescription("Answer from the group"),
);
const fixtureGroup = Command.make("fixture").pipe(
  Command.withDescription("Hand-written fixture group"),
  Command.withSubcommands([ping, { group: "Nested", commands: [inner] }]),
);

const MIGRATION_VERSION = "20250312000000";
const MIGRATIONS_PATH = `/v1/projects/${VALID_REF}/database/migrations`;
const tempRoot = useTempWorkdir("supabase-api-join-int-");

const run = (
  args: ReadonlyArray<string>,
  enabledFeatures: ReadonlyArray<string> = ["warehouse"],
) => {
  const root = Command.make("supabase").pipe(
    Command.withSubcommands(
      withApiCommands([fixtureGroup], enabledFeatures, {
        nouns: { fixture: fixtureNoun },
        entries: derived.entries,
      }),
    ),
    Command.withGlobalFlags(GLOBAL_FLAGS),
  );
  const out = mockOutput({ format: "text" });
  const { console, calls } = fakeConsole();
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api: mockCommandPlatformApi({ response: { status: 200, body: {} } }),
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      tty: mockTty({ stdinIsTty: false, stdoutIsTty: false }),
      stdin: mockStdin(false),
      cliArgs: args,
    }),
    BunServices.layer,
    CliOutput.layer(textCliOutputFormatter()),
    Layer.succeed(ExperimentalFlag, false),
    mockTelemetryRuntime({ configDir: tempRoot.current }),
    mockRuntimeInfo({ cwd: tempRoot.current, homeDir: tempRoot.current }),
    Stdio.layerTest({ args: Effect.succeed(args) }),
  );
  const effect = withConfigEnv(
    { SUPABASE_ACCESS_TOKEN: VALID_TOKEN, SUPABASE_NO_KEYRING: "1" },
    Command.runWith(root, { version: "0.0.0-test" })(args),
  ).pipe(Effect.provideService(Console.Console, console), Effect.provide(layer));
  return { out, output: () => calls.join("\n"), effect };
};

describe("generated commands joining hand-written groups", () => {
  it("derives the fixture commands without problems", () => {
    expect(derived.problems).toEqual([]);
    expect(derived.entries.map((entry) => entry.command.join(" "))).toEqual([
      "fixture fresh create",
      "fixture inner get",
      "fixture list",
    ]);
  });

  it.effect.each([
    { argv: ["fixture", "ping"], expected: "handwritten ping" },
    { argv: ["fixture", "inner", "pong"], expected: "handwritten pong" },
  ])("still runs the hand-written command $argv", ({ argv, expected }) => {
    const { output, effect } = run(argv);
    return Effect.gen(function* () {
      yield* effect;
      expect(output()).toContain(expected);
    });
  });

  it.effect.each([
    { argv: ["fixture", "list"], method: "GET", path: MIGRATIONS_PATH },
    {
      argv: ["fixture", "inner", "get", MIGRATION_VERSION],
      method: "GET",
      path: `${MIGRATIONS_PATH}/${MIGRATION_VERSION}`,
    },
    {
      argv: ["fixture", "fresh", "create", "--query", "select 1"],
      method: "POST",
      path: MIGRATIONS_PATH,
    },
  ])("runs the generated command $argv beside the hand-written ones", ({ argv, method, path }) => {
    const { out, effect } = run([...argv, `--remote=${VALID_REF}`, "--yes", "--dry-run"]);
    return Effect.gen(function* () {
      yield* effect;
      expect(decodeJson(out.stdoutText)).toMatchObject({ method, path });
    });
  });

  it.effect("lists generated and hand-written commands together in the group help", () => {
    const { output, effect } = run(["fixture", "--help"]);
    return Effect.gen(function* () {
      yield* effect;
      const help = output();
      expect(help).toContain("Hand-written fixture group");
      expect(help).toContain("ping");
      expect(help).toContain("list");
      expect(help).toContain("fresh");
      expect(help).toContain("Nested");
      expect(help).toContain("inner");
    });
  });

  it.effect("lists generated and hand-written commands together in the nested group help", () => {
    const { output, effect } = run(["fixture", "inner", "--help"]);
    return Effect.gen(function* () {
      yield* effect;
      const help = output();
      expect(help).toContain("Hand-written inner group");
      expect(help).toContain("pong");
      expect(help).toContain("get");
    });
  });

  it.effect("leaves the hand-written group alone while the feature is off", () => {
    const { output, effect } = run(["fixture", "--help"], []);
    return Effect.gen(function* () {
      yield* effect;
      const help = output();
      expect(help).toContain("ping");
      expect(help).not.toContain("list");
      expect(help).not.toContain("fresh");
    });
  });
});
