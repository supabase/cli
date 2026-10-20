import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Predicate } from "effect";
import { CliOutput, Command } from "effect/cli";

import type { RemoteValue } from "../../src/command-internal/target/remote-value.ts";
import type { TargetFlagValuesWithDbUrl } from "../../src/command-internal/target/target-flags.ts";
import { renderLocalTarget } from "../../src/command-internal/target/target-identity.ts";
import { CliArgs } from "../../src/shared/cli/cli-args.service.ts";
import { commandTargetLayer } from "../../src/shared/output/command-target.layer.ts";
import type { CommandTarget } from "../../src/shared/output/command-target.service.ts";
import { announceTarget } from "../../src/shared/output/command-target.service.ts";
import { normalizeCause } from "../../src/shared/output/normalize-error.ts";
import { textCliOutputFormatter } from "../../src/shared/output/text-formatter.ts";
import { stripAnsi } from "./ansi.ts";
import { VALID_REF } from "./command-mocks.ts";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
} from "./mocks.ts";
import { BRANCH_PROJECT_REF, warningsOf } from "./remote-selection.ts";

const FLAG_REF = "flagflagflagflagflag";
const DB_URL = "postgresql://postgres:postgres@db.example.com:5432/postgres";
const branchListRequest = (ref: string) =>
  `GET https://api.supabase.com/v1/projects/${ref}/branches`;
const BRANCH_LOOKUP = branchListRequest(VALID_REF);

/** Every selector flag absent, so a command takes its default target. */
export const NO_TARGET: TargetFlagValuesWithDbUrl = {
  remote: Option.none(),
  local: false,
  linked: false,
  dbUrl: Option.none(),
  projectRef: Option.none(),
};

const selecting = (remote: RemoteValue): TargetFlagValuesWithDbUrl => ({
  ...NO_TARGET,
  remote: Option.some(remote),
});

/** `--remote=<ref>`. */
export const remoteTarget = (ref: string): TargetFlagValuesWithDbUrl =>
  selecting({ _tag: "Ref", ref });

type ObservedTarget =
  | { readonly kind: "local" }
  | { readonly kind: "linked"; readonly ref: string }
  | { readonly kind: "db-url" };

/** The branch lookups, as `branchLookups` reports them, among the Management API method calls a fake recorded. */
export const branchLookupsOf = (
  calls: ReadonlyArray<{ readonly method: string; readonly input: unknown }>,
): ReadonlyArray<string> =>
  calls.flatMap(({ method, input }) =>
    method === "listAllBranches" &&
    Predicate.hasProperty(input, "ref") &&
    Predicate.isString(input.ref)
      ? [branchListRequest(input.ref)]
      : [],
  );

/** The target a Storage leaf sent its first request to; `undefined` before it sent one. */
export const storageTargetOf = (
  requests: ReadonlyArray<{ readonly url: string }>,
): ObservedTarget | undefined => {
  const first = requests[0];
  if (first === undefined) return undefined;
  const ref = /^https:\/\/([a-z]{20})\.supabase\.co/.exec(first.url)?.[1];
  return ref === undefined ? { kind: "local" } : { kind: "linked", ref };
};

interface DbTargetAttempt<R> {
  readonly layer: Layer.Layer<R, unknown>;
  readonly out: ReturnType<typeof mockOutput>;
  readonly run: Effect.Effect<unknown, unknown, R>;
  /** The target the leaf opened its connection or requests for; `undefined` until it reached one. */
  readonly target: () => ObservedTarget | undefined;
  readonly cachedRef?: () => string | undefined;
  /** The `METHOD url` of each branch-list request, for a leaf that records them. */
  readonly branchLookups?: () => ReadonlyArray<string>;
}

type Row =
  | "default"
  | "linked-hint"
  | "bare-remote"
  | "remote-ref"
  | "remote-branch"
  | "unknown-branch"
  | "remote-db-url"
  | "deprecated-alias"
  | "remote-with-local";

