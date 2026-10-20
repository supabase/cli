import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Stdio } from "effect";

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
  useTempWorkdir,
} from "./command-mocks.ts";
import type { ApiHandler } from "./command-mocks.ts";
import { mockOutput } from "./mocks.ts";
import { assertPermissionDrift } from "./permission-drift.ts";
import type { ActiveFlags, PermissionVariant } from "./permission-registry.ts";
import { BRANCH_PROJECT_REF, branchRow, warningsOf } from "./remote-selection.ts";

const OTHER_REF = "qrstuvwxyzabcdefghij";
const API_URL = "https://api.supabase.com";
const PROJECT_REF_IN_URL = /\/v[12]\/projects\/([a-z]{20})(?:[/?]|$)/;

export interface TargetSelectionFlags {
  readonly remote: Option.Option<RemoteValue>;
  readonly projectRef: Option.Option<string>;
}

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly urlParams?: string;
}

interface TargetSelectionHarness<R> {
  readonly layer: Layer.Layer<R, unknown>;
  readonly requests: () => ReadonlyArray<RecordedCall>;
  readonly warnings: () => ReadonlyArray<string>;
  /** For a leaf whose requests never name its project (`sso info`, `snippets list`): the ref it cached as its target. */
  readonly cachedRef?: () => string | undefined;
}

export interface TargetSelectionMatrix<R> {
  /**
   * `"project"`: the command acts on the project `--remote` names, so a branch name is looked up
   * under the linked project. `"parent"`: it acts on a parent project, so a branch name is
   * rejected.
   */
  readonly mode: "project" | "parent";
  /** Positional words the command line carries, in order, ahead of the selector flag. */
  readonly operands: ReadonlyArray<string>;
  /** Flags the command's permission declaration conditions on, beyond the selector under test. */
  readonly activeFlags?: ActiveFlags;
  readonly variant?: PermissionVariant;
  /** Builds the runtime for one run; `selectorArgs` is the selector's share of the command line. */
  readonly harness: (input: {
    readonly selectorArgs: ReadonlyArray<string>;
    readonly expectedRef: string;
    readonly workdir: string;
  }) => TargetSelectionHarness<R>;
  /** Seeds the workdir before every run. */
  readonly prepare?: (workdir: string) => Effect.Effect<void, unknown, R>;
  /** Marks the workdir as linked to {@link VALID_REF}, the parent a branch name resolves under. */
  readonly linkParent: (workdir: string) => Effect.Effect<void, unknown, R>;
  readonly run: (flags: TargetSelectionFlags) => Effect.Effect<unknown, unknown, R>;
}

const projectRefsOf = (requests: ReadonlyArray<RecordedCall>): ReadonlyArray<string> => [
  ...new Set(
    requests.flatMap((request) => {
      const ref = PROJECT_REF_IN_URL.exec(new URL(request.url, API_URL).pathname)?.[1];
      return ref === undefined ? [] : [ref];
    }),
  ),
];

/**
 * Registers the `--remote` selection matrix for the leaf `path`: `--remote=<ref>` with no
 * warning, a bare `--remote` on the linked project, the `--project-ref` alias with its
 * deprecation warning, and a branch name looked up under the linked project (or rejected, for a
 * parent-scoped command).
 */
