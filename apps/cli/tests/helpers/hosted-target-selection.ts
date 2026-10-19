import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

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
  useTempWorkdir,
} from "./command-mocks.ts";
import type { ApiHandler } from "./command-mocks.ts";
import { mockOutput } from "./mocks.ts";
import { assertPermissionDrift } from "./permission-drift.ts";
import type { ActiveFlags, PermissionVariant } from "./permission-registry.ts";

const OTHER_REF = "qrstuvwxyzabcdefghij";
const BRANCH_REF = "branchprojectrefabcd";
const DB_URL = "postgresql://postgres:pw@db.example.com:5432/postgres";
const API_URL = "https://api.supabase.com";
const PROJECT_REF_IN_URL = /\/v[12]\/projects\/([a-z]{20})(?:[/?]|$)/;

/** The branch list the harness answers a `--remote=feature-x` lookup with. */
export const branchListRow = (name: string) => ({
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
 * warning, the `--project-ref` alias with its deprecation warning, a database URL rejected before
 * any request, and a branch name looked up under the linked project (or rejected, for a
 * parent-scoped command).
 */
export function describeTargetSelectionMatrix<R>(
  path: string,
  matrix: TargetSelectionMatrix<R>,
): void {
  const words = path.split(" ");
  const commandLine = [...words, ...matrix.operands].join(" ");
  const commandName = `\`supabase ${path}\``;
  const extraFlags = matrix.activeFlags ?? {};
  const driftVariant = matrix.variant === undefined ? {} : { variant: matrix.variant };
  // A parent-scoped command goes on to touch the branch's own project, so only the first project it reaches is the parent.
  const expectActedOn = (requests: ReadonlyArray<RecordedCall>, ref: string) => {
    const refs = projectRefsOf(requests);
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
      const { layer, requests, warnings } = harness([`--remote=${OTHER_REF}`], OTHER_REF);
      return Effect.gen(function* () {
        yield* prepare;
        yield* matrix.run({
          remote: Option.some({ _tag: "Ref", ref: OTHER_REF }),
          projectRef: Option.none(),
        });

        expectActedOn(requests(), OTHER_REF);
        expect(warnings()).toEqual([]);
        assertPermissionDrift({
          command: path,
          ...driftVariant,
          activeFlags: { ...extraFlags, remote: OTHER_REF },
          requests: requests(),
        });
      }).pipe(Effect.provide(layer));
    });

    it.effect("keeps --project-ref working and points at --remote=<ref>", () => {
      const { layer, requests, warnings } = harness(["--project-ref", OTHER_REF], OTHER_REF);
      return Effect.gen(function* () {
        yield* prepare;
        yield* matrix.run({ remote: Option.none(), projectRef: Option.some(OTHER_REF) });

        expectActedOn(requests(), OTHER_REF);
        expect(warnings()).toEqual([
          `--project-ref is deprecated and will be removed in v4. Use --remote instead: supabase ${commandLine} --remote=${OTHER_REF}`,
        ]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("rejects a database URL before any request", () => {
      const { layer, requests } = harness([`--remote=${DB_URL}`], VALID_REF);
      return Effect.gen(function* () {
        yield* prepare;
        const error = yield* matrix
          .run({ remote: Option.some({ _tag: "DbUrl", url: DB_URL }), projectRef: Option.none() })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "TargetNeedsProjectError",
          message: `${commandName} needs a project, not a database URL.`,
        });
        expect(requests()).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    if (matrix.mode === "parent") {
      it.effect("rejects a branch name and points at --remote=<ref>", () => {
        const { layer, requests } = harness(["--remote=feature-x"], VALID_REF);
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
          expect(requests()).toEqual([]);
        }).pipe(Effect.provide(layer));
      });
      return;
    }

    it.effect("acts on the project of the branch --remote=<branch> names", () => {
      const { layer, requests } = harness(["--remote=feature-x"], BRANCH_REF);
      return Effect.gen(function* () {
        yield* prepare;
        yield* matrix.linkParent(tempRoot.current);

        yield* matrix.run({
          remote: Option.some({ _tag: "Branch", name: "feature-x" }),
          projectRef: Option.none(),
        });

        expect(requests()[0]).toMatchObject({
          method: "GET",
          url: `${API_URL}/v1/projects/${VALID_REF}/branches`,
        });
        expect(projectRefsOf(requests())).toEqual([VALID_REF, BRANCH_REF]);
        assertPermissionDrift({
          command: path,
          ...driftVariant,
          activeFlags: { ...extraFlags, remote: "feature-x" },
          requests: requests(),
        });
      }).pipe(Effect.provide(layer));
    });
  });
}

const hostedLayer = (
  words: ReadonlyArray<string>,
  runtime: Parameters<typeof buildTestRuntime>[0],
) =>
  Layer.mergeAll(
    buildTestRuntime(runtime),
    commandRuntimeLayer(words).pipe(Layer.provide(BunServices.layer)),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "yes" }),
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
            ? Effect.succeed(jsonResponse(request, 200, [branchListRow("feature-x")]))
            : scenario.respond(request, expectedRef),
      });
      return {
        layer: hostedLayer(path.split(" "), {
          out,
          api,
          cliSettings: mockCommandSettings({ workdir, projectId: Option.none() }),
          cliArgs: selectorArgs,
        }),
        requests: () => api.requests,
        warnings: () =>
          out.messages
            .filter((message) => message.type === "warn")
            .map((message) => message.message),
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
