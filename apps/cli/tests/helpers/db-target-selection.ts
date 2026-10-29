import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Predicate, type Scope } from "effect";
import { CliOutput, Command } from "effect/cli";

import { legacyProjectStateLayer } from "../../src/shared/config/legacy-project-state.layer.ts";
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
import { assertPermissionDrift } from "./permission-drift.ts";
import type { ActiveFlags } from "./permission-registry.ts";
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
const branchListUrl = (ref: string) => `https://api.supabase.com/v1/projects/${ref}/branches`;
const BRANCH_LOOKUP = `GET ${branchListUrl(VALID_REF)}`;

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

/** A bare `--remote`: the linked project. */
export const BARE_REMOTE: TargetFlagValuesWithDbUrl = selecting({ _tag: "Linked" });

/** `--remote=<ref>`. */
export const remoteTarget = (ref: string): TargetFlagValuesWithDbUrl =>
  selecting({ _tag: "Ref", ref });

type ObservedTarget =
  | { readonly kind: "local" }
  | { readonly kind: "linked"; readonly ref: string }
  | { readonly kind: "db-url" };

interface RecordedLookup {
  readonly method: string;
  readonly url: string;
  readonly urlParams?: string;
}

/** The `branchLookups` entries among the Management API method calls a fake recorded. */
export const branchLookupsOf = (
  calls: ReadonlyArray<{ readonly method: string; readonly input: unknown }>,
): ReadonlyArray<RecordedLookup> =>
  calls.flatMap(({ method, input }) =>
    method === "listAllBranches" &&
    Predicate.hasProperty(input, "ref") &&
    Predicate.isString(input.ref)
      ? [{ method: "GET", url: branchListUrl(input.ref) }]
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
  readonly run: Effect.Effect<unknown, unknown, R | Scope.Scope>;
  /** The target the leaf connected or sent requests to; `undefined` until it reached one. */
  readonly target: () => ObservedTarget | undefined;
  readonly cachedRef?: () => string | undefined;
  /** The branch-list requests the leaf sent, for a leaf that records them. */
  readonly branchLookups?: () => ReadonlyArray<RecordedLookup>;
  /** Every Management API request the leaf sent, for a leaf that records them. */
  readonly apiRequests?: () => ReadonlyArray<unknown>;
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
  /** Whether the command takes a database URL; storage and seed take a ref or a branch name. */
  readonly dbUrl: boolean;
  /** The directory the leaf's layers read; the linked rows link it to {@link VALID_REF}. */
  readonly workdir: () => string;
  /** Operands the parser needs before `--remote`, for a command that takes no database URL. */
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
  readonly around?: <E>(row: Effect.Effect<void, E>) => Effect.Effect<void, E>;
  /** The flags besides `--remote` that the run sets and the leaf's permission map branches on. */
  readonly activeFlags?: ActiveFlags;
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
      readonly check: (
        ctx: DbTargetAttempt<R>,
      ) => Effect.Effect<void, unknown, R | CommandTarget | Scope.Scope>;
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
              Effect.scoped,
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
            // The banner carries the hint only if the leaf's `resolveTarget` called `hintLocal`.
            yield* announceTarget(renderLocalTarget("127.0.0.1", 54322));
            expect(stripAnsi(ctx.out.stderrText)).toContain(
              `default; pass --remote for ${VALID_REF}`,
            );
          }),
      },
    );

    rowTest("bare-remote", "targets the linked project for a bare --remote, with no warning", {
      args: ["--remote"],
      target: BARE_REMOTE,
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
      linked: true,
      check: (ctx) =>
        Effect.gen(function* () {
          yield* ctx.run;
          expect(ctx.target()).toMatchObject({ kind: "linked", ref: BRANCH_PROJECT_REF });
          expect(warningsOf(ctx.out)).toEqual([]);
          expectCachedRef(ctx, BRANCH_PROJECT_REF);
          if (ctx.branchLookups !== undefined) {
            const lookups = ctx.branchLookups();
            expect(lookups.map(({ method, url }) => `${method} ${url}`)).toEqual([BRANCH_LOOKUP]);
            assertPermissionDrift({
              command: path,
              activeFlags: { ...scenario.activeFlags, remote: "feature-x" },
              requests: lookups,
            });
          }
        }),
    });

    rowTest(
      "unknown-branch",
      "fails with the branches that exist, before connecting, when --remote=<branch> names none",
      {
        args: ["--remote=feature-y"],
        target: selecting({ _tag: "Branch", name: "feature-y" }),
        linked: true,
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
              if (ctx.apiRequests !== undefined) expect(ctx.apiRequests()).toEqual([]);
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
                legacyProjectStateLayer.pipe(Layer.provide(BunServices.layer)),
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
      target: { ...BARE_REMOTE, local: true },
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
