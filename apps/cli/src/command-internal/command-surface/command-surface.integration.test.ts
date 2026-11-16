import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { commandSurface, commandSurfaceEntry, walkCommandSurface } from "./command-surface.ts";
import { rootCommandForFeatures } from "../../cli/root.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const surface = Effect.runPromise(commandSurface());

const titlesOf = (result: unknown): ReadonlyArray<unknown> =>
  typeof result === "object" && result !== null && "oneOf" in result && Array.isArray(result.oneOf)
    ? result.oneOf.map((branch) =>
        typeof branch === "object" && branch !== null && "title" in branch ? branch.title : null,
      )
    : [];

/** Source files a bundle of `entrypoint` pulls in, following relative imports only. */
const bundledInputs = (entrypoint: string) =>
  Effect.promise(() =>
    Bun.build({
      entrypoints: [entrypoint],
      target: "bun",
      packages: "external",
      metafile: true,
    }),
  ).pipe(
    Effect.map((built) => {
      expect(built.success).toBe(true);
      return Object.keys(built.metafile?.inputs ?? {});
    }),
  );

describe("command surface", () => {
  it.effect("keeps warehouse commands out of the default surface", () =>
    Effect.gen(function* () {
      const { commands } = yield* Effect.promise(() => surface);
      expect(Object.keys(commands).filter((path) => path.startsWith("warehouse"))).toEqual([]);
      expect(Object.keys(commands)).toContain("projects list");
    }),
  );

  it.effect("lists exactly the warehouse entries the feature adds", () =>
    Effect.gen(function* () {
      const { variants } = yield* Effect.promise(() => surface);
      expect(Object.keys(variants.warehouse)).toEqual([
        "warehouse",
        "warehouse enable",
        "warehouse status",
      ]);
    }),
  );

  it.effect("extracts one command from any mounted root, keyed like the full walk", () =>
    Effect.gen(function* () {
      const root = rootCommandForFeatures({ warehouseEnabled: true });
      const walked = yield* walkCommandSurface(root);
      const single = yield* commandSurfaceEntry(root, ["warehouse", "status"]);
      expect(walked["warehouse status"]).toStrictEqual(single);
      expect(Object.keys(walked)).toEqual(Object.keys(walked).toSorted());
    }),
  );

  it.effect("describes a generated command from its annotations and operation schemas", () =>
    Effect.gen(function* () {
      const { variants } = yield* Effect.promise(() => surface);
      const enable = variants.warehouse["warehouse enable"];
      expect(enable).toMatchObject({
        path: ["warehouse", "enable"],
        target: { group: "hosted", consent: "no" },
        errors: "standard",
        stage: { status: "experimental", gate: { kind: "feature", feature: "warehouse" } },
        api: { operationId: "v2-enable-warehouse", request: { contentType: "application/json" } },
      });
      expect(titlesOf(enable?.result)).toEqual(["response", "waited", "dryRun"]);
      expect(enable?.flags["table"]).toMatchObject({ type: "string", variadic: true });
      expect(enable?.flags["dry-run"]).toMatchObject({ type: "boolean", default: false });
      expect(Object.keys(enable?.flags ?? {})).not.toContain("output");
    }),
  );

  it.effect("emits global flags once at the top level, not per command", () =>
    Effect.gen(function* () {
      const { globalFlags, commands } = yield* Effect.promise(() => surface);
      expect(globalFlags["yes"]).toMatchObject({ type: "boolean", default: false });
      expect(globalFlags["output-format"]).toMatchObject({ type: "choice" });
      expect(globalFlags["output-format"]?.choices).toContain("json");
      expect(Object.keys(commands["projects list"]?.flags ?? {})).not.toContain("yes");
    }),
  );

  it.effect("declares a waited result only for a command with a wait read", () =>
    Effect.gen(function* () {
      const { variants } = yield* Effect.promise(() => surface);
      expect(titlesOf(variants.warehouse["warehouse status"]?.result)).toEqual([
        "response",
        "dryRun",
      ]);
    }),
  );

  it.effect("reports a hand-written command with the legacy error contract and no result", () =>
    Effect.gen(function* () {
      const { commands } = yield* Effect.promise(() => surface);
      expect(commands["projects list"]).toMatchObject({
        errors: "legacy",
        result: "undeclared",
        target: { group: "account" },
      });
      expect(commands["projects list"]).not.toHaveProperty("api");
    }),
  );

  it.effect("serializes to JSON and back unchanged", () =>
    Effect.gen(function* () {
      const built = yield* Effect.promise(() => surface);
      expect(decodeJson(encodeJson(built))).toStrictEqual(built);
    }),
  );

  it.effect("loads the generated schemas only through the surface extraction", () =>
    Effect.gen(function* () {
      const extraction = yield* bundledInputs(
        "src/command-internal/command-surface/command-surface.ts",
      );
      const runtime = yield* bundledInputs("src/main.ts");
      expect(extraction).toContain("src/commands/api/generated.schemas.ts");
      expect(runtime).not.toContain("src/commands/api/generated.schemas.ts");
      expect(runtime).not.toContain("src/command-internal/command-surface/command-surface.ts");
    }),
  );
});
