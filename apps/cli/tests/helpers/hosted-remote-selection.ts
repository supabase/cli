import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Stdio } from "effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { YesFlag } from "../../src/command-internal/global-flags.ts";
import type { RemoteValue } from "../../src/command-internal/target/remote-value.ts";
import { TargetPolicy } from "../../src/command-internal/target/target-policy.ts";
import { commandRuntimeLayer } from "../../src/shared/runtime/command-runtime.layer.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
} from "./command-mocks.ts";
import { mockOutput } from "./mocks.ts";
import { assertPermissionDrift } from "./permission-drift.ts";
import type { ActiveFlags } from "./permission-registry.ts";

const OTHER_REF = "qrstuvwxyzabcdefghij";
const BRANCH_REF = "branchprojectrefabcd";
const DB_URL = "postgresql://postgres:pw@db.example.com:5432/postgres";

const branchRow = (name: string) => ({
  id: "11111111-2222-4333-8444-555555555555",
  name,
  project_ref: BRANCH_REF,
  parent_project_ref: VALID_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: true,
});

const hostedSelectionLayer = (options: {
  readonly command: ReadonlyArray<string>;
  readonly argv: ReadonlyArray<string>;
  readonly workdir: string;
  readonly respond: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientResponse.HttpClientResponse;
}) => {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({
    handler: (request) =>
      Effect.succeed(
        request.url.endsWith("/branches")
          ? jsonResponse(request, 200, [branchRow("feature-x")])
          : options.respond(request),
      ),
  });
  const cache = mockLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: options.workdir, projectId: Option.none() }),
      cliArgs: options.argv,
      linkedProjectCache: cache.layer,
    }),
    commandRuntimeLayer(options.command).pipe(Layer.provide(BunServices.layer)),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
    Stdio.layerTest({ args: Effect.succeed(options.argv) }),
  );
  return { layer, out, api, cache };
};

type HostedSelectionLayer = ReturnType<typeof hostedSelectionLayer>["layer"];

interface HostedSelector {
  readonly remote: Option.Option<RemoteValue>;
  readonly projectRef: Option.Option<string>;
}

interface HostedRemoteSelectionOptions {
  /** The command path, e.g. `["network-bans", "get"]`. */
  readonly command: ReadonlyArray<string>;
  /** Argv between the command path and the selector; plain tokens only, so the deprecation hint echoes them verbatim. */
  readonly args?: ReadonlyArray<string>;
  readonly workdir: () => string;
  /** The command's own API answer; the branch listing is answered by the helper. */
  readonly respond: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientResponse.HttpClientResponse;
  /** Flags that decide which operations the command declares, for the permission drift check. */
  readonly activeFlags?: ActiveFlags;
  /** Runs the handler with `selector` and the flags `args` stands for. */
  readonly run: (
    selector: HostedSelector,
    layer: HostedSelectionLayer,
  ) => Effect.Effect<unknown, unknown, never>;
}

const none: HostedSelector = { remote: Option.none(), projectRef: Option.none() };

/**
 * Registers the project-selection cases of a hosted-only command: `--remote=<ref>`, a bare
 * `--remote`, `--remote=<branch>`, a rejected `--remote=<url>` and the deprecated `--project-ref`.
 */
export const describeHostedRemoteSelection = (options: HostedRemoteSelectionOptions): void => {
  const commandText = options.command.join(" ");
  const args = options.args ?? [];

  const harness = (selectorArgs: ReadonlyArray<string>) => {
    const argv = [...options.command, ...args, ...selectorArgs];
    return hostedSelectionLayer({
      command: options.command,
      argv,
      workdir: options.workdir(),
      respond: options.respond,
    });
  };
  const linkParent = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${options.workdir()}/supabase/.temp`, { recursive: true });
    yield* fs.writeFileString(`${options.workdir()}/supabase/.temp/project-ref`, VALID_REF);
  }).pipe(Effect.provide(BunServices.layer));
  const expectActedOn = (run: ReturnType<typeof harness>, ref: string) => {
    expect(run.cache.cachedRef).toBe(ref);
    const pathRefs = run.api.requests
      .filter((request) => !request.url.endsWith("/branches"))
      .flatMap((request) => /\/v1\/projects\/([^/?]+)\//.exec(request.url)?.[1] ?? []);
    expect(pathRefs).toEqual(pathRefs.map(() => ref));
  };
  const warnings = (out: ReturnType<typeof harness>["out"]) =>
    out.messages.filter((message) => message.type === "warn").map((message) => message.message);

  describe(`${commandText} remote selection`, () => {
    it.effect("acts on the project --remote=<ref> names, with no deprecation warning", () => {
      const run = harness([`--remote=${OTHER_REF}`]);
      return Effect.gen(function* () {
        yield* options.run(
          { ...none, remote: Option.some({ _tag: "Ref", ref: OTHER_REF }) },
          run.layer,
        );
        expectActedOn(run, OTHER_REF);
        expect(warnings(run.out)).toEqual([]);
      });
    });

    it.effect("acts on the linked project for a bare --remote", () => {
      const run = harness(["--remote"]);
      return Effect.gen(function* () {
        yield* linkParent;
        yield* options.run({ ...none, remote: Option.some({ _tag: "Linked" }) }, run.layer);
        expectActedOn(run, VALID_REF);
        expect(warnings(run.out)).toEqual([]);
      });
    });

    it.effect("acts on the project of the branch --remote=<branch> names", () => {
      const run = harness(["--remote=feature-x"]);
      return Effect.gen(function* () {
        yield* linkParent;
        yield* options.run(
          { ...none, remote: Option.some({ _tag: "Branch", name: "feature-x" }) },
          run.layer,
        );
        expect(`${run.api.requests[0]?.method} ${run.api.requests[0]?.url}`).toBe(
          `GET https://api.supabase.com/v1/projects/${VALID_REF}/branches`,
        );
        expectActedOn(run, BRANCH_REF);
        assertPermissionDrift({
          command: commandText,
          activeFlags: { ...options.activeFlags, remote: "feature-x" },
          requests: run.api.requests,
        });
      });
    });

    it.effect("rejects --remote=<url> before any request", () => {
      const { layer, api } = harness([`--remote=${DB_URL}`]);
      return Effect.gen(function* () {
        const error = yield* options
          .run({ ...none, remote: Option.some({ _tag: "DbUrl", url: DB_URL }) }, layer)
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "TargetNeedsProjectError",
          message: `\`supabase ${commandText}\` needs a project, not a database URL.`,
        });
        expect(api.requests).toEqual([]);
      });
    });

    it.effect("keeps --project-ref working and points at --remote=<ref>", () => {
      const run = harness(["--project-ref", OTHER_REF]);
      return Effect.gen(function* () {
        yield* options.run({ ...none, projectRef: Option.some(OTHER_REF) }, run.layer);
        expectActedOn(run, OTHER_REF);
        expect(warnings(run.out)).toEqual([
          `--project-ref is deprecated and will be removed in v4. Use --remote instead: ${["supabase", ...options.command, ...args].join(" ")} --remote=${OTHER_REF}`,
        ]);
      });
    });
  });
};
