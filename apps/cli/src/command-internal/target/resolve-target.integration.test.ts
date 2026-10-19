import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Redacted, Tracer } from "effect";

import {
  VALID_REF,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
} from "../../../tests/helpers/command-mocks.ts";
import { stripAnsi } from "../../../tests/helpers/ansi.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { rootCommandForFeatures } from "../../cli/root.ts";
import { ProjectRefNotLinkedError } from "../../config/project-ref.errors.ts";
import { ProjectRefResolver } from "../../config/project-ref.service.ts";
import type { ProjectRefSource } from "../../config/project-ref.service.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { remoteArgvLeafFor, rewriteRemoteArgv } from "../../shared/cli/run.ts";
import { commandTargetLayer } from "../../shared/output/command-target.layer.ts";
import { announceTarget } from "../../shared/output/command-target.service.ts";
import type { OutputFormat } from "../../shared/output/types.ts";
import type { RemoteValue } from "./remote-value.ts";
import { resolveTarget } from "./resolve-target.ts";
import { renderLocalTarget } from "./target-identity.ts";
import { TargetPolicy } from "./target-policy.ts";
import type { TargetGroup } from "./target-policy.ts";
import type { TargetSelectorInput } from "./target-selector.ts";

const none: TargetSelectorInput = {
  remote: Option.none(),
  local: false,
  linked: false,
  dbUrl: Option.none(),
  projectRef: Option.none(),
};

const remote = (value: RemoteValue): Partial<TargetSelectorInput> => ({
  remote: Option.some(value),
});

const FILE_REF = "filefilefilefilefile";
const FLAG_REF = "flagflagflagflagflag";
const BRANCH_REF = "branchprojectrefabcd";
const SECRET_URL =
  "postgresql://postgres:hunter2@db.abcdefghijklmnopqrst.supabase.co:5432/postgres";

const branchRow = (name: string, projectRef = BRANCH_REF) => ({
  id: "11111111-2222-4333-8444-555555555555",
  name,
  project_ref: projectRef,
  parent_project_ref: FILE_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: true,
});

const root = rootCommandForFeatures();

