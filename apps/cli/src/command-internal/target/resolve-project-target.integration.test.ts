import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import {
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
} from "../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { ProjectRefNotLinkedError } from "../../config/project-ref.errors.ts";
import { ProjectRefResolver } from "../../config/project-ref.service.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { commandTargetLayer } from "../../shared/output/command-target.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import type { RemoteValue } from "./remote-value.ts";
import { resolveProjectTarget } from "./resolve-project-target.ts";

const FILE_REF = "filefilefilefilefile";
const FLAG_REF = "flagflagflagflagflag";
const BRANCH_REF = "branchprojectrefabcd";

const branchRow = (name: string) => ({
  id: "11111111-2222-4333-8444-555555555555",
  name,
  project_ref: BRANCH_REF,
  parent_project_ref: FILE_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: true,
});

const run = (
  input: { readonly remote?: RemoteValue; readonly projectRef?: string },
  options: {
    readonly linked?: boolean;
    readonly savedRef?: string;
    readonly args?: ReadonlyArray<string>;
    readonly branches?: ReadonlyArray<ReturnType<typeof branchRow>>;
  } = {},
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
    const out = mockOutput();
    const api = mockCommandPlatformApi({
      handler: (request) => Effect.succeed(jsonResponse(request, 200, options.branches ?? [])),
    });
    const exit = yield* resolveProjectTarget({
      remote: Option.fromNullishOr(input.remote),
      projectRef: Option.fromNullishOr(input.projectRef),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          commandTargetLayer.pipe(Layer.provide(out.layer)),
          out.layer,
          resolver,
          api.layer,
          mockCommandSettings({ workdir: dir, projectId: Option.none() }),
          commandRuntimeLayer(["functions", "deploy"]).pipe(Layer.provide(BunServices.layer)),
          options.args === undefined ? Layer.empty : Layer.succeed(CliArgs, { args: options.args }),
        ),
      ),
      Effect.exit,
    );
    return {
      exit,
      stderr: out.stderrText,
      warnings: out.messages.filter((m) => m.type === "warn").map((m) => m.message),
      refFlags,
      branchRequests: api.requests.length,
    };
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const refOf = (exit: Exit.Exit<string, unknown>) => {
  if (!Exit.isSuccess(exit)) throw new Error(`expected success, got ${Cause.pretty(exit.cause)}`);
  return exit.value;
};

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

  it.effect("uses the project --remote=<ref> names, with no deprecation warning", () =>
    Effect.gen(function* () {
      const result = yield* run({ remote: { _tag: "Ref", ref: FLAG_REF } });
      expect(refOf(result.exit)).toBe(FLAG_REF);
      expect(result.refFlags).toEqual([Option.some(FLAG_REF)]);
      expect(result.warnings).toEqual([]);
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
        `--project-ref is deprecated and will be removed in v4. Use --remote instead: supabase functions deploy hello --remote=${FLAG_REF}`,
      ]);
    }),
  );

  it.effect("looks a branch name up under the linked project and announces the branch", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { remote: { _tag: "Branch", name: "feature-x" } },
        { savedRef: FILE_REF, branches: [branchRow("feature-x")] },
      );
      expect(refOf(result.exit)).toBe(BRANCH_REF);
      expect(result.branchRequests).toBe(1);
      expect(result.refFlags).toEqual([]);
      expect(result.stderr).toContain(`project ${FILE_REF} · branch feature-x (${BRANCH_REF})`);
    }),
  );

  it.effect("treats a --project-ref that is not a ref as a branch name", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { projectRef: "feature-x" },
        { savedRef: FILE_REF, branches: [branchRow("feature-x")] },
      );
      expect(refOf(result.exit)).toBe(BRANCH_REF);
    }),
  );

  it.effect("rejects a database URL, naming the command", () =>
    Effect.gen(function* () {
      const result = yield* run({
        remote: { _tag: "DbUrl", url: "postgresql://postgres:pw@db.example.com:5432/postgres" },
      });
      expect(failureOf(result.exit)).toMatchObject({
        _tag: "TargetNeedsProjectError",
        message: "`supabase functions deploy` needs a project, not a database URL.",
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
          branches: [branchRow("feature-x")],
        },
      );
      expect(failureOf(result.exit)).toMatchObject({
        _tag: "TargetRemoteAmbiguousError",
        message: `feature-x is a branch of project ${FILE_REF}. Did you mean --remote=feature-x?`,
      });
    }),
  );

  it.effect("carries the not-linked failure through instead of guessing a project", () =>
    Effect.gen(function* () {
      const result = yield* run({}, { linked: false });
      expect(failureOf(result.exit)).toMatchObject({ _tag: "ProjectRefNotLinkedError" });
    }),
  );
});