interface DbTargetSelectionScenario<R> {
  /** Whether the command takes a database URL; storage and seed take a project ref or a branch name. */
  readonly dbUrl: boolean;
  /** The directory the leaf's layers read, which the linked-checkout row links to {@link VALID_REF}. */
  readonly workdir: () => string;
  /** Positional arguments the parser needs before it reaches `--remote`, for a command that takes no database URL. */
  readonly operands?: ReadonlyArray<string>;
  /**
   * One run of the leaf: its layers, its handler called with `target`, and what it observed. The
   * linked project the fakes answer for is {@link VALID_REF}, whose only branch is `feature-x`.
   */
  readonly attempt: (input: {
    readonly workdir: string;
    readonly args: ReadonlyArray<string>;
    readonly target: TargetFlagValuesWithDbUrl;
  }) => DbTargetAttempt<R> | Effect.Effect<DbTargetAttempt<R>, unknown, BunServices.BunServices>;
  /** Wraps each row, for a leaf whose tests pin ambient environment variables around their body. */
  readonly around?: (row: Effect.Effect<void, unknown>) => Effect.Effect<void, unknown>;
  /** Rows the leaf cannot express, each with why. */
  readonly optOut?: Partial<Record<Row, string>>;
}

const linkCheckout = (workdir: string) => {
  const temp = join(workdir, "supabase", ".temp");
  mkdirSync(temp, { recursive: true });
  writeFileSync(join(temp, "project-ref"), VALID_REF);
};

const expectCachedRef = <R>(ctx: DbTargetAttempt<R>, ref: string | undefined) => {
  if (ctx.cachedRef !== undefined) expect(ctx.cachedRef()).toBe(ref);
};

/**
 * Registers one wiring row per `--remote` selector kind for a selectable leaf: the local default,
 * its linked-checkout hint, a bare `--remote`, a ref, a branch name that exists and one that does
 * not, a database URL, the deprecated `--linked`, and `--remote` with `--local`. The selector rules
 * themselves are proven by the `command-internal/target` tests.
 */
