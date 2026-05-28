import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { legacyProjectsCreate } from "./create.handler.ts";
import type { LegacyProjectsCreateFlags } from "./create.command.ts";

function setupLegacyProjectsCreate() {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(LegacyGoProxy, {
    exec: (args) =>
      Effect.sync(() => {
        calls.push([...args]);
      }),
  });

  return { layer, calls };
}

const baseFlags: LegacyProjectsCreateFlags = {
  name: Option.some("my-project"),
  orgId: Option.some("cool-green-pqdr0qc"),
  dbPassword: Option.some("redacted"),
  region: Option.some("us-east-1"),
  size: Option.none(),
  highAvailability: Option.none(),
  interactive: Option.none(),
  plan: Option.none(),
};

describe("legacy projects create", () => {
  it.live("forwards the high availability flag to the Go CLI", () => {
    const { layer, calls } = setupLegacyProjectsCreate();
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({
        ...baseFlags,
        highAvailability: Option.some(true),
      });
      expect(calls).toEqual([
        [
          "projects",
          "create",
          "my-project",
          "--org-id",
          "cool-green-pqdr0qc",
          "--db-password",
          "redacted",
          "--region",
          "us-east-1",
          "--high-availability=true",
        ],
      ]);
    }).pipe(Effect.provide(layer));
  });
});
