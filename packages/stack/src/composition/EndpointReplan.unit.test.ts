import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { SavedStack } from "../State.ts";
import type { ServiceCreation } from "../services/Catalog.ts";
import { prepareEndpointReplan, reportedEndpointChanges } from "./EndpointReplan.ts";

const fixedPort = 54_321;

/** REST and Auth share the "api" claim key at a fixed port, same shape the owner registers from. */
const savedStack = (): SavedStack => ({
  id: "stack-1",
  lifetime: "detached",
  identity: { projectRoot: "/project", branchContext: "main", stackName: "stack-1" },
  runtime: "native",
  instances: [
    {
      id: "rest-1",
      creation: { service: "rest", config: {}, endpoints: { http: { port: fixedPort } } },
    },
    {
      id: "auth-1",
      creation: { service: "auth", config: {}, endpoints: { http: { port: fixedPort } } },
    },
  ],
  composition: {
    members: [
      { id: "rest-1", activation: "eager" },
      { id: "auth-1", activation: "eager" },
    ],
    dependencies: [],
  },
  ports: [{ key: "api", host: "127.0.0.1", port: fixedPort }],
});

it.effect(
  "drops the changed endpoint's old claim and updates the saved intents, without claiming a port",
  () =>
    Effect.gen(function* () {
      const saved = savedStack();
      const requested: ReadonlyArray<ServiceCreation> = [
        { service: "rest", config: {}, endpoints: { http: { port: "auto" } } },
        { service: "auth", config: {}, endpoints: { http: { port: "auto" } } },
      ];
      const preparation = yield* prepareEndpointReplan(saved, requested);
      if (preparation === undefined) return yield* Effect.die("Expected a replan");

      // REST and Auth share the "api" claim key, so one change covers both; claiming it once
      // (rest-1) is enough, since the later composition-wide bind is idempotent per key.
      expect(preparation.changedInstanceIds).toEqual(["rest-1"]);
      expect(preparation.changedKeys).toEqual([
        { key: "api", service: "rest", endpoint: "http", previousPort: fixedPort },
      ]);

      // The old "api" claim is dropped so the owner's normal binding claims it fresh.
      expect(preparation.saved.ports).toEqual([]);
      const rest = preparation.saved.instances.find((instance) => instance.id === "rest-1");
      const auth = preparation.saved.instances.find((instance) => instance.id === "auth-1");
      expect(rest?.creation.endpoints).toEqual({ http: { port: "auto" } });
      expect(auth?.creation.endpoints).toEqual({ http: { port: "auto" } });

      // Unrelated saved state is left untouched.
      expect(preparation.saved.id).toBe(saved.id);
      expect(preparation.saved.composition).toEqual(saved.composition);
    }),
);

it.effect("returns undefined when the requested endpoints match the saved ports", () =>
  Effect.gen(function* () {
    const saved = savedStack();
    const requested: ReadonlyArray<ServiceCreation> = [
      { service: "rest", config: {}, endpoints: { http: { port: fixedPort } } },
      { service: "auth", config: {}, endpoints: { http: { port: fixedPort } } },
    ];
    const preparation = yield* prepareEndpointReplan(saved, requested);
    expect(preparation).toBeUndefined();
  }),
);

it.effect("returns undefined when the incompatibility is not a pure endpoint reassignment", () =>
  Effect.gen(function* () {
    const saved = savedStack();
    // An artifact version bump alongside the port change is not a pure endpoint reassignment.
    const requested: ReadonlyArray<ServiceCreation> = [
      { service: "rest", version: "2", config: {}, endpoints: { http: { port: "auto" } } },
      { service: "auth", config: {}, endpoints: { http: { port: fixedPort } } },
    ];
    const preparation = yield* prepareEndpointReplan(saved, requested);
    expect(preparation).toBeUndefined();
  }),
);

it("leaves out a changed key whose automatic re-plan resolved back to its previous port", () => {
  const changedKeys = [{ key: "api", service: "rest", endpoint: "http", previousPort: fixedPort }];
  const after: SavedStack = {
    ...savedStack(),
    ports: [{ key: "api", host: "127.0.0.1", port: fixedPort }],
  };
  expect(reportedEndpointChanges(changedKeys, after)).toEqual([]);
});

it("reports a changed key whose claimed port differs from its previous one", () => {
  const changedKeys = [{ key: "api", service: "rest", endpoint: "http", previousPort: fixedPort }];
  const after: SavedStack = {
    ...savedStack(),
    ports: [{ key: "api", host: "127.0.0.1", port: fixedPort + 1 }],
  };
  expect(reportedEndpointChanges(changedKeys, after)).toEqual([
    { service: "rest", endpoint: "http", from: fixedPort, to: fixedPort + 1 },
  ]);
});