const cliArgsFor = (raw: ReadonlyArray<string>) => {
  const args = rewriteRemoteArgv(root, raw);
  return { args, remoteLeaf: remoteArgvLeafFor(root, args) };
};

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
  input: TargetSelectorInput,
  options: {
    readonly linked?: boolean;
    readonly projectId?: Option.Option<string>;
    readonly savedRef?: string;
    readonly cache?: { readonly ref: string; readonly name?: string };
    readonly args?: ReadonlyArray<string>;
    readonly cliArgs?: ReturnType<typeof cliArgsFor>;
    readonly format?: OutputFormat;
    readonly branches?: ReadonlyArray<ReturnType<typeof branchRow>> | "unavailable";
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
        JSON.stringify(options.cache),
      );
    }
    const resolver = projectRefResolver({ linked: options.linked ?? true });
    const out = mockOutput({ format: options.format ?? "text" });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.succeed(
          options.branches === "unavailable"
            ? jsonResponse(request, 500, { message: "boom" })
            : jsonResponse(request, 200, options.branches ?? []),
        ),
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
          api.layer,
          mockCommandSettings({
            workdir: dir,
            projectId: options.projectId ?? Option.none(),
          }),
          options.cliArgs !== undefined
            ? Layer.succeed(CliArgs, options.cliArgs)
            : options.args === undefined
              ? Layer.empty
              : Layer.succeed(CliArgs, { args: options.args }),
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
      outputWarnCalls: out.messages.filter((m) => m.type === "warn"),
      refFlags: resolver.flags,
      apiRequests: api.requests.map(
        (request) => `${request.method} ${new URL(request.url).pathname}`,
      ),
      kind: attributes?.get("target.kind"),
      selection: attributes?.get("target.selection"),
    };
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const succeeded = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (!Exit.isSuccess(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`);
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
        expect(JSON.stringify(target)).not.toContain("hunter2");
        expect(result.refFlags).toEqual([]);
        expect(result.apiRequests).toEqual([]);
      }),
    );

    it.effect("resolves a branch name under the linked project and announces it", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "feature-x" }) },
          { savedRef: FILE_REF, branches: [branchRow("feature-x"), branchRow("other", FLAG_REF)] },
        );
        expect(succeeded(result.exit)).toEqual({
          kind: "linked",
          ref: BRANCH_REF,
          source: "flag",
          matchesLinkedRef: false,
        });
        expect(result.apiRequests).toEqual([`GET /v1/projects/${FILE_REF}/branches`]);
        expect(result.refFlags).toEqual([]);
        expect(result.stderr).toContain(`project ${FILE_REF} · branch feature-x (${BRANCH_REF})`);
      }),
    );

    it.effect("fails with the available branches when none has that name", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, ...remote({ _tag: "Branch", name: "feature-y" }) },
          { savedRef: FILE_REF, branches: [branchRow("feature-x")] },
        );
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "LinkBranchNotFoundError",
          message: expect.stringContaining("Available branches: feature-x"),
        });
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
    const args = ["db", "push", "--remote", "feature-x"];
    const bare = { ...none, ...remote({ _tag: "Linked" }) };

    it.effect("fails when the word is a branch of the linked project", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          savedRef: FILE_REF,
          branches: [branchRow("feature-x")],
        });
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `feature-x is a branch of project ${FILE_REF}. Did you mean --remote=feature-x?`,
        });
        expect(result.refFlags).toEqual([]);
      }),
    );

    it.effect("resolves the linked project when the word names no branch", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          savedRef: FILE_REF,
          branches: [branchRow("other")],
        });
        expect(succeeded(result.exit)).toMatchObject({ kind: "linked", ref: FILE_REF });
      }),
    );

    it.effect("fails when the branches cannot be listed to tell", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, {
          args,
          savedRef: FILE_REF,
          branches: "unavailable",
        });
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `Could not list the branches of project ${FILE_REF} to tell whether feature-x names one. Did you mean --remote=feature-x?`,
        });
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
          branches: [branchRow("feature-x")],
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
          cliArgs: cliArgsFor(raw),
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
          cliArgs: cliArgsFor(["db", "pull", "--remote", "feature-x"]),
          savedRef: FILE_REF,
          branches: [branchRow("feature-x")],
        });
        expect(failureOf(result.exit)).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `feature-x is a branch of project ${FILE_REF}. Did you mean --remote=feature-x?`,
        });
      }),
    );

    it.effect("does not look up branches when no project is linked", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", bare, { args, branches: [branchRow("feature-x")] });
        expect(succeeded(result.exit)).toMatchObject({ kind: "linked" });
        expect(result.apiRequests).toEqual([]);
      }),
    );
  });

  describe("deprecated selectors", () => {
    it.effect("warns that --linked is replaced by --remote, with the command as run", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, linked: true },
          { args: ["db", "push", "--dry-run", "--linked"] },
        );
        expect(succeeded(result.exit)).toMatchObject({ kind: "linked", ref: FILE_REF });
        expect(result.warnings).toEqual([
          "--linked is deprecated and will be removed in v4. Use --remote instead: supabase db push --dry-run --remote",
        ]);
      }),
    );

    it.effect.each(["text", "json", "stream-json"] satisfies Array<OutputFormat>)(
      "writes the warning to stderr and nothing to stdout in %s mode",
      (format) =>
        Effect.gen(function* () {
          const result = yield* run(
            "selectable",
            { ...none, linked: true },
            { args: ["db", "push", "--linked"], format },
          );
          expect(succeeded(result.exit)).toMatchObject({ kind: "linked" });
          expect(result.warnings).toEqual([
            "--linked is deprecated and will be removed in v4. Use --remote instead: supabase db push --remote",
          ]);
          expect(result.outputWarnCalls).toEqual([]);
          expect(result.stdout).toBe("");
        }),
    );

    it.effect("folds --linked and --project-ref into one warning that ends in --remote=<ref>", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, linked: true, projectRef: Option.some(FLAG_REF) },
          { args: ["db", "push", "--linked", "--project-ref", FLAG_REF, "--dry-run"] },
        );
        expect(succeeded(result.exit)).toMatchObject({ kind: "linked", ref: FLAG_REF });
        expect(result.warnings).toEqual([
          `--linked and --project-ref are deprecated and will be removed in v4. Use --remote instead: supabase db push --dry-run --remote=${FLAG_REF}`,
        ]);
      }),
    );

    it.effect("never echoes the --db-url connection string or --password", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, dbUrl: Option.some(SECRET_URL) },
          { args: ["db", "push", "--db-url", SECRET_URL, "--password", "hunter2"] },
        );
        expect(succeeded(result.exit)).toMatchObject({ kind: "db-url" });
        expect(result.warnings).toEqual([
          "--db-url is deprecated and will be removed in v4. Use --remote instead: supabase db push --password <redacted> --remote=<db-url>, or --remote=abcdefghijklmnopqrst with an access token set",
        ]);
        expect(result.warnings.join("\n")).not.toContain("hunter2");
      }),
    );

    it.effect("says --local is not needed", () =>
      Effect.gen(function* () {
        const result = yield* run(
          "selectable",
          { ...none, local: true },
          { args: ["db", "push", "--local"] },
        );
        expect(succeeded(result.exit)).toEqual({ kind: "local" });
        expect(result.warnings).toEqual([
          "--local isn't needed (local is the default) and will be removed in v4: supabase db push",
        ]);
        expect(result.refFlags).toEqual([]);
      }),
    );

    it.effect("warns without a command line when the real argv is unknown", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", { ...none, linked: true });
        expect(result.warnings).toEqual([
          "--linked is deprecated and will be removed in v4. Use --remote instead",
        ]);
      }),
    );

    it.effect("treats --project-ref as --remote=<ref> and keeps the flag source", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", { ...none, projectRef: Option.some(FLAG_REF) });
        expect(succeeded(result.exit)).toEqual({
          kind: "linked",
          ref: FLAG_REF,
          source: "flag",
          matchesLinkedRef: false,
        });
        expect(result.refFlags).toEqual([Option.some(FLAG_REF)]);
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

    it.effect("adds no hint when the checkout is not linked", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", none, { cache: { ref: FILE_REF, name: "alpha" } });
        expect(result.stderr).toBe("Target: local stack (127.0.0.1:54322)\n");
      }),
    );

    it.effect("adds no hint when --local chose local", () =>
      Effect.gen(function* () {
        const result = yield* run("selectable", { ...none, local: true }, { savedRef: FILE_REF });
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