export function describeTargetSelectionMatrix<R>(
  path: string,
  matrix: TargetSelectionMatrix<R>,
): void {
  const words = path.split(" ");
  const commandName = `\`supabase ${path}\``;
  const extraFlags = matrix.activeFlags ?? {};
  const driftVariant = matrix.variant === undefined ? {} : { variant: matrix.variant };
  // A parent-scoped command goes on to touch the branch's own project, so only the first project it reaches is the parent.
  const expectActedOn = (run: TargetSelectionHarness<R>, ref: string) => {
    const refs = projectRefsOf(run.requests());
    if (run.cachedRef !== undefined) expect(run.cachedRef()).toBe(ref);
    if (run.cachedRef !== undefined && refs.length === 0) return;
    if (matrix.mode === "parent") expect(refs[0]).toBe(ref);
    else expect(refs).toEqual([ref]);
  };

  describe(`target selection: ${path}`, () => {
    const tempRoot = useTempWorkdir("supabase-target-selection-");

    const prepare = Effect.suspend(() => matrix.prepare?.(tempRoot.current) ?? Effect.void);

    const harness = (selectorArgs: ReadonlyArray<string>, expectedRef: string) =>
      matrix.harness({
        selectorArgs: [...words, ...matrix.operands, ...selectorArgs],
        expectedRef,
        workdir: tempRoot.current,
      });

    it.effect("uses the project --remote=<ref> names, with no deprecation warning", () => {
      const run = harness([`--remote=${OTHER_REF}`], OTHER_REF);
      return Effect.gen(function* () {
        yield* prepare;
        yield* matrix.run({
          remote: Option.some({ _tag: "Ref", ref: OTHER_REF }),
          projectRef: Option.none(),
        });

        expectActedOn(run, OTHER_REF);
        expect(run.warnings()).toEqual([]);
        assertPermissionDrift({
          command: path,
          ...driftVariant,
          activeFlags: { ...extraFlags, remote: OTHER_REF },
          requests: run.requests(),
        });
      }).pipe(Effect.provide(run.layer));
    });

    it.effect("acts on the linked project for a bare --remote, with no deprecation warning", () => {
      const run = harness(["--remote"], VALID_REF);
      return Effect.gen(function* () {
        yield* prepare;
        yield* matrix.linkParent(tempRoot.current);
        yield* matrix.run({ remote: Option.some({ _tag: "Linked" }), projectRef: Option.none() });

        expectActedOn(run, VALID_REF);
        expect(run.warnings()).toEqual([]);
      }).pipe(Effect.provide(run.layer));
    });

    it.effect("keeps --project-ref working and points at --remote=<ref>", () => {
      const run = harness(["--project-ref", OTHER_REF], OTHER_REF);
      return Effect.gen(function* () {
        yield* prepare;
        yield* matrix.run({ remote: Option.none(), projectRef: Option.some(OTHER_REF) });

        expectActedOn(run, OTHER_REF);
        expect(run.warnings()).toEqual([
          `--project-ref is deprecated and will be removed in v4. Use --remote=<ref> instead`,
        ]);
      }).pipe(Effect.provide(run.layer));
    });

    if (matrix.mode === "parent") {
      it.effect("rejects a branch name and points at --remote=<ref>", () => {
        const run = harness(["--remote=feature-x"], VALID_REF);
        return Effect.gen(function* () {
          yield* prepare;
          const error = yield* matrix
            .run({
              remote: Option.some({ _tag: "Branch", name: "feature-x" }),
              projectRef: Option.none(),
            })
            .pipe(Effect.flip);

          expect(error).toMatchObject({
            _tag: "TargetNeedsProjectError",
            message: `${commandName} acts on a parent project, so --remote takes its project ref, not a branch name. Use --remote=<ref>.`,
          });
          expect(run.requests()).toEqual([]);
        }).pipe(Effect.provide(run.layer));
      });
      return;
    }

    it.effect("acts on the project of the branch --remote=<branch> names", () => {
      const run = harness(["--remote=feature-x"], BRANCH_PROJECT_REF);
      return Effect.gen(function* () {
        yield* prepare;
        yield* matrix.linkParent(tempRoot.current);

        yield* matrix.run({
          remote: Option.some({ _tag: "Branch", name: "feature-x" }),
          projectRef: Option.none(),
        });

        expect(run.requests()[0]).toMatchObject({
          method: "GET",
          url: `${API_URL}/v1/projects/${VALID_REF}/branches`,
        });
        const refs = projectRefsOf(run.requests());
        if (run.cachedRef !== undefined) expect(run.cachedRef()).toBe(BRANCH_PROJECT_REF);
        expect(refs[0]).toBe(VALID_REF);
        if (run.cachedRef === undefined || refs.length > 1) {
          expect(refs).toEqual([VALID_REF, BRANCH_PROJECT_REF]);
        }
        assertPermissionDrift({
          command: path,
          ...driftVariant,
          activeFlags: { ...extraFlags, remote: "feature-x" },
          requests: run.requests(),
        });
      }).pipe(Effect.provide(run.layer));
    });
  });
}

const hostedLayer = (
  words: ReadonlyArray<string>,
  runtime: Parameters<typeof buildTestRuntime>[0],
  argv: ReadonlyArray<string>,
) =>
  Layer.mergeAll(
    buildTestRuntime(runtime),
    commandRuntimeLayer(words).pipe(Layer.provide(BunServices.layer)),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "yes" }),
    Stdio.layerTest({ args: Effect.succeed(argv) }),
  );

/** Everything a hosted leaf's handler can require while `describeHostedTargetSelection` runs it. */
type HostedTargetSelectionServices = Layer.Success<ReturnType<typeof hostedLayer>>;

export interface HostedTargetSelectionScenario {
  readonly mode?: "project" | "parent";
  readonly operands?: ReadonlyArray<string>;
  /**
   * The command's own success response, given the project ref the run should act on; in
   * `"project"` mode the harness answers the branch lookup itself.
   */
  readonly respond: (
    request: Parameters<ApiHandler>[0],
    expectedRef: string,
  ) => ReturnType<ApiHandler>;
  readonly run: (
    flags: TargetSelectionFlags,
  ) => Effect.Effect<unknown, unknown, HostedTargetSelectionServices>;
  readonly activeFlags?: ActiveFlags;
}

/** `describeTargetSelectionMatrix` for a hosted leaf whose runtime is `buildTestRuntime` over a mocked Management API. */
export function describeHostedTargetSelection(
  path: string,
  scenario: HostedTargetSelectionScenario,
): void {
  const mode = scenario.mode ?? "project";
  describeTargetSelectionMatrix<HostedTargetSelectionServices>(path, {
    mode,
    operands: scenario.operands ?? [],
    ...(scenario.activeFlags === undefined ? {} : { activeFlags: scenario.activeFlags }),
    run: scenario.run,
    harness: ({ selectorArgs, expectedRef, workdir }) => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        handler: (request) =>
          mode === "project" && request.method === "GET" && request.url.endsWith("/branches")
            ? Effect.succeed(jsonResponse(request, 200, [branchRow("feature-x")]))
            : scenario.respond(request, expectedRef),
      });
      const cache = mockLinkedProjectCacheTracked();
      return {
        layer: hostedLayer(
          path.split(" "),
          {
            out,
            api,
            cliSettings: mockCommandSettings({ workdir, projectId: Option.none() }),
            cliArgs: selectorArgs,
            linkedProjectCache: cache.layer,
          },
          selectorArgs,
        ),
        requests: () => api.requests,
        warnings: () => warningsOf(out),
        cachedRef: () => cache.cachedRef,
      };
    },
    linkParent: (workdir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = path.join(workdir, "supabase", ".temp");
        yield* fs.makeDirectory(temp, { recursive: true });
        yield* fs.writeFileString(path.join(temp, "project-ref"), VALID_REF);
      }).pipe(Effect.provide(BunServices.layer)),
  });
}
