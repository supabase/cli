import type { ApiClient, openApiOperationIdMap } from "@supabase/api/effect";
import { Context, Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { expectTypeOf } from "vitest";

// Feasibility probe for compile-time operation checks. The types here stand in for what SDK
// generation would emit; see docs/superpowers/plans/2026-11-06-command-contract-phase-2.md.

type OperationIdMap = typeof openApiOperationIdMap;
type SpecOperationId = keyof OperationIdMap;
type SpecIdByMethodId = { readonly [K in SpecOperationId as OperationIdMap[K]]: K };
type SpecIdFor<
  Group extends string,
  Method extends string,
> = SpecIdByMethodId[`${Group}${Capitalize<Method>}` & keyof SpecIdByMethodId];

type ApiOperation<Id extends string> = `supabase/api/operation/${Id}`;

// One runtime slot; each call site types it as its own operation, so providing it once with the
// declared union removes exactly those requirements.
const operationKey = <Id extends string>() =>
  Context.Service<ApiOperation<Id>, true>("supabase/api/operations");

type CheckedGroup<Group extends string, Ops> = {
  readonly [M in keyof Ops & string]: Ops[M] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, infer E>
    ? (...args: Args) => Effect.Effect<A, E, ApiOperation<SpecIdFor<Group, M>>>
    : never;
};

type CheckedApiClient = {
  readonly [G in Exclude<Extract<keyof ApiClient, string>, "executeRaw">]: CheckedGroup<
    G,
    ApiClient[G]
  >;
};

type ClientGroup = keyof CheckedApiClient;

type UnmappedMethods = {
  [G in ClientGroup]: {
    [M in Extract<keyof CheckedApiClient[G], string>]: [SpecIdFor<G, M>] extends [never]
      ? `${G}.${M}`
      : never;
  }[Extract<keyof CheckedApiClient[G], string>];
}[ClientGroup];

type UndeclaredOperations<R, Declared extends string> = Exclude<
  Extract<R, ApiOperation<string>>,
  ApiOperation<Declared>
>;

/** Resolves to `unknown` when every operation `R` requires is declared. */
type OperationCheck<R, Declared extends string> = [UndeclaredOperations<R, Declared>] extends [
  never,
]
  ? unknown
  : { readonly undeclaredOperations: UndeclaredOperations<R, Declared> };

const checkOperations =
  <const Ids extends ReadonlyArray<SpecOperationId>>(..._declared: Ids) =>
  <A, E, R>(
    self: Effect.Effect<A, E, R> & OperationCheck<R, Ids[number]>,
  ): Effect.Effect<A, E, Exclude<R, ApiOperation<Ids[number]>>> =>
    self.pipe(Effect.provideService(operationKey<Ids[number]>(), true));

/** Stands in for a generated method: it requires its operation before calling the client. */
const checked =
  <Id extends SpecOperationId, Args extends ReadonlyArray<unknown>, A, E>(
    _operationId: Id,
    method: (...args: Args) => Effect.Effect<A, E>,
  ) =>
  (...args: Args): Effect.Effect<A, E, ApiOperation<Id>> =>
    Effect.gen(function* () {
      yield* operationKey<Id>();
      return yield* method(...args);
    });

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";

const v1: Pick<CheckedApiClient["v1"], "deleteABranch" | "listAllOrganizations"> = {
  deleteABranch: checked("v1-delete-a-branch", () => Effect.succeed({ message: "ok" })),
  listAllOrganizations: checked("v1-list-all-organizations", () => Effect.succeed([])),
};

const deleteAndListOrganizations = Effect.gen(function* () {
  yield* v1.deleteABranch({ branch_id_or_ref: BRANCH_ID });
  return yield* v1.listAllOrganizations();
});

describe("compile-time Management API operations", () => {
  it("maps every generated client method to a spec operation id", () => {
    expectTypeOf<UnmappedMethods>().toBeNever();
    expectTypeOf<ReturnType<CheckedApiClient["v1"]["deleteABranch"]>>().toEqualTypeOf<
      Effect.Effect<
        Effect.Success<ReturnType<ApiClient["v1"]["deleteABranch"]>>,
        Effect.Error<ReturnType<ApiClient["v1"]["deleteABranch"]>>,
        ApiOperation<"v1-delete-a-branch">
      >
    >();
  });

  it("rejects a method implementation typed as a different operation", () => {
    const wrongOperation: Pick<CheckedApiClient["v1"], "deleteABranch"> = {
      /* oxlint-disable effecttsgo/missing-effect-context -- the mismatch is the assertion */
      // @ts-expect-error -- the slot requires v1-delete-a-branch, not v1-get-a-branch
      deleteABranch: checked("v1-get-a-branch", () => Effect.succeed({ message: "ok" })),
      /* oxlint-enable effecttsgo/missing-effect-context */
    };
    expect(wrongOperation.deleteABranch).toBeTypeOf("function");
  });

  it.effect("runs a program whose operations are all declared", () =>
    Effect.gen(function* () {
      const organizations = yield* checkOperations(
        "v1-delete-a-branch",
        "v1-list-all-organizations",
      )(deleteAndListOrganizations);

      expect(organizations).toEqual([]);
    }),
  );

  it("rejects a program that calls an undeclared operation", () => {
    // @ts-expect-error -- v1-list-all-organizations is called but not declared
    const program = checkOperations("v1-delete-a-branch")(deleteAndListOrganizations);
    expectTypeOf(program).not.toBeNever();
  });

  it("rejects a declared id that isn't a spec operation", () => {
    // @ts-expect-error -- not an operation id in the spec
    expect(checkOperations("v1-delete-a-brnach")).toBeTypeOf("function");
  });
});
