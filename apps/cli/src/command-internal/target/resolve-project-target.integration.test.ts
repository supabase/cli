import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import {
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
} from "../../../tests/helpers/command-mocks.ts";
import { stripAnsi } from "../../../tests/helpers/ansi.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { branchRow } from "../../../tests/helpers/remote-selection.ts";
import { ProjectRefNotLinkedError } from "../../config/project-ref.errors.ts";
import { ProjectRefResolver } from "../../config/project-ref.service.ts";
import { rootCommandForFeatures } from "../../cli/root.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { prepareCliArgs } from "../../shared/cli/run.ts";
import { commandTargetLayer } from "../../shared/output/command-target.layer.ts";
import {
  CommandTarget,
  type CommandTargetJson,
} from "../../shared/output/command-target.service.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import type { RemoteValue } from "./remote-value.ts";
import { resolveProjectTarget } from "./resolve-project-target.ts";
import type { ProjectTargetFlagValues } from "./target-flags.ts";

const FILE_REF = "filefilefilefilefile";
const FLAG_REF = "flagflagflagflagflag";
const BRANCH_REF = "branchprojectrefabcd";

const fileBranch = (name: string, overrides: Parameters<typeof branchRow>[1] = {}) =>
  branchRow(name, { parent_project_ref: FILE_REF, ...overrides });

const BRANCH_UUID = "11111111-2222-4333-8444-555555555555";

const branchConfig = (ref: string, status: string) => ({
  ref,
  status,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  db_host: "h",
  db_port: 5432,
});

const root = rootCommandForFeatures();

interface RunOptions {
  readonly linked?: boolean;
  readonly savedRef?: string;
  readonly args?: ReadonlyArray<string>;
  readonly branches?: ReadonlyArray<ReturnType<typeof fileBranch>>;
  readonly branchById?: { readonly status: number; readonly body: unknown };
  readonly interactive?: boolean;
}

interface RunInput {
  readonly remote?: RemoteValue;
  readonly projectRef?: string;
}

const runWith = <A, E, R>(
  input: RunInput,
  options: RunOptions,
  resolve: (flags: ProjectTargetFlagValues) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "resolve-project-target-" });
    if (options.savedRef !== undefined) {
      yield* fs.makeDirectory(path.join(dir, "supabase", ".temp"), { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "supabase", ".temp", "project-ref"),
        options.savedRef,
      );
    }
    const refFlags: Array<Option.Option<string>> = [];
    const resolver = Layer.succeed(ProjectRefResolver, {
      resolveRef: (flagValue) =>
        options.linked === false
          ? Effect.fail(new ProjectRefNotLinkedError({ message: "Cannot find project ref." }))
          : Effect.sync(() => {
              refFlags.push(flagValue);
              return {
                ref: Option.getOrElse(flagValue, () => FILE_REF),
                source: Option.isSome(flagValue) ? ("flag" as const) : ("file" as const),
                matchesLinkedRef: Option.isNone(flagValue),
              };
            }),
      resolve: () => Effect.die("resolve is not used by resolveProjectTarget"),
      resolveForLink: () => Effect.die("resolveForLink is not used by resolveProjectTarget"),
      resolveOptional: () => Effect.die("resolveOptional is not used by resolveProjectTarget"),
      promptProjectRef: () => Effect.die("promptProjectRef is not used by resolveProjectTarget"),
    });
    const out = mockOutput(
      options.interactive === undefined ? {} : { interactive: options.interactive },
    );
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (request.url.includes("/v1/branches/")) {
          const byId = options.branchById ?? { status: 404, body: { message: "not found" } };
          return Effect.succeed(jsonResponse(request, byId.status, byId.body));
        }
        return Effect.succeed(jsonResponse(request, 200, options.branches ?? []));
      },
    });
    let announced: Option.Option<CommandTargetJson> = Option.none();
    const exit = yield* resolve({
      remote: Option.fromNullishOr(input.remote),
      projectRef: Option.fromNullishOr(input.projectRef),
    }).pipe(
      Effect.tap(() =>
        CommandTarget.use((cell) => cell.json).pipe(
          Effect.tap((json) =>
            Effect.sync(() => {
              announced = json;
            }),
          ),
        ),
      ),
      Effect.provide(
        Layer.mergeAll(
          commandTargetLayer.pipe(Layer.provide(out.layer)),
          out.layer,
          resolver,
          api.layer,
          mockCommandSettings({ workdir: dir, projectId: Option.none() }),
          commandRuntimeLayer(["functions", "deploy"]).pipe(Layer.provide(BunServices.layer)),
          options.args === undefined
            ? Layer.empty
            : Layer.succeed(CliArgs, prepareCliArgs(root, options.args)),
        ),
      ),
      Effect.exit,
    );
    return {
      exit,
      stderr: out.stderrText,
      stdout: out.stdoutText,
      target: announced,
      warnings: stripAnsi(out.stderrText)
        .split("\n")
        .filter((line) => line.startsWith("Warning: "))
        .map((line) => line.slice("Warning: ".length)),
      outputWarnCalls: out.messages.filter((m) => m.type === "warn"),
      progressEvents: out.progressEvents,
      refFlags,
      branchRequests: api.requests.length,
      requestedUrls: api.requests.map((request) => request.url),
    };
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const run = (input: RunInput, options: RunOptions = {}) =>
  runWith(input, options, (flags) => resolveProjectTarget(flags));

