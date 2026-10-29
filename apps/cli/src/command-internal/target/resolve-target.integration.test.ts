import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Tracer,
} from "effect";

import {
  VALID_REF,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  transportFailure,
} from "../../../tests/helpers/command-mocks.ts";
import { stripAnsi } from "../../../tests/helpers/ansi.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { branchRow } from "../../../tests/helpers/remote-selection.ts";
import { AccessTokenRequiredError, InvalidAccessTokenError } from "../../auth/errors.ts";
import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import { rootCommandForFeatures } from "../../cli/root.ts";
import { ProjectRefNotLinkedError } from "../../config/project-ref.errors.ts";
import { ProjectRefResolver } from "../../config/project-ref.service.ts";
import type { ProjectRefSource } from "../../config/project-ref.service.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { prepareCliArgs } from "../../shared/cli/run.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { commandTargetLayer } from "../../shared/output/command-target.layer.ts";
import { announceTarget } from "../../shared/output/command-target.service.ts";
import type { OutputFormat } from "../../shared/output/types.ts";
import {
  actionability,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";
import type { RemoteValue } from "./remote-value.ts";
import { resolveTarget } from "./resolve-target.ts";
import { renderLocalTarget } from "./target-identity.ts";
import { TargetPolicy } from "./target-policy.ts";
import type { TargetGroup } from "./target-policy.ts";
import type { TargetFlagValues } from "./target-flags.ts";

const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const none: TargetFlagValues = {
  remote: Option.none(),
  local: false,
  linked: false,
  dbUrl: Option.none(),
  projectRef: Option.none(),
};

const remote = (value: RemoteValue): Partial<TargetFlagValues> => ({
  remote: Option.some(value),
});

const FILE_REF = "filefilefilefilefile";
const FLAG_REF = "flagflagflagflagflag";
const BRANCH_REF = "branchprojectrefabcd";
const STALE_REF = "stalestalestalestale";
const GONE_REF = "gonegonegonegonegone";
const SECRET_URL =
  "postgresql://postgres:hunter2@db.abcdefghijklmnopqrst.supabase.co:5432/postgres";

const fileBranch = (name: string, overrides: Parameters<typeof branchRow>[1] = {}) =>
  branchRow(name, { parent_project_ref: FILE_REF, ...overrides });

const failingListings = {
  unavailable: { status: 500, message: "boom" },
  unauthorized: { status: 401, message: "Unauthorized" },
  forbidden: { status: 403, message: "Forbidden" },
  missing: { status: 404, message: "Not found" },
} as const;

type Listing = ReadonlyArray<ReturnType<typeof fileBranch>> | keyof typeof failingListings;

const root = rootCommandForFeatures();

const projectRefResolver = (options: { readonly linked: boolean }) => {
  const flags: Array<Option.Option<string>> = [];
  const layer = Layer.succeed(ProjectRefResolver, {
    resolveRef: (flagValue) =>
      options.linked
        ? Effect.sync(() => {
            flags.push(flagValue);
            const source: ProjectRefSource = Option.isSome(flagValue) ? "flag" : "file";
            return {
              ref: Option.getOrElse(flagValue, () => FILE_REF),
              source,
              matchesLinkedRef: !Option.isSome(flagValue),
            };
          })
        : Effect.fail(new ProjectRefNotLinkedError({ message: "Cannot find project ref." })),
    resolve: () => Effect.die("resolve is not used by resolveTarget"),
    resolveForLink: () => Effect.die("resolveForLink is not used by resolveTarget"),
    resolveOptional: () => Effect.die("resolveOptional is not used by resolveTarget"),
    promptProjectRef: () => Effect.die("promptProjectRef is not used by resolveTarget"),
  });
  return { layer, flags };
};

const run = (
  group: TargetGroup,
  input: TargetFlagValues,
  options: {
    readonly linked?: boolean;
    readonly projectId?: Option.Option<string>;
    readonly savedRef?: string;
    readonly cache?: { readonly ref: string; readonly name?: string };
    readonly args?: ReadonlyArray<string>;
    readonly command?: ReadonlyArray<string>;
    readonly format?: OutputFormat;
    readonly tokenFailure?: AccessTokenRequiredError | InvalidAccessTokenError;
    readonly storedToken?: boolean;
    readonly unreachable?: string;
    readonly branches?: Listing;
    readonly listings?: Readonly<Record<string, Listing>>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "resolve-target-" });
    yield* fs.makeDirectory(path.join(dir, "supabase", ".temp"), { recursive: true });
    if (options.savedRef !== undefined) {
      yield* fs.writeFileString(
        path.join(dir, "supabase", ".temp", "project-ref"),
        options.savedRef,
      );
    }
    if (options.cache !== undefined) {
      yield* fs.writeFileString(
        path.join(dir, "supabase", ".temp", "linked-project.json"),
        stringifyJson(options.cache),
      );
    }
    const resolver = projectRefResolver({ linked: options.linked ?? true });
    const out = mockOutput({ format: options.format ?? "text" });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (options.unreachable !== undefined) {
          return Effect.fail(transportFailure(request, options.unreachable));
        }
        const parentRef = new URL(request.url).pathname.split("/")[3] ?? "";
        const branches = options.listings?.[parentRef] ?? options.branches ?? [];
        if (typeof branches === "string") {
          const { status, message } = failingListings[branches];
          return Effect.succeed(jsonResponse(request, status, { message }));
        }
        return Effect.succeed(jsonResponse(request, 200, branches));
      },
    });
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(spanOptions) {
        const span = new Tracer.NativeSpan(spanOptions);
        spans.push(span);
        return span;
      },
    });
    const exit = yield* resolveTarget(input).pipe(
      Effect.tap(() => announceTarget(renderLocalTarget("127.0.0.1", 54322))),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(TargetPolicy, { group, consent: "none" }),
          commandTargetLayer.pipe(Layer.provide(out.layer)),
          out.layer,
          resolver.layer,
          options.tokenFailure === undefined
            ? api.layer
            : Layer.succeed(CommandPlatformApiFactory, { make: Effect.fail(options.tokenFailure) }),
          mockCommandSettings({
            workdir: dir,
            projectId: options.projectId ?? Option.none(),
            ...(options.storedToken === true ? { accessToken: Option.none() } : {}),
          }),
          options.args === undefined
            ? Layer.empty
            : Layer.succeed(CliArgs, prepareCliArgs(root, options.args)),
          options.command === undefined ? Layer.empty : commandRuntimeLayer(options.command),
        ),
      ),
      Effect.withTracer(tracer),
      Effect.withTracerEnabled(true),
      Effect.exit,
    );
    const attributes = spans.find((span) => span.name === "Target.resolve")?.attributes;
    return {
      exit,
      stdout: out.stdoutText,
      stderr: out.stderrText,
      warnings: stripAnsi(out.stderrText)
        .split("\n")
        .filter((line) => line.startsWith("Warning: "))
        .map((line) => line.slice("Warning: ".length)),
      refFlags: resolver.flags,
      apiRequests: api.requests.map(
        (request) => `${request.method} ${new URL(request.url).pathname}`,
      ),
      kind: attributes?.get("target.kind"),
      selection: attributes?.get("target.selection"),
    };
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const succeeded = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (!Exit.isSuccess(exit)) throw new Error(`expected success, got ${stringifyJson(exit)}`);
  return exit.value;
};

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe("resolveTarget", () => {
  it.effect("is local when nothing selects a target", () =>
    Effect.gen(function* () {
      const result = yield* run("selectable", none);
      expect(succeeded(result.exit)).toEqual({ kind: "local" });
      expect(result.refFlags).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect([result.kind, result.selection]).toEqual(["local", "default"]);
    }),
  );

  it.effect("stays local when only SUPABASE_PROJECT_ID is set", () =>
    Effect.gen(function* () {
      const result = yield* run("selectable", none, { projectId: Option.some(VALID_REF) });
      expect(succeeded(result.exit)).toEqual({ kind: "local" });
      expect(result.refFlags).toEqual([]);
    }),
  );

  describe("--remote", () => {
    it.effect("targets the linked project when bare", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", { ...none, ...remote({ _tag: "Linked" }) });
        expect(succeeded(result.exit)).toEqual({
          kind: "linked",
          ref: FILE_REF,
          source: "file",
          matchesLinkedRef: true,
        });
        expect(result.refFlags).toEqual([Option.none()]);
        expect(result.warnings).toEqual([]);
        expect([result.kind, result.selection]).toEqual(["linked", "flag"]);
      }),
    );

    it.effect("passes a project ref to the ref chain and marks it a flag source", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", {
          ...none,
          ...remote({ _tag: "Ref", ref: FLAG_REF }),
        });
        expect(succeeded(result.exit)).toEqual({
          kind: "linked",
          ref: FLAG_REF,
          source: "flag",
          matchesLinkedRef: false,
        });
        expect(result.refFlags).toEqual([Option.some(FLAG_REF)]);
        expect(result.apiRequests).toEqual([]);
      }),
    );

    it.effect("keeps a database URL redacted and never resolves a project", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", {
          ...none,
          ...remote({ _tag: "DbUrl", url: SECRET_URL }),
        });
        const target = succeeded(result.exit);
        expect(target.kind).toBe("db-url");
        if (target.kind === "db-url") expect(Redacted.value(target.url)).toBe(SECRET_URL);
        expect(stringifyJson(target)).not.toContain("hunter2");
        expect(result.refFlags).toEqual([]);
        expect(result.apiRequests).toEqual([]);
      }),
    );

    it.effect("resolves a branch name under the linked project and announces it", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "feature-x" }) },
          {
            savedRef: FILE_REF,
            branches: [fileBranch("feature-x"), fileBranch("other", { project_ref: FLAG_REF })],
          },
        );
        expect(succeeded(result.exit)).toEqual({
          kind: "linked",
          ref: BRANCH_REF,
          source: "flag",
          matchesLinkedRef: false,
          branch: "feature-x",
          parentRef: FILE_REF,
          isDefault: false,
        });
        expect(result.apiRequests).toEqual([`GET /v1/projects/${FILE_REF}/branches`]);
        expect(result.refFlags).toEqual([]);
        expect(result.stderr).toContain(`project ${FILE_REF} · branch feature-x (${BRANCH_REF})`);
      }),
    );

    it.effect("names the cached parent project in the branch banner", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "feature-x" }) },
          {
            savedRef: FILE_REF,
            cache: { ref: FILE_REF, name: "alpha" },
            branches: [fileBranch("feature-x")],
          },
        );
        expect(result.stderr).toContain(
          `Target: project alpha (${FILE_REF}) · branch feature-x (${BRANCH_REF})\n`,
        );
      }),
    );

    it.effect("looks a branch up under the cached parent that lists the linked project", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "feature-x" }) },
          {
            savedRef: BRANCH_REF,
            cache: { ref: FILE_REF },
            listings: {
              [FILE_REF]: [fileBranch("feature-x"), fileBranch("other", { project_ref: FLAG_REF })],
            },
          },
        );
        expect(succeeded(result.exit)).toMatchObject({ ref: BRANCH_REF, parentRef: FILE_REF });
        expect(result.apiRequests).toEqual([`GET /v1/projects/${FILE_REF}/branches`]);
      }),
    );

    it.effect("ignores a cached parent that does not list the linked project", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "feature-x" }) },
          {
            savedRef: FILE_REF,
            cache: { ref: STALE_REF },
            listings: {
              [STALE_REF]: [fileBranch("feature-x", { project_ref: FLAG_REF })],
              [FILE_REF]: [fileBranch("feature-x")],
            },
          },
        );
        expect(succeeded(result.exit)).toMatchObject({
          ref: BRANCH_REF,
          branch: "feature-x",
          parentRef: FILE_REF,
        });
      }),
    );

    it.effect("keeps the cached parent when the linked project cannot list branches", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "feature-x" }) },
          {
            savedRef: GONE_REF,
            cache: { ref: FILE_REF },
            listings: { [FILE_REF]: [fileBranch("feature-x")], [GONE_REF]: "missing" },
          },
        );
        expect(succeeded(result.exit)).toMatchObject({ ref: BRANCH_REF, parentRef: FILE_REF });
      }),
    );

    it.effect("announces the default branch as the production project", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "main" }) },
          {
            savedRef: FILE_REF,
            cache: { ref: FILE_REF, name: "alpha" },
            branches: [fileBranch("main", { project_ref: FILE_REF, is_default: true })],
          },
        );
        expect(succeeded(result.exit)).toMatchObject({ kind: "linked", ref: FILE_REF });
        expect(result.stderr).toContain(`Target: project alpha (${FILE_REF}) · production\n`);
        expect(result.stderr).not.toContain("branch main");
      }),
    );

    it.effect("announces a branch whose project is the parent as production", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "main" }) },
          { savedRef: FILE_REF, branches: [fileBranch("main", { project_ref: FILE_REF })] },
        );
        expect(result.stderr).toContain(`Target: project ${FILE_REF} · production\n`);
      }),
    );

    it.effect("fails with the available branches when none has that name", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "other-name" }) },
          { savedRef: FILE_REF, branches: [fileBranch("feature-x")] },
        );
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "LinkBranchNotFoundError",
          message: `Branch "other-name" not found for project ${FILE_REF}. Available branches: feature-x.`,
        });
      }),
    );

    it.effect("suggests the closest branch when the name is a near miss", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "feature-y" }) },
          { savedRef: FILE_REF, branches: [fileBranch("feature-x"), fileBranch("main")] },
        );
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "LinkBranchNotFoundError",
          message: `Branch "feature-y" not found for project ${FILE_REF}. Available branches: feature-x, main. Did you mean "feature-x"?`,
        });
      }),
    );

    it.effect("suggests the branch when two letters of the name are swapped", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "mian" }) },
          {
            savedRef: FILE_REF,
            branches: [fileBranch("main", { project_ref: FILE_REF, is_default: true })],
          },
        );
        expect(failureOf(result.exit)).toMatchObject({ _tag: "LinkBranchNotFoundError" });
        expect(String((failureOf(result.exit) as Error).message)).toContain(
          'Available branches: main. Did you mean "main"?',
        );
      }),
    );

    it.effect("suggests the lowercased ref when a 20-letter value has uppercase letters", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "ABCDEFGHIJKLMNOPQRST" }) },
          { savedRef: FILE_REF, branches: [fileBranch("main")] },
        );
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "LinkBranchNotFoundError",
          message: `Branch "ABCDEFGHIJKLMNOPQRST" not found for project ${FILE_REF}. Available branches: main.\n  If you meant a project ref: refs are exactly 20 lowercase letters (try "abcdefghijklmnopqrst").`,
        });
      }),
    );

    it.effect("gives no ref hint to a mixed-case value that is not 20 letters", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "ABCDEFGHIJKLMNOPQRS" }) },
          { savedRef: FILE_REF, branches: [fileBranch("main")] },
        );
        expect(String((failureOf(result.exit) as Error).message)).not.toContain(
          "If you meant a project ref",
        );
      }),
    );

    it.effect("tells an expired token to log in instead of showing the response body", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "feature-x" }) },
          { savedRef: FILE_REF, branches: "unauthorized" },
        );
        const error = failureOf(result.exit);
        expect(error).toMatchObject({ _tag: "LinkBranchListStatusError", status: 401 });
        expect(String((error as Error).message)).toBe(
          "Authentication failed: your access token is invalid or has expired. Run `supabase login` to re-authenticate.",
        );
      }),
    );

    it.effect("asks to link the parent project when no project is linked", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", {
          ...none,
          ...remote({ _tag: "Branch", name: "feature-x" }),
        });
        expect(failureOf(result.exit)).toMatchObject({ _tag: "LinkBranchNotLinkedError" });
        expect(result.apiRequests).toEqual([]);
      }),
    );

    it.effect("suggests the lowercased ref when no project is linked", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", {
          ...none,
          ...remote({ _tag: "Branch", name: "ABCDEFGHIJKLMNOPQRST" }),
        });
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "LinkBranchNotLinkedError",
          message: expect.stringContaining(
            'If you meant a project ref: refs are exactly 20 lowercase letters (try "abcdefghijklmnopqrst").',
          ),
        });
      }),
    );

    it.effect("fails with not-linked instead of falling back to local when it cannot resolve", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Linked" }) },
          { linked: false },
        );
        expect(failureOf(result.exit)).toMatchObject({ _tag: "ProjectRefNotLinkedError" });
      }),
    );
  });

  describe("a bare --remote followed by a word", () => {
    const args = ["db", "pull", "--remote", "feature-x"];
    const command = ["db", "pull"];
    const bare = { ...none, ...remote({ _tag: "Linked" }) };
    const options = `For the branch: supabase db pull --remote=feature-x. For the linked project: supabase db pull feature-x --remote`;
    const placeholderOptions = `For the branch: supabase db pull --remote=<branch>. For the linked project, put --remote last: supabase db pull <operands> --remote`;

    it.effect("fails when the word is a branch of the linked project", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          command,
          savedRef: FILE_REF,
          branches: [fileBranch("feature-x")],
        });
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `"feature-x" is a branch of project ${FILE_REF}. ${options}`,
        });
        expect(result.refFlags).toEqual([]);
      }),
    );

    it.effect("checks the branches of the linked project when the cached parent is stale", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          command,
          savedRef: FILE_REF,
          cache: { ref: STALE_REF },
          listings: {
            [STALE_REF]: [fileBranch("other", { project_ref: FLAG_REF })],
            [FILE_REF]: [fileBranch("feature-x")],
          },
        });
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `"feature-x" is a branch of project ${FILE_REF}. ${options}`,
        });
      }),
    );

    it.effect("resolves the linked project when the word names no branch", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          savedRef: FILE_REF,
          branches: [fileBranch("other")],
        });
        expect(succeeded(result.exit)).toMatchObject({ kind: "linked", ref: FILE_REF });
      }),
    );

    it.effect.each([
      { name: "a project is linked", options: { savedRef: FILE_REF } },
      { name: "no project is linked", options: { linked: false } },
    ])(
      "fails before any lookup when the word is shaped like a project ref and $name",
      ({ options: linkState }) =>
        Effect.gen(function* () {
          const result = yield* run("selectable", bare, {
            ...linkState,
            args: ["db", "pull", "--remote", FLAG_REF],
            command,
            branches: [fileBranch("feature-x")],
          });
          expect(failureOf(result.exit)).toMatchObject({
            _tag: "TargetRemoteAmbiguousError",
            message: `"${FLAG_REF}" after --remote looks like a project ref. For that project: supabase db pull --remote=${FLAG_REF}. To keep it as an operand, put --remote last: supabase db pull <operands> --remote`,
          });
          expect(result.apiRequests).toEqual([]);
          expect(result.refFlags).toEqual([]);
        }),
    );

    it.effect("names the branch of a linked, named project", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          command,
          savedRef: FILE_REF,
          cache: { ref: FILE_REF, name: "alpha" },
          branches: [fileBranch("feature-x")],
        });
        expect(failureOf(result.exit)).toMatchObject({
          message: `"feature-x" is a branch of alpha (${FILE_REF}). ${options}`,
        });
      }),
    );

    it.effect("fails when the branches cannot be listed to tell, keeping the cause", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          command,
          savedRef: FILE_REF,
          branches: "unavailable",
        });
        const error = failureOf(result.exit);
        expect(error).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `Can't tell whether the word after --remote is a branch (listing the branches of project ${FILE_REF} failed: HTTP 500). ${placeholderOptions}`,
          status: 500,
          cause: { _tag: "LinkBranchListStatusError", status: 500 },
        });
        expect(error).not.toHaveProperty("suggestion");
      }),
    );

    it.effect("names the transport failure when the listing never gets a response", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          command,
          savedRef: FILE_REF,
          unreachable: "ECONNREFUSED",
        });
        const error = failureOf(result.exit);
        expect(error).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `Can't tell whether the word after --remote is a branch (listing the branches of project ${FILE_REF} failed: ECONNREFUSED). ${placeholderOptions}`,
          cause: { _tag: "LinkBranchListNetworkError" },
        });
        expect(error).not.toHaveProperty("status");
        expect(error).not.toHaveProperty("suggestion");
      }),
    );

    it.effect("keeps URL credentials out of a transport failure it names", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          command,
          savedRef: FILE_REF,
          unreachable:
            "connect ECONNREFUSED https://proxy-user:hunter2@proxy.test:8080\nsecond line",
        });
        const message = String((failureOf(result.exit) as Error).message);
        expect(message).toContain(
          `failed: connect ECONNREFUSED https://proxy.test:8080). ${placeholderOptions}`,
        );
        expect(message).not.toContain("hunter2");
        expect(message).not.toContain("second line");
      }),
    );

    it.effect.each([
      {
        name: "unauthorized with a token from SUPABASE_ACCESS_TOKEN",
        branches: "unauthorized",
        storedToken: false,
        status: 401,
        suggestion: "Set SUPABASE_ACCESS_TOKEN to a valid access token.",
        actionability: actionability.authToken,
      },
      {
        name: "unauthorized with a stored token",
        branches: "unauthorized",
        storedToken: true,
        status: 401,
        suggestion: "Run `supabase login` with an account that can list this project's branches.",
        actionability: statusCodeActionability(401),
      },
      {
        name: "forbidden",
        branches: "forbidden",
        storedToken: false,
        status: 403,
        suggestion: "Use an access token that can read this project's branches.",
        actionability: statusCodeActionability(403),
      },
      {
        name: "not found",
        branches: "missing",
        storedToken: false,
        status: 404,
        suggestion: `If ${FILE_REF} is itself a preview branch, link its parent project first: supabase link --project-ref <parent-ref>`,
        actionability: actionability.provideFlags,
      },
    ] as const)("suggests the fix when the branch listing is $name", (testCase) =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          command,
          savedRef: FILE_REF,
          branches: testCase.branches,
          storedToken: testCase.storedToken,
        });
        const error = failureOf(result.exit);
        expect(error).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `Can't tell whether the word after --remote is a branch (listing the branches of project ${FILE_REF} failed: HTTP ${testCase.status}). ${placeholderOptions}`,
          suggestion: testCase.suggestion,
          status: testCase.status,
        });
        expect((error as { [ErrorActionabilityId]: unknown })[ErrorActionabilityId]).toEqual(
          testCase.actionability,
        );
      }),
    );

    it.effect.each([
      {
        name: "no access token",
        failure: new AccessTokenRequiredError({ message: "Access token not provided." }),
        reason: "no access token is set",
        suggestion: "Run `supabase login` with an account that can list this project's branches.",
        actionability: actionability.authLogin,
      },
      {
        name: "a malformed stored access token",
        failure: new InvalidAccessTokenError({ message: "Invalid access token format." }),
        reason: "the stored access token is not valid",
        suggestion: "Run `supabase login` with an account that can list this project's branches.",
        actionability: actionability.authLogin,
      },
      {
        name: "a malformed SUPABASE_ACCESS_TOKEN",
        failure: new InvalidAccessTokenError({
          message: "Invalid access token format.",
          source: "env",
        }),
        reason: "SUPABASE_ACCESS_TOKEN is not a valid access token",
        suggestion: "Set SUPABASE_ACCESS_TOKEN to a valid access token.",
        actionability: actionability.authToken,
      },
    ])("names the cause and how to fix it when the listing has $name", (testCase) =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          command,
          savedRef: FILE_REF,
          tokenFailure: testCase.failure,
        });
        const error = failureOf(result.exit);
        expect(error).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `Can't tell whether the word after --remote is a branch (listing the branches of project ${FILE_REF} failed because ${testCase.reason}). ${placeholderOptions}`,
          suggestion: testCase.suggestion,
          cause: testCase.failure,
        });
        expect(error).not.toHaveProperty("status");
        expect((error as { [ErrorActionabilityId]: unknown })[ErrorActionabilityId]).toEqual(
          testCase.actionability,
        );
      }),
    );

    it.effect.each(["text", "json"] as const)(
      "never prints a NAME=value pair after --remote when the listing is forbidden (%s)",
      (format) =>
        Effect.gen(function* () {
          const result = yield* run("selectable", bare, {
            args: ["secrets", "set", "--remote", "STRIPE_KEY=sk_live_secret"],
            command: ["secrets", "set"],
            format,
            savedRef: FILE_REF,
            branches: "forbidden",
          });
          expect(succeeded(result.exit)).toMatchObject({ kind: "linked", ref: FILE_REF });
          expect(result.apiRequests).toEqual([]);
          expect(result.stdout + result.stderr).not.toContain("sk_live_secret");
        }),
    );

    it.effect("never echoes a word it could not check against the branches", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args: ["secrets", "unset", "--remote", "sk_live_secret"],
          command: ["secrets", "unset"],
          savedRef: FILE_REF,
          branches: "forbidden",
        });
        const error = failureOf(result.exit);
        expect(error).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `Can't tell whether the word after --remote is a branch (listing the branches of project ${FILE_REF} failed: HTTP 403). For the branch: supabase secrets unset --remote=<branch>. For the linked project, put --remote last: supabase secrets unset <operands> --remote`,
        });
        expect(stringifyJson(error)).not.toContain("sk_live_secret");
      }),
    );

    it.effect("fails for a word one edit from a branch, naming the closest branch", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args: ["db", "pull", "--remote", "feature-y"],
          command,
          savedRef: FILE_REF,
          branches: [fileBranch("feature-x"), fileBranch("main")],
        });
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `"feature-y" isn't a branch, but "feature-x" is. For the branch: supabase db pull --remote=feature-x. For the linked project: supabase db pull feature-y --remote`,
        });
        expect(result.refFlags).toEqual([]);
      }),
    );

    it.effect.each([
      { name: "two edits from a branch", word: "feature-yz", branches: [fileBranch("feature-x")] },
      { name: "one edit from a short branch", word: "den", branches: [fileBranch("dev")] },
      {
        name: "one edit from the default branch",
        word: "mail",
        branches: [fileBranch("main", { project_ref: FILE_REF, is_default: true })],
      },
    ])("keeps a word that is $name as an operand", ({ word, branches }) =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args: ["db", "pull", "--remote", word],
          command,
          savedRef: FILE_REF,
          branches,
        });
        expect(succeeded(result.exit)).toMatchObject({ kind: "linked", ref: FILE_REF });
      }),
    );

    it.effect("fails for a word with two letters swapped from a branch", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args: ["db", "pull", "--remote", "stagign"],
          command,
          savedRef: FILE_REF,
          branches: [fileBranch("staging")],
        });
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `"stagign" isn't a branch, but "staging" is. For the branch: supabase db pull --remote=staging. For the linked project: supabase db pull stagign --remote`,
        });
      }),
    );

    it.effect("fails for a word that differs from the default branch only by case", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args: ["db", "pull", "--remote", "Main"],
          command,
          savedRef: FILE_REF,
          branches: [fileBranch("main", { project_ref: FILE_REF, is_default: true })],
        });
        expect(failureOf(result.exit)).toMatchObject({
          message: `"Main" isn't a branch, but "main" is. For the branch: supabase db pull --remote=main. For the linked project: supabase db pull Main --remote`,
        });
      }),
    );

    it.effect("fails for a word that differs from a branch only by case", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args: ["db", "pull", "--remote", "Feature-X"],
          command,
          savedRef: FILE_REF,
          branches: [fileBranch("feature-x")],
        });
        expect(failureOf(result.exit)).toMatchObject({
          message: `"Feature-X" isn't a branch, but "feature-x" is. For the branch: supabase db pull --remote=feature-x. For the linked project: supabase db pull Feature-X --remote`,
        });
      }),
    );

    it.effect("never echoes the userinfo of a word that carries credentials", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args: ["db", "pull", "--remote", "hunter2:pw@feature-x"],
          command,
          savedRef: FILE_REF,
          branches: [fileBranch("feature-x")],
        });
        const message = String((failureOf(result.exit) as Error).message);
        expect(message).toContain(`"feature-x" is a branch`);
        expect(message).not.toContain("hunter2");
      }),
    );

    it.effect.each([
      { name: "a path", args: ["storage", "ls", "--remote", "./photos"] },
      { name: "a URL", args: ["storage", "ls", "--remote", "ss:///bucket"] },
      { name: "a flag", args: ["db", "push", "--remote", "--dry-run"] },
      { name: "nothing", args: ["db", "push", "--remote"] },
    ])("does not look up branches when the next token is $name", ({ args: tokens }) =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args: tokens,
          savedRef: FILE_REF,
          branches: [fileBranch("feature-x")],
        });
        expect(succeeded(result.exit)).toMatchObject({ kind: "linked" });
        expect(result.apiRequests).toEqual([]);
      }),
    );

    it.effect.each([
      { name: "seed buckets", raw: ["seed", "--remote", "buckets"] },
      { name: "db push", raw: ["db", "--remote", "push"] },
    ])("does not look up the $name subcommand as a branch", ({ raw }) =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args: raw,
          savedRef: FILE_REF,
          branches: "unavailable",
        });
        expect(succeeded(result.exit)).toMatchObject({ kind: "linked", ref: FILE_REF });
        expect(result.apiRequests).toEqual([]);
      }),
    );

    it.effect("still fails for a branch the command would otherwise take as its operand", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args: ["db", "pull", "--remote", "feature-x"],
          command,
          savedRef: FILE_REF,
          branches: [fileBranch("feature-x")],
        });
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `"feature-x" is a branch of project ${FILE_REF}. ${options}`,
        });
      }),
    );

    it.effect("does not look up branches when no project is linked", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          branches: [fileBranch("feature-x")],
        });
        expect(succeeded(result.exit)).toMatchObject({ kind: "linked" });
        expect(result.apiRequests).toEqual([]);
      }),
    );
  });

  describe("a repeated --remote", () => {
    const command = ["db", "push"];
    const bare = { ...none, ...remote({ _tag: "Linked" }) };

    it.effect("fails before anything runs when the values differ", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "feature-x" }) },
          {
            args: ["db", "push", "--remote=feature-x", "--remote"],
            command,
            savedRef: FILE_REF,
            branches: [fileBranch("feature-x")],
          },
        );
        const error = failureOf(result.exit);
        expect(error).toMatchObject({
          _tag: "TargetSelectorConflictError",
          flags: ["--remote"],
          message: "--remote is given more than once with different values; pass it once.",
          suggestion: "Pass --remote once, as --remote or --remote=<ref|branch|url>.",
        });
        expect((error as { [ErrorActionabilityId]: unknown })[ErrorActionabilityId]).toEqual(
          actionability.provideFlags,
        );
        expect(result.apiRequests).toEqual([]);
        expect(result.refFlags).toEqual([]);
      }),
    );

    it.effect.each([
      { name: "the same value", args: ["db", "push", "--remote=feature-x", "--remote=feature-x"] },
      { name: "a bare switch", args: ["db", "push", "--remote", "--remote"] },
    ])("accepts $name given twice", ({ args }) =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, { args, command, savedRef: FILE_REF });
        expect(succeeded(result.exit)).toMatchObject({ kind: "linked", ref: FILE_REF });
      }),
    );
  });

  describe("deprecated selectors", () => {
    it.effect(
      "warns that --db-url is deprecated and offers its project ref, without echoing secrets",
      () =>
        Effect.gen(function* () {
          const result = yield* run(
            "selectable",
            { ...none, dbUrl: Option.some(SECRET_URL) },
            {
              args: ["db", "push", "--db-url", SECRET_URL, "--password", "hunter2"],
              command: ["db", "push"],
            },
          );
          expect(succeeded(result.exit)).toMatchObject({ kind: "db-url" });
          expect(result.warnings).toEqual([
            "--db-url is deprecated and will be removed in v4. Use --remote=<db-url> instead, or --remote=abcdefghijklmnopqrst with an access token set",
          ]);
          expect(result.warnings.join("\n")).not.toContain("hunter2");
        }),
    );

    it.effect("does not warn for --remote itself", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", { ...none, ...remote({ _tag: "Linked" }) });
        expect(result.warnings).toEqual([]);
      }),
    );
  });

  it.effect("rejects conflicting selectors", () =>
    Effect.gen(function* () {
      const result = yield* run("selectable", {
        ...none,
        ...remote({ _tag: "Linked" }),
        linked: true,
      });
      expect(failureOf(result.exit)).toMatchObject({ _tag: "TargetSelectorConflictError" });
    }),
  );

  describe("the default-local banner", () => {
    it.effect("hints at --remote when the checkout is linked", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", none, {
          savedRef: FILE_REF,
          cache: { ref: FILE_REF, name: "alpha" },
        });
        expect(succeeded(result.exit)).toEqual({ kind: "local" });
        expect(result.stderr).toBe(
          `Target: local stack (127.0.0.1:54322) · default; pass --remote for alpha (${FILE_REF})\n`,
        );
      }),
    );

    it.effect("hints with the bare ref when the cache does not name the linked project", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", none, { savedRef: FILE_REF });
        expect(result.stderr).toBe(
          `Target: local stack (127.0.0.1:54322) · default; pass --remote for ${FILE_REF}\n`,
        );
      }),
    );

    it.effect("hints from SUPABASE_PROJECT_ID when nothing is linked on disk", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", none, { projectId: Option.some(FILE_REF) });
        expect(result.stderr).toBe(
          `Target: local stack (127.0.0.1:54322) · default; pass --remote for ${FILE_REF}\n`,
        );
      }),
    );

    it.effect("names the project SUPABASE_PROJECT_ID points at when the cache knows it", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", none, {
          projectId: Option.some(FILE_REF),
          cache: { ref: FILE_REF, name: "alpha" },
        });
        expect(result.stderr).toBe(
          `Target: local stack (127.0.0.1:54322) · default; pass --remote for alpha (${FILE_REF})\n`,
        );
      }),
    );

    it.effect("prefers SUPABASE_PROJECT_ID over the link file", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", none, {
          projectId: Option.some(FILE_REF),
          savedRef: FLAG_REF,
        });
        expect(result.stderr).toBe(
          `Target: local stack (127.0.0.1:54322) · default; pass --remote for ${FILE_REF}\n`,
        );
      }),
    );

    it.effect("adds no hint when SUPABASE_PROJECT_ID is not a project ref", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", none, { projectId: Option.some("not-a-ref") });
        expect(result.stderr).toBe("Target: local stack (127.0.0.1:54322)\n");
      }),
    );

    it.effect(
      "adds no hint when SUPABASE_PROJECT_ID is not a project ref, even if a link exists",
      () =>
        Effect.gen(function* () {
          const result = yield* run("selectable", none, {
            projectId: Option.some("not-a-ref"),
            savedRef: FILE_REF,
          });
          expect(result.stderr).toBe("Target: local stack (127.0.0.1:54322)\n");
        }),
    );

    it.effect("adds no hint when the checkout is not linked", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", none, { cache: { ref: FILE_REF, name: "alpha" } });
        expect(result.stderr).toBe("Target: local stack (127.0.0.1:54322)\n");
      }),
    );

    it.effect("warns that --local is not needed and adds no hint, even in a linked checkout", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", { ...none, local: true }, { savedRef: FILE_REF });
        expect(succeeded(result.exit)).toEqual({ kind: "local" });
        expect(result.refFlags).toEqual([]);
        expect(stripAnsi(result.stderr)).toBe(
          "Warning: --local isn't needed (local is the default) and will be removed in v4\nTarget: local stack (127.0.0.1:54322)\n",
        );
      }),
    );
  });

  it.effect.each(["local-only", "account", "hosted", "removed"] satisfies Array<TargetGroup>)(
    "dies for a %s command",
    (group) =>
      Effect.gen(function* () {
        const result = yield* run(group, none);
        expect(Exit.isFailure(result.exit)).toBe(true);
        if (Exit.isFailure(result.exit)) {
          expect(Cause.pretty(result.exit.cause)).toContain(
            "resolveTarget needs a selectable command",
          );
        }
      }),
  );
});
