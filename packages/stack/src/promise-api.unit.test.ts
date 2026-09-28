import type { Effect } from "effect";
import { describe, expectTypeOf, it } from "vitest";
import type { InitializationCommand } from "./Commands.ts";
import type * as StackEffect from "./effect.ts";
import type * as PromiseApi from "./index.ts";
import { createTestStack, makeTestStack } from "./testing.ts";

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
    expectTypeOf<keyof PromiseApi.Stack["commands"]>().toEqualTypeOf<
      keyof StackEffect.Stack["commands"]
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
    expectTypeOf<PromiseApi.Stack["commands"]["run"]>()
      .parameter(2)
      .toEqualTypeOf<CallOptions | undefined>();
  });

  it("runs initialization commands with optional output sinks", () => {
    const initialize = (stack: PromiseApi.Stack, command: InitializationCommand) =>
      stack.commands.run(command);
    expectTypeOf<ReturnType<typeof initialize>>().resolves.toEqualTypeOf<{
      readonly jobId: string;
      readonly exitCode: number;
    }>();
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

  it("types test stack services from a list without a static length as optional", () => {
    const services: ReadonlyArray<"database" | "rest"> = ["database"];
    const selectPromise = () => createTestStack({ services }).then((test) => test.services);
    expectTypeOf<Awaited<ReturnType<typeof selectPromise>>>().toEqualTypeOf<{
      readonly database?: PromiseApi.DatabaseInstance;
      readonly rest?: PromiseApi.ServiceInstances["rest"];
    }>();
    expectTypeOf<
      Effect.Success<ReturnType<typeof makeTestStack<typeof services>>>["services"]
    >().toEqualTypeOf<{
      readonly database?: StackEffect.DatabaseInstance;
      readonly rest?: StackEffect.ServiceInstances["rest"];
    }>();
  });
});