const runDetailed = (input: RunInput, options: RunOptions = {}) =>
  runWith(input, options, (flags) => resolveProjectTarget(flags, { detail: true }));

const successOf = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (!Exit.isSuccess(exit)) throw new Error(`expected success, got ${Cause.pretty(exit.cause)}`);
  return exit.value;
};

const refOf = (exit: Exit.Exit<string, unknown>) => successOf(exit);

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe("resolveProjectTarget", () => {
  it.effect.each([
    { name: "no selector", input: {} },
    { name: "a bare --remote", input: { remote: { _tag: "Linked" } as const } },
  ])("falls through to the project-ref chain for $name", ({ input }) =>
    Effect.gen(function* () {
      const result = yield* run(input);
      expect(refOf(result.exit)).toBe(FILE_REF);
      expect(result.refFlags).toEqual([Option.none()]);
      expect(result.warnings).toEqual([]);
    }),
  );

  it.effect("fails before any lookup when --remote is given twice with different values", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { remote: { _tag: "Branch", name: "feature-x" } },
        {
          savedRef: FILE_REF,
          args: ["functions", "deploy", "--remote=feature-x", `--remote=${FLAG_REF}`],
          branches: [fileBranch("feature-x")],
        },
      );
      expect(failureOf(result.exit)).toMatchObject({
        _tag: "TargetSelectorConflictError",
        flags: ["--remote"],
        message: "--remote is given more than once with different values; pass it once.",
        suggestion: "Pass --remote once, as --remote or --remote=<ref|branch>.",
      });
      expect(result.branchRequests).toBe(0);
      expect(result.refFlags).toEqual([]);
    }),
  );

  it.effect("uses the project --remote=<ref> names, with no deprecation warning", () =>
    Effect.gen(function* () {
      const result = yield* run({ remote: { _tag: "Ref", ref: FLAG_REF } });
      expect(refOf(result.exit)).toBe(FLAG_REF);
      expect(result.refFlags).toEqual([Option.some(FLAG_REF)]);
      expect(result.warnings).toEqual([]);
      expect(result.branchRequests).toBe(0);
    }),
  );

  it.effect("keeps --project-ref working and warns with the --remote form of the command", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { projectRef: FLAG_REF },
        { args: ["functions", "deploy", "--project-ref", FLAG_REF, "hello"] },
      );
      expect(refOf(result.exit)).toBe(FLAG_REF);
      expect(result.warnings).toEqual([
        `--project-ref is deprecated and will be removed in v4. Use --remote=<ref> instead`,
      ]);
      expect(result.outputWarnCalls).toEqual([]);
      expect(result.stdout).toBe("");
    }),
  );

  it.effect("looks a branch name up under the linked project and announces the branch", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { remote: { _tag: "Branch", name: "feature-x" } },
        { savedRef: FILE_REF, branches: [fileBranch("feature-x")] },
      );
      expect(refOf(result.exit)).toBe(BRANCH_REF);
      expect(result.branchRequests).toBe(1);
      expect(result.refFlags).toEqual([]);
      expect(result.stderr).toContain(`project ${FILE_REF} · branch feature-x (${BRANCH_REF})`);
    }),
  );

  it.effect("shows the branch lookup spinner on a terminal", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { remote: { _tag: "Branch", name: "feature-x" } },
        { savedRef: FILE_REF, branches: [fileBranch("feature-x")], interactive: true },
      );
      expect(refOf(result.exit)).toBe(BRANCH_REF);
      expect(result.progressEvents).toContainEqual({
        type: "start",
        message: "Resolving branch...",
      });
    }),
  );

  it.effect("keeps the branch lookup off stdout when it is not a terminal", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { remote: { _tag: "Branch", name: "feature-x" } },
        { savedRef: FILE_REF, branches: [fileBranch("feature-x")], interactive: false },
      );
      expect(refOf(result.exit)).toBe(BRANCH_REF);
      expect(result.progressEvents).toEqual([]);
      expect(result.stdout).toBe("");
    }),
  );

  it.effect("treats a --project-ref that is not a ref as a branch name", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { projectRef: "feature-x" },
        { savedRef: FILE_REF, branches: [fileBranch("feature-x")] },
      );
      expect(refOf(result.exit)).toBe(BRANCH_REF);
    }),
  );

  it.effect("rejects a database URL given to --project-ref, since a project has no database", () =>
    Effect.gen(function* () {
      const result = yield* run({
        projectRef: "postgresql://postgres:pw@db.example.com:5432/postgres",
      });
      expect(failureOf(result.exit)).toMatchObject({
        _tag: "TargetInvalidValueError",
        flag: "--project-ref",
        message: "--project-ref takes a project ref or a branch name, not a URL.",
      });
      expect(result.refFlags).toEqual([]);
    }),
  );

  it.effect("stops a bare --remote followed by a word that is a branch of the linked project", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { remote: { _tag: "Linked" } },
        {
          savedRef: FILE_REF,
          args: ["functions", "deploy", "--remote", "feature-x"],
          branches: [fileBranch("feature-x")],
        },
      );
      expect(failureOf(result.exit)).toMatchObject({
        _tag: "TargetRemoteAmbiguousError",
        message: `"feature-x" is a branch of project ${FILE_REF}. For the branch: supabase functions deploy --remote=feature-x. For the linked project: supabase functions deploy feature-x --remote`,
      });
    }),
  );

  it.effect("carries the not-linked failure through instead of guessing a project", () =>
    Effect.gen(function* () {
      const result = yield* run({}, { linked: false });
      expect(failureOf(result.exit)).toMatchObject({ _tag: "ProjectRefNotLinkedError" });
    }),
  );

  it.effect(
    "reads the branch list once, matching a branch UUID by id under the linked project",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          { remote: { _tag: "Branch", name: BRANCH_UUID } },
          { savedRef: FILE_REF, branches: [fileBranch("feature-x", { id: BRANCH_UUID })] },
        );
        expect(refOf(result.exit)).toBe(BRANCH_REF);
        expect(result.requestedUrls).toEqual([
          `https://api.supabase.com/v1/projects/${FILE_REF}/branches`,
        ]);
      }),
  );

  it.effect(
    "resolves a branch UUID through GET /v1/branches/{id} when no project is linked, as an unverified project",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          { remote: { _tag: "Branch", name: BRANCH_UUID } },
          { branchById: { status: 200, body: branchConfig(BRANCH_REF, "ACTIVE_HEALTHY") } },
        );
        expect(refOf(result.exit)).toBe(BRANCH_REF);
        expect(result.requestedUrls).toEqual([
          `https://api.supabase.com/v1/branches/${BRANCH_UUID}`,
        ]);
        expect(result.stderr).toBe(`Target: project ${BRANCH_REF}\n`);
        expect(result.target).toEqual(
          Option.some({ kind: "linked", project_ref: BRANCH_REF, environment: "unverified" }),
        );
      }),
  );

  it.effect("reports an unknown branch UUID without a linked project", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { remote: { _tag: "Branch", name: BRANCH_UUID } },
        { branchById: { status: 404, body: { message: "not found" } } },
      );
      expect(failureOf(result.exit)).toMatchObject({
        _tag: "LinkBranchListStatusError",
        message: expect.stringContaining(`Branch "${BRANCH_UUID}" not found`),
      });
    }),
  );

  it.effect("reports a UUID-shaped value the API would reject as an unknown branch", () =>
    Effect.gen(function* () {
      const name = "11111111-2222-3333-4444-555555555555";
      const result = yield* run({ remote: { _tag: "Branch", name } });
      expect(failureOf(result.exit)).toMatchObject({
        _tag: "LinkBranchListStatusError",
        status: 404,
        message: `Branch "${name}" not found. Run \`supabase branches list\` to see available branches.`,
      });
      expect(result.requestedUrls).toEqual([]);
    }),
  );

  it.effect("reports a branch UUID whose project is still provisioning", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { remote: { _tag: "Branch", name: BRANCH_UUID } },
        { branchById: { status: 200, body: branchConfig("", "CREATING_PROJECT") } },
      );
      expect(failureOf(result.exit)).toMatchObject({
        _tag: "LinkBranchNotReadyError",
        message: expect.stringContaining("has no project ref yet"),
      });
    }),
  );

  it.effect("asks for a linked project before looking a branch name up", () =>
    Effect.gen(function* () {
      const result = yield* run({ remote: { _tag: "Branch", name: "feature-x" } });
      expect(failureOf(result.exit)).toMatchObject({ _tag: "LinkBranchNotLinkedError" });
      expect(result.branchRequests).toBe(0);
    }),
  );
});

