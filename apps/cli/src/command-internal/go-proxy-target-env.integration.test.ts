import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { isolatedHomeLayer } from "../../tests/helpers/command-mocks.ts";
import {
  mockAnalytics,
  mockOutput,
  mockTelemetryRuntime,
  mockTty,
} from "../../tests/helpers/mocks.ts";
import { provideEnv } from "../../tests/helpers/permission-real-layers.ts";
import { dbRemoteChanges } from "../commands/db/remote/changes/changes.handler.ts";
import { genKeys } from "../commands/gen/keys/keys.handler.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
} from "./global-flags.ts";
import { GoProxy } from "./go-proxy.service.ts";
import { projectStateModeLayer, type ProjectStateMode } from "./project-state-mode.ts";

const LINKED_REF = "abcdefghijklmnopqrst";

interface GoCall {
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string> | undefined;
}

const setup = (workdir: string, mode: ProjectStateMode, profile = "supabase") => {
  const calls: Array<GoCall> = [];
  const layer = Layer.mergeAll(
    BunServices.layer,
    isolatedHomeLayer(workdir),
    projectStateModeLayer(mode),
    mockTty(),
    mockOutput().layer,
    mockAnalytics().layer,
    mockTelemetryRuntime(),
    Layer.succeed(CliArgs, { args: [] }),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(ProfileFlag, profile),
    Layer.succeed(WorkdirFlag, Option.some(workdir)),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(GoProxy, {
      exec: (args, opts) =>
        Effect.sync(() => {
          calls.push({ args, env: opts?.env });
        }),
      execCapture: () => Effect.die("the delegated commands do not capture output"),
    }),
  );
  return { calls, layer };
};

const writeStackLink = Effect.fnUntraced(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
  yield* fs.writeFileString(
    path.join(workdir, "supabase", ".link.json"),
    JSON.stringify({
      project: { ref: LINKED_REF },
      active_branch: { ref: LINKED_REF },
      fetchedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
});

const changesFlags = (overrides: { dbUrl?: Option.Option<string> } = {}) => ({
  schema: [],
  dbUrl: overrides.dbUrl ?? Option.none(),
  linked: false,
  password: Option.none<string>(),
});

describe("Go-delegated linked target", () => {
  const tmp = useTempWorkdir("supabase-go-target-env-");
  const env = { SUPABASE_NO_KEYRING: "1", SUPABASE_HOME: undefined };

  it.effect(
    "hands the linked ref to `db remote changes` in stack mode when no flag is given",
    () => {
      const { calls, layer } = setup(tmp.current, "stack");
      return Effect.gen(function* () {
        yield* writeStackLink(tmp.current);
        yield* dbRemoteChanges(changesFlags());
        expect(calls).toEqual([
          { args: ["db", "remote", "changes"], env: { SUPABASE_PROJECT_ID: LINKED_REF } },
        ]);
      }).pipe(Effect.provide(layer), provideEnv(env));
    },
  );

  it.effect("leaves the env alone when `db remote changes` has its own --db-url", () => {
    const { calls, layer } = setup(tmp.current, "stack");
    return Effect.gen(function* () {
      yield* writeStackLink(tmp.current);
      yield* dbRemoteChanges(changesFlags({ dbUrl: Option.some("postgres://x@localhost/db") }));
      expect(calls).toEqual([
        { args: ["db", "remote", "changes", "--db-url", "postgres://x@localhost/db"], env: {} },
      ]);
    }).pipe(Effect.provide(layer), provideEnv(env));
  });

  it.effect("sets no env and builds no target runtime in legacy mode", () => {
    // An unknown profile fails the settings layer, so a legacy run that succeeds never built it.
    const { calls, layer } = setup(tmp.current, "legacy", "no-such-profile");
    return Effect.gen(function* () {
      yield* dbRemoteChanges(changesFlags());
      yield* genKeys({ projectRef: Option.none(), overrideName: [] });
      expect(calls).toEqual([
        { args: ["db", "remote", "changes"], env: {} },
        { args: ["gen", "keys"], env: undefined },
      ]);
    }).pipe(Effect.provide(layer), provideEnv(env));
  });

  it.effect("passes the linked ref to `gen keys` as --project-ref in stack mode", () => {
    const { calls, layer } = setup(tmp.current, "stack");
    return Effect.gen(function* () {
      yield* writeStackLink(tmp.current);
      yield* genKeys({ projectRef: Option.none(), overrideName: [] });
      expect(calls).toEqual([
        { args: ["gen", "keys", "--project-ref", LINKED_REF], env: undefined },
      ]);
    }).pipe(Effect.provide(layer), provideEnv(env));
  });

  it.effect("passes an explicit --project-ref to `gen keys` in stack mode", () => {
    const { calls, layer } = setup(tmp.current, "stack");
    const explicitRef = "zyxwvutsrqponmlkjihg";
    return Effect.gen(function* () {
      yield* writeStackLink(tmp.current);
      yield* genKeys({ projectRef: Option.some(explicitRef), overrideName: [] });
      expect(calls).toEqual([
        { args: ["gen", "keys", "--project-ref", explicitRef], env: undefined },
      ]);
    }).pipe(Effect.provide(layer), provideEnv(env));
  });
});
