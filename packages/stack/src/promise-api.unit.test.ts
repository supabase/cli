import { describe, expectTypeOf, it } from "vitest";
import type * as StackEffect from "./effect.ts";
import type * as PromiseApi from "./index.ts";
import { createTestStack } from "./testing.ts";

type Kind = StackEffect.ServiceCreationInput["service"];
type CallOptions = PromiseApi.CallOptions;

describe("Promise API derived from the Effect API", () => {
  it("exposes every Effect stack operation, plus close", () => {
    expectTypeOf<keyof PromiseApi.Stack>().toEqualTypeOf<keyof StackEffect.Stack | "close">();
    expectTypeOf<keyof PromiseApi.Stack["services"]>().toEqualTypeOf<
      keyof StackEffect.Stack["services"]
    >();
    expectTypeOf<keyof PromiseApi.Stack["composition"]>().toEqualTypeOf<
      keyof StackEffect.Stack["composition"]
    >();
    expectTypeOf<keyof PromiseApi.Stack["tools"]>().toEqualTypeOf<
      keyof StackEffect.Stack["tools"]
    >();
  });

  it("exposes every Effect service operation for each service kind", () => {
    expectTypeOf<{ [K in Kind]: keyof PromiseApi.ServiceInstances[K] }>().toEqualTypeOf<{
      [K in Kind]: keyof StackEffect.ServiceInstances[K];
    }>();
  });

  it("turns Effects into cancellable Promise calls", () => {
    expectTypeOf<PromiseApi.Stack["composition"]["describe"]>().toEqualTypeOf<
      (options?: CallOptions) => Promise<PromiseApi.CompositionConfig>
    >();
    expectTypeOf<PromiseApi.DatabaseInstance["resetData"]>().toEqualTypeOf<
      (options?: CallOptions) => Promise<void>
    >();
  });

  it("gives Effect-returning functions trailing call options", () => {
    expectTypeOf<PromiseApi.DatabaseInstance["restoreSnapshot"]>().toEqualTypeOf<
      (
        key: string,
        options?: PromiseApi.DatabaseSnapshotOptions,
        callOptions?: CallOptions,
      ) => Promise<boolean>
    >();
    expectTypeOf<PromiseApi.Stack["composition"]["plan"]>().returns.resolves.toEqualTypeOf<
      ReadonlyArray<PromiseApi.PlannedInstance>
    >();
    expectTypeOf<PromiseApi.Stack["tools"]["run"]>()
      .parameter(2)
      .toEqualTypeOf<CallOptions | undefined>();
  });

  it("accepts plain secrets wherever the Effect API takes Redacted configuration", () => {
    expectTypeOf<{
      service: "database";
      config: { version: "17"; jwtExpiry: 3600; databasePassword: string; jwtSecret: string };
      endpoints: {};
    }>().toExtend<PromiseApi.ServiceCreationInput>();
    expectTypeOf<{
      config: { version: string; jwtExpiry: number; databasePassword: string };
    }>().toExtend<Parameters<PromiseApi.DatabaseInstance["restart"]>[0]>();
  });

  it("turns Streams into async iterables", () => {
    expectTypeOf<PromiseApi.DatabaseInstance["followStatus"]>().toEqualTypeOf<
      () => AsyncIterable<PromiseApi.Observation>
    >();
  });

  it("types created and returned handles by service kind", () => {
    const createDatabase = (stack: PromiseApi.Stack) =>
      stack.services.create({
        service: "database",
        config: { version: "17", jwtExpiry: 3600 },
        endpoints: {},
      });
    const createRest = (stack: PromiseApi.Stack) =>
      stack.services.create({ service: "rest", config: {}, endpoints: {} });
    type Rest = Awaited<ReturnType<typeof createRest>>;
    expectTypeOf<
      Awaited<ReturnType<typeof createDatabase>>
    >().toEqualTypeOf<PromiseApi.DatabaseInstance>();
    expectTypeOf<"saveSnapshot" extends keyof Rest ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<Rest["restart"]>().returns.resolves.toEqualTypeOf<void>();
    expectTypeOf<
      Awaited<ReturnType<PromiseApi.Stack["services"]["list"]>>[number]["start"]
    >().toEqualTypeOf<(options?: CallOptions) => Promise<void>>();
  });

  it("types test stack services by the selected kinds", () => {
    const selectDefault = () => createTestStack().then((test) => test.services);
    const selectMany = () =>
      createTestStack({ services: ["database", { service: "rest", config: {} }] }).then(
        (test) => test.services,
      );
    expectTypeOf<keyof Awaited<ReturnType<typeof selectDefault>>>().toEqualTypeOf<"database">();
    expectTypeOf<Awaited<ReturnType<typeof selectMany>>>().toEqualTypeOf<{
      readonly database: PromiseApi.DatabaseInstance;
      readonly rest: PromiseApi.ServiceInstances["rest"];
    }>();
  });
});
