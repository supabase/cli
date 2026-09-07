import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { CAPABILITY_NAMES } from "./Capability.ts";
import { StackStatusSchema } from "./Status.ts";

const STATUS_FIXTURE = {
  id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  lifecycle: "stopped",
  desiredLifecycle: "stopped",
  runtime: { kind: "native" },
  endpoints: {
    api: {
      protocol: "http",
      address: "127.0.0.1",
      port: 54321,
      url: "http://127.0.0.1:54321",
    },
  },
  versions: {
    database: "17",
  },
  capabilities: CAPABILITY_NAMES.map((name) => ({
    name,
    activation: "lazy",
    state: name === "rest" ? "dormant" : "disabled",
  })),
  artifacts: [
    {
      workloadId: "rest:rest",
      capability: "rest",
      state: "downloading",
    },
  ],
};

describe("public stack model", () => {
  it.effect("decodes a complete status snapshot", () =>
    Schema.decodeUnknownEffect(StackStatusSchema)(STATUS_FIXTURE).pipe(
      Effect.map((status) => {
        expect(status.capabilities).toHaveLength(10);
        expect(new Set(status.capabilities.map(({ name }) => name)).size).toBe(10);
        expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("dormant");
        expect(status.artifacts).toEqual([
          { workloadId: "rest:rest", capability: "rest", state: "downloading" },
        ]);
      }),
    ),
  );

  it.effect("rejects status snapshots with missing capability entries", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(StackStatusSchema)({
        ...STATUS_FIXTURE,
        capabilities: STATUS_FIXTURE.capabilities.slice(1),
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects status snapshots with duplicate capability entries", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(StackStatusSchema)({
        ...STATUS_FIXTURE,
        capabilities: STATUS_FIXTURE.capabilities.map((capability, index) =>
          index === STATUS_FIXTURE.capabilities.length - 1
            ? { ...capability, name: "database" }
            : capability,
        ),
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