describe("resolveProjectTarget with detail", () => {
  it.effect("carries the source and linked-ref match the ref chain resolved", () =>
    Effect.gen(function* () {
      const flag = successOf((yield* runDetailed({ remote: { _tag: "Ref", ref: FLAG_REF } })).exit);
      expect(flag).toEqual({
        kind: "linked",
        ref: FLAG_REF,
        source: "flag",
        matchesLinkedRef: false,
      });
      const file = successOf((yield* runDetailed({})).exit);
      expect(file).toEqual({
        kind: "linked",
        ref: FILE_REF,
        source: "file",
        matchesLinkedRef: true,
      });
    }),
  );

  it.effect("names the branch and the project it was found under", () =>
    Effect.gen(function* () {
      const result = yield* runDetailed(
        { remote: { _tag: "Branch", name: "feature-x" } },
        { savedRef: FILE_REF, branches: [fileBranch("feature-x")] },
      );
      expect(successOf(result.exit)).toEqual({
        kind: "linked",
        ref: BRANCH_REF,
        source: "flag",
        matchesLinkedRef: false,
        branch: "feature-x",
        parentRef: FILE_REF,
        isDefault: false,
      });
    }),
  );

  it.effect("marks the production branch as the default", () =>
    Effect.gen(function* () {
      const result = yield* runDetailed(
        { remote: { _tag: "Branch", name: "main" } },
        {
          savedRef: FILE_REF,
          branches: [fileBranch("main", { project_ref: FILE_REF, is_default: true })],
        },
      );
      expect(successOf(result.exit)).toMatchObject({ ref: FILE_REF, isDefault: true });
    }),
  );

  it.effect("matches the linked ref when the branch's own ref is the saved one", () =>
    Effect.gen(function* () {
      const result = yield* runDetailed(
        { remote: { _tag: "Branch", name: "feature-x" } },
        { savedRef: BRANCH_REF, branches: [fileBranch("feature-x")] },
      );
      expect(successOf(result.exit)).toMatchObject({ ref: BRANCH_REF, matchesLinkedRef: true });
    }),
  );

  it.effect("names a branch resolved from a UUID by the UUID, with no parent", () =>
    Effect.gen(function* () {
      const result = yield* runDetailed(
        { remote: { _tag: "Branch", name: BRANCH_UUID } },
        { branchById: { status: 200, body: branchConfig(BRANCH_REF, "ACTIVE_HEALTHY") } },
      );
      expect(successOf(result.exit)).toEqual({
        kind: "linked",
        ref: BRANCH_REF,
        source: "flag",
        matchesLinkedRef: false,
        branch: BRANCH_UUID,
      });
    }),
  );
});
