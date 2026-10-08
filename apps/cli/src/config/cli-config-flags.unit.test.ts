import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Option } from "effect";
import { CliOutput, Command, Flag } from "effect/unstable/cli";

import { unwrapParam } from "../command-internal/param-introspection.ts";
import { textCliOutputFormatter } from "../shared/output/text-formatter.ts";
import {
  CliConfigFlagBindings,
  CliConfigFlagInputs,
  cliConfigFlagBinding,
  withCliConfigFlags,
} from "./cli-config-flags.ts";
import { portCodec, requiredCliConfigKey } from "./cli-config-key.ts";
import { CliConfigKeys } from "./cli-config-keys.ts";

const config = {
  noSeed: CliConfigKeys.db.seed.enabled.flag({
    name: "no-seed",
    description: "Skip seeding.",
    map: (skip) => (skip ? false : undefined),
  }),
  includeSeed: CliConfigKeys.db.seed.enabled.flag({
    name: "include-seed",
    description: "Seed.",
  }),
  proxyPort: requiredCliConfigKey({
    path: "probe.port",
    codec: portCodec,
    default: 1,
    flags: { names: ["proxy-port"] },
  }).flag({ name: "proxy-port", description: "Port." }),
  sqlPaths: CliConfigKeys.db.seed.sqlPaths.flag({
    name: "sql-paths",
    description: "Seed files.",
    also: [[CliConfigKeys.db.seed.enabled, true]],
  }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description: "Database password.",
  }),
  usePgDelta: CliConfigKeys.experimental.pgdelta.enabled.flag({
    name: "use-pg-delta",
    description: "Use pg-delta.",
  }),
  unrelated: Flag.string("unrelated").pipe(Flag.optional),
} as const;

const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const seen: Array<ReadonlyMap<string, { readonly flag: string; readonly value: unknown }>> = [];
    const command = Command.make("probe", config).pipe(
      Command.withHandler(() =>
        Effect.gen(function* () {
          seen.push(yield* CliConfigFlagInputs);
        }),
      ),
      withCliConfigFlags(config),
    );
    yield* Command.runWith(command, { version: "0.0.0-test" })(args).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
    const inputs = seen[0];
    if (inputs === undefined) throw new Error("handler did not run");
    return Object.fromEntries([...inputs].map(([path, assignment]) => [path, assignment.value]));
  }).pipe(Effect.scoped);

describe("key.flag", () => {
  it.effect("reports nothing when no bound flag is passed", () =>
    Effect.gen(function* () {
      expect(yield* run([])).toEqual({});
    }),
  );

  it.effect("maps an inverted flag to the key's value", () =>
    Effect.gen(function* () {
      expect(yield* run(["--no-seed"])).toEqual({ "db.seed.enabled": false });
    }),
  );

  it.effect("treats a negatable flag at its negative default as no assignment", () =>
    Effect.gen(function* () {
      expect(yield* run(["--no-seed=false"])).toEqual({});
    }),
  );

  it.effect("passes a positive flag value through unchanged", () =>
    Effect.gen(function* () {
      expect(yield* run(["--include-seed"])).toEqual({ "db.seed.enabled": true });
    }),
  );

  it.effect("rejects two flags that assign the same key, naming both", () =>
    Effect.gen(function* () {
      const error = yield* run(["--sql-paths", "a.sql", "--no-seed"]).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "CliConfigValueError", path: "db.seed.enabled" });
      expect(error instanceof Error && error.message).toBe(
        "--no-seed and --sql-paths both set db.seed.enabled; pass only one",
      );
    }),
  );

  it.effect("rejects an out-of-range port as a parse error instead of dropping it", () =>
    Effect.gen(function* () {
      expect(yield* run(["--proxy-port", "8080"])).toEqual({ "probe.port": 8080 });
      const error = yield* run(["--proxy-port", "70000"]).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "ShowHelp", errors: [{ _tag: "InvalidValue" }] });
      expect(JSON.stringify(error)).toContain("70000");
    }),
  );

  it.effect("assigns the paired keys of a multi-assign flag", () =>
    Effect.gen(function* () {
      expect(yield* run(["--sql-paths", "a.sql", "--sql-paths", "b/*.sql"])).toEqual({
        "db.seed.sql_paths": ["a.sql", "b/*.sql"],
        "db.seed.enabled": true,
      });
    }),
  );

  it.effect("binds a flag through its alias to a key without a document path", () =>
    Effect.gen(function* () {
      expect(yield* run(["-p", "s3cret"])).toEqual({ "linkedDb.password": "s3cret" });
    }),
  );

  it.effect("distinguishes an explicit false from an absent boolean flag", () =>
    Effect.gen(function* () {
      expect(yield* run(["--use-pg-delta=false"])).toEqual({
        "experimental.pgdelta.enabled": false,
      });
      expect(yield* run([])).toEqual({});
    }),
  );

  it.effect("ignores flags that are not bound to a key", () =>
    Effect.gen(function* () {
      expect(yield* run(["--unrelated", "x"])).toEqual({});
    }),
  );

  it("attaches a binding to each key flag and none to other flags", () => {
    expect(cliConfigFlagBinding(config.noSeed)).toMatchObject({
      flag: "no-seed",
      path: "db.seed.enabled",
    });
    expect(cliConfigFlagBinding(config.unrelated)).toBeUndefined();
  });

  it("stays introspectable for telemetry and completion", () => {
    expect(unwrapParam(config.password)).toMatchObject({
      single: { name: "password", aliases: ["p"] },
      isOptional: true,
    });
    expect(unwrapParam(config.sqlPaths)).toMatchObject({
      single: { name: "sql-paths" },
      isVariadic: true,
    });
    expect(unwrapParam(config.noSeed)?.single.name).toBe("no-seed");
  });

  it("annotates the command with its bound flags", () => {
    const command = Command.make("probe", config).pipe(withCliConfigFlags(config));

    const bindings = Context.getOption(command.annotations, CliConfigFlagBindings);

    expect(
      Option.getOrElse(bindings, () => [])
        .map((binding) => binding.flag)
        .sort(),
    ).toEqual(["include-seed", "no-seed", "password", "proxy-port", "sql-paths", "use-pg-delta"]);
  });
});

describe("flag typing", () => {
  const requiresNothing = <Name extends string, Input, ContextInput, E>(
    command: Command.Command<Name, Input, ContextInput, E, never>,
  ) => command;
  const readInputs = Command.make("probe", config).pipe(
    Command.withHandler(() => CliConfigFlagInputs.use(() => Effect.void)),
  );

  it("accepts only the flag names a key declares", () => {
    CliConfigKeys.db.seed.enabled.flag({
      // @ts-expect-error -- "skip-seed" is not a declared flag for db.seed.enabled
      name: "skip-seed",
      description: "Not declared.",
    });
    // @ts-expect-error -- api.port declares no flags
    CliConfigKeys.api.port.flag({ name: "port", description: "Not declared." });

    expect(cliConfigFlagBinding(config.noSeed)?.flag).toBe("no-seed");
  });

  it("leaves CliConfigFlagInputs required until withCliConfigFlags provides it", () => {
    // @ts-expect-error -- the handler still requires CliConfigFlagInputs
    requiresNothing(readInputs);
    requiresNothing(readInputs.pipe(withCliConfigFlags(config)));

    expect(true).toBe(true);
  });
});
