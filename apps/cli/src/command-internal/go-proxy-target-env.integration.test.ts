import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { useTempWorkdir, VALID_TOKEN } from "../../tests/helpers/command-mocks.ts";
import { isolatedHomeLayer } from "../../tests/helpers/command-mocks.ts";
import {
  mockAnalytics,
  mockOutput,
  mockTelemetryRuntime,
  mockTty,
} from "../../tests/helpers/mocks.ts";
import {
  projectResponse,
  provideEnv,
  stubManagementApi,
} from "../../tests/helpers/permission-real-layers.ts";
import { dbRemoteChanges } from "../commands/db/remote/changes/changes.handler.ts";
import { genKeys } from "../commands/gen/keys/keys.handler.ts";
import { PROJECT_NOT_LINKED_MESSAGE } from "../config/remote-target.service.ts";
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

const setup = (
  workdir: string,
  mode: ProjectStateMode,
  profile = "supabase",
  interactive?: { readonly chosenRef: string },
) => {
  const calls: Array<{ readonly args: ReadonlyArray<string> }> = [];
  const poolerUrls: Array<string | undefined> = [];
  const layer = Layer.mergeAll(
    NodeServices.layer,
    isolatedHomeLayer(workdir, {
      SUPABASE_NO_KEYRING: "1",
      ...(interactive === undefined ? {} : { SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    }),
    projectStateModeLayer(mode),
    mockTty({ stdinIsTty: interactive !== undefined }),
    mockOutput({
      promptSelectResponses: interactive === undefined ? [] : [interactive.chosenRef],
    }).layer,
    mockAnalytics().layer,
    mockTelemetryRuntime(),
    Layer.succeed(CliArgs, { args: [] }),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(ProfileFlag, profile),
    Layer.succeed(WorkdirFlag, Option.some(workdir)),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(GoProxy, {
      exec: (args, execOpts) =>
        Effect.sync(() => {
          calls.push({ args });
          poolerUrls.push(execOpts?.env?.SUPABASE_INTERNAL_POOLER_URL);
        }),
      execCapture: () => Effect.die("the delegated commands do not capture output"),
    }),
  );
  return { calls, poolerUrls, layer };
};

const POOLER_URL =
  "postgresql://postgres.abcdefghijklmnopqrst:[YOUR-PASSWORD]@pooler.example.com:6543/postgres";

const writeStackLink = Effect.fnUntraced(function* (workdir: string, poolerUrl?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
  yield* fs.writeFileString(
    path.join(workdir, "supabase", ".link.json"),
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      project: { ref: LINKED_REF },
      active_branch: {
        ref: LINKED_REF,
        ...(poolerUrl === undefined ? {} : { pooler_url: poolerUrl }),
      },
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

  it.effect("passes the linked ref to `db remote changes` as --project-ref in stack mode", () => {
    const { calls, layer } = setup(tmp.current, "stack");
    return Effect.gen(function* () {
      yield* writeStackLink(tmp.current);
      yield* dbRemoteChanges(changesFlags());
      expect(calls).toEqual([{ args: ["db", "remote", "changes", "--project-ref", LINKED_REF] }]);
    }).pipe(Effect.provide(layer), provideEnv(env));
  });

  it.effect("passes no ref when `db remote changes` has its own --db-url", () => {
    const { calls, layer } = setup(tmp.current, "stack");
    return Effect.gen(function* () {
      yield* writeStackLink(tmp.current);
      yield* dbRemoteChanges(changesFlags({ dbUrl: Option.some("postgres://x@localhost/db") }));
      expect(calls).toEqual([
        {
          args: ["db", "remote", "changes", "--db-url", "postgres://x@localhost/db"],
        },
      ]);
    }).pipe(Effect.provide(layer), provideEnv(env));
  });

  it.effect("adds no ref and builds no target runtime in legacy mode", () => {
    // An unknown profile fails the settings layer, so a legacy run that succeeds never built it.
    const { calls, layer } = setup(tmp.current, "legacy", "no-such-profile");
    return Effect.gen(function* () {
      yield* dbRemoteChanges(changesFlags());
      yield* genKeys({ projectRef: Option.none(), overrideName: [] });
      expect(calls).toEqual([{ args: ["db", "remote", "changes"] }, { args: ["gen", "keys"] }]);
    }).pipe(Effect.provide(layer), provideEnv(env));
  });

  it.effect("passes the linked ref to `gen keys` as --project-ref in stack mode", () => {
    const { calls, layer } = setup(tmp.current, "stack");
    return Effect.gen(function* () {
      yield* writeStackLink(tmp.current);
      yield* genKeys({ projectRef: Option.none(), overrideName: [] });
      expect(calls).toEqual([{ args: ["gen", "keys", "--project-ref", LINKED_REF] }]);
    }).pipe(Effect.provide(layer), provideEnv(env));
  });

  it.effect("prompts for a project in `gen keys` when stack mode has nothing linked", () => {
    const { calls, layer } = setup(tmp.current, "stack", "supabase", { chosenRef: LINKED_REF });
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, (method, path) =>
        method === "GET" && path === "/v1/projects"
          ? Response.json([projectResponse(LINKED_REF)])
          : undefined,
      );
      yield* genKeys({ projectRef: Option.none(), overrideName: [] });
      expect(requests).toEqual([{ method: "GET", path: "/v1/projects" }]);
      expect(calls).toEqual([{ args: ["gen", "keys", "--project-ref", LINKED_REF] }]);
    }).pipe(Effect.scoped, Effect.provide(layer), provideEnv(env));
  });

  it.effect("keeps the link ahead of the picker in `gen keys`", () => {
    const { calls, layer } = setup(tmp.current, "stack", "supabase", {
      chosenRef: "zyxwvutsrqponmlkjihg",
    });
    return Effect.gen(function* () {
      yield* writeStackLink(tmp.current);
      yield* genKeys({ projectRef: Option.none(), overrideName: [] });
      expect(calls).toEqual([{ args: ["gen", "keys", "--project-ref", LINKED_REF] }]);
    }).pipe(Effect.provide(layer), provideEnv(env));
  });

  it.effect(
    "fails `db remote changes` without prompting when stack mode has nothing linked",
    () => {
      const { calls, layer } = setup(tmp.current, "stack", "supabase", { chosenRef: LINKED_REF });
      const requests: Array<{ readonly method: string; readonly path: string }> = [];
      return Effect.gen(function* () {
        yield* stubManagementApi(requests, () => undefined);
        const error = yield* dbRemoteChanges(changesFlags()).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProjectRefNotLinkedError",
          message: PROJECT_NOT_LINKED_MESSAGE,
        });
        expect(requests).toEqual([]);
        expect(calls).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer), provideEnv(env));
    },
  );

  it.effect("passes an explicit --project-ref to `gen keys` in stack mode", () => {
    const { calls, layer } = setup(tmp.current, "stack");
    const explicitRef = "zyxwvutsrqponmlkjihg";
    return Effect.gen(function* () {
      yield* writeStackLink(tmp.current);
      yield* genKeys({ projectRef: Option.some(explicitRef), overrideName: [] });
      expect(calls).toEqual([{ args: ["gen", "keys", "--project-ref", explicitRef] }]);
    }).pipe(Effect.provide(layer), provideEnv(env));
  });

  it.effect("forwards the linked pooler URL with the linked ref", () => {
    const { calls, poolerUrls, layer } = setup(tmp.current, "stack");
    return Effect.gen(function* () {
      yield* writeStackLink(tmp.current, POOLER_URL);
      yield* dbRemoteChanges(changesFlags());
      yield* genKeys({ projectRef: Option.some(LINKED_REF), overrideName: [] });
      expect(calls.map((call) => call.args.slice(-2))).toEqual([
        ["--project-ref", LINKED_REF],
        ["--project-ref", LINKED_REF],
      ]);
      expect(poolerUrls).toEqual([POOLER_URL, POOLER_URL]);
    }).pipe(Effect.provide(layer), provideEnv(env));
  });

  it.effect("forwards no pooler URL when an explicit --project-ref is not the linked ref", () => {
    const { calls, poolerUrls, layer } = setup(tmp.current, "stack");
    const explicitRef = "zyxwvutsrqponmlkjihg";
    return Effect.gen(function* () {
      yield* writeStackLink(tmp.current, POOLER_URL);
      yield* genKeys({ projectRef: Option.some(explicitRef), overrideName: [] });
      expect(calls).toEqual([{ args: ["gen", "keys", "--project-ref", explicitRef] }]);
      expect(poolerUrls).toEqual([undefined]);
    }).pipe(Effect.provide(layer), provideEnv(env));
  });
});