export function describeDbTargetSelection<R>(
  path: string,
  scenario: DbTargetSelectionScenario<R>,
): void {
  const words = path.split(" ");
  const subject = scenario.dbUrl ? "database" : "Storage API";
  const optedOut = (row: Row) => scenario.optOut?.[row] !== undefined;

  const rowTest = (
    row: Row,
    name: string,
    spec: {
      readonly args: ReadonlyArray<string>;
      readonly target: TargetFlagValuesWithDbUrl;
      readonly linked?: true;
      readonly check: (ctx: DbTargetAttempt<R>) => Effect.Effect<void, unknown, R | CommandTarget>;
    },
  ) => {
    if (optedOut(row)) return;
    it.effect(name, () => {
      const workdir = scenario.workdir();
      if (spec.linked === true) linkCheckout(workdir);
      const attempted = scenario.attempt({
        workdir,
        args: [...words, ...spec.args],
        target: spec.target,
      });
      const row = Effect.flatMap(
        Effect.isEffect(attempted)
          ? Effect.provide(attempted, BunServices.layer)
          : Effect.succeed(attempted),
        (ctx) =>
          spec
            .check(ctx)
            .pipe(
              Effect.provide(
                Layer.mergeAll(ctx.layer, commandTargetLayer.pipe(Layer.provide(ctx.out.layer))),
              ),
            ),
      );
      return scenario.around === undefined ? row : scenario.around(row);
    });
  };

  describe(`target selection: ${path}`, () => {
    rowTest("default", `targets the local ${subject}, with no warning, when no selector is given`, {
      args: [],
      target: NO_TARGET,
      check: (ctx) =>
        Effect.gen(function* () {
          yield* ctx.run;
          expect(ctx.target()).toEqual({ kind: "local" });
          expect(warningsOf(ctx.out)).toEqual([]);
          expectCachedRef(ctx, undefined);
        }),
    });

    rowTest(
      "linked-hint",
      "points the default-local banner at --remote when the checkout is linked",
      {
        args: [],
        target: NO_TARGET,
        linked: true,
        check: (ctx) =>
          Effect.gen(function* () {
            yield* ctx.run;
            yield* announceTarget(renderLocalTarget("127.0.0.1", 54322));
            expect(stripAnsi(ctx.out.stderrText)).toContain(
              `default; pass --remote for ${VALID_REF}`,
            );
          }),
      },
    );

    rowTest("bare-remote", "targets the linked project for a bare --remote, with no warning", {
      args: ["--remote"],
      target: selecting({ _tag: "Linked" }),
      check: (ctx) =>
        Effect.gen(function* () {
          yield* ctx.run;
          expect(ctx.target()).toMatchObject({ kind: "linked", ref: VALID_REF });
          expect(warningsOf(ctx.out)).toEqual([]);
          expectCachedRef(ctx, VALID_REF);
        }),
    });

    rowTest("remote-ref", "targets the project --remote=<ref> names, with no warning", {
      args: [`--remote=${FLAG_REF}`],
      target: remoteTarget(FLAG_REF),
      check: (ctx) =>
        Effect.gen(function* () {
          yield* ctx.run;
          expect(ctx.target()).toMatchObject({ kind: "linked", ref: FLAG_REF });
          expect(warningsOf(ctx.out)).toEqual([]);
          expectCachedRef(ctx, FLAG_REF);
        }),
    });

    rowTest("remote-branch", "targets the project of the branch --remote=<branch> names", {
      args: ["--remote=feature-x"],
      target: selecting({ _tag: "Branch", name: "feature-x" }),
      check: (ctx) =>
        Effect.gen(function* () {
          yield* ctx.run;
          expect(ctx.target()).toMatchObject({ kind: "linked", ref: BRANCH_PROJECT_REF });
          expect(warningsOf(ctx.out)).toEqual([]);
          expectCachedRef(ctx, BRANCH_PROJECT_REF);
          if (ctx.branchLookups !== undefined) expect(ctx.branchLookups()).toEqual([BRANCH_LOOKUP]);
        }),
    });

    rowTest(
      "unknown-branch",
      "fails with the branches that exist, before connecting, when --remote=<branch> names none",
      {
        args: ["--remote=feature-y"],
        target: selecting({ _tag: "Branch", name: "feature-y" }),
        check: (ctx) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(ctx.run);
            expect(error).toMatchObject({
              _tag: "LinkBranchNotFoundError",
              message: expect.stringContaining("Available branches: feature-x"),
            });
            expect(ctx.target()).toBeUndefined();
            expectCachedRef(ctx, undefined);
          }),
      },
    );

    if (scenario.dbUrl) {
      rowTest(
        "remote-db-url",
        "targets the database --remote=<postgres url> names, never touching the linked project",
        {
          args: [`--remote=${DB_URL}`],
          target: selecting({ _tag: "DbUrl", url: DB_URL }),
          check: (ctx) =>
            Effect.gen(function* () {
              yield* ctx.run;
              expect(ctx.target()).toMatchObject({ kind: "db-url" });
              expect(warningsOf(ctx.out)).toEqual([]);
              expectCachedRef(ctx, undefined);
            }),
        },
      );
    } else if (!optedOut("remote-db-url")) {
      const args = [...words, ...(scenario.operands ?? []), `--remote=${DB_URL}`];
      it.effect(
        "rejects --remote=<postgres url> while parsing, since there is no database to connect to",
        () =>
          Effect.gen(function* () {
            const { rootCommandForFeatures } = yield* Effect.promise(
              () => import("../../src/cli/root.ts"),
            );
            const exit = yield* Effect.exit(
              Command.runWith(rootCommandForFeatures(), { version: "0.0.0-test" })(args),
            );
            expect(
              Exit.match(exit, {
                onFailure: (cause) => normalizeCause(cause).message,
                onSuccess: () => "parsed",
              }),
            ).toBe("--remote takes a project ref or a branch name.");
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                BunServices.layer,
                CliOutput.layer(textCliOutputFormatter()),
                Layer.succeed(CliArgs, { args }),
                mockOutput({ format: "text" }).layer,
                mockRuntimeInfo(),
                mockAnalytics().layer,
                mockTelemetryRuntime(),
                mockTty(),
                mockProcessControl().layer,
              ),
            ),
          ),
      );
    }

    rowTest(
      "deprecated-alias",
      "keeps --linked targeting the linked project and warns that it is deprecated",
      {
        args: ["--linked"],
        target: { ...NO_TARGET, linked: true },
        check: (ctx) =>
          Effect.gen(function* () {
            yield* ctx.run;
            expect(ctx.target()).toMatchObject({ kind: "linked", ref: VALID_REF });
            expect(warningsOf(ctx.out)).toEqual([
              expect.stringContaining("--linked is deprecated"),
            ]);
            expectCachedRef(ctx, VALID_REF);
          }),
      },
    );

    rowTest("remote-with-local", "rejects --remote combined with --local before anything runs", {
      args: ["--remote", "--local"],
      target: { ...selecting({ _tag: "Linked" }), local: true },
      check: (ctx) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(ctx.run);
          expect(error).toMatchObject({ _tag: "TargetSelectorConflictError" });
          expect(ctx.target()).toBeUndefined();
          expectCachedRef(ctx, undefined);
        }),
    });
  });
}
