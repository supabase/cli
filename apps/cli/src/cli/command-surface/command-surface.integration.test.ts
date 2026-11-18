import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { commandSurface, commandSurfaceEntry, walkCommandSurface } from "./command-surface.ts";
import { rootCommandForFeatures } from "../root.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const surface = Effect.runPromise(commandSurface());

const warehouseVariant = Effect.promise(() => surface).pipe(
  Effect.map(({ variants }) => {
    const variant = variants["warehouse"];
    if (variant === undefined) throw new Error("the surface has no warehouse variant");
    return variant;
  }),
);

const titlesOf = (result: unknown): ReadonlyArray<unknown> =>
  typeof result === "object" && result !== null && "anyOf" in result && Array.isArray(result.anyOf)
    ? result.anyOf.map((branch) =>
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
      const warehouse = yield* warehouseVariant;
      expect(Object.keys(warehouse)).toEqual([
        "warehouse",
        "warehouse connection",
        "warehouse disable",
        "warehouse enable",
        "warehouse status",
        "warehouse teardowns",
        "warehouse teardowns get",
      ]);
    }),
  );

  it.effect("extracts one command from any mounted root, keyed like the full walk", () =>
    Effect.gen(function* () {
      const root = rootCommandForFeatures({ apiFeatures: ["warehouse"] });
      const walked = yield* walkCommandSurface(root);
      const single = yield* commandSurfaceEntry(root, ["warehouse", "status"]);
      expect(walked["warehouse status"]).toStrictEqual(single);
      expect(Object.keys(walked)).toEqual(Object.keys(walked).toSorted());
    }),
  );

  it.effect("describes a generated command from its annotations and operation schemas", () =>
    Effect.gen(function* () {
      const warehouse = yield* warehouseVariant;
      const enable = warehouse["warehouse enable"];
      expect(enable).toMatchObject({
        path: ["warehouse", "enable"],
        target: { group: "hosted", consent: "no" },
        errors: "standard",
        stage: { status: "experimental", feature: "warehouse" },
        api: { operationId: "v2-enable-warehouse", request: { contentType: "application/json" } },
      });
      expect(titlesOf(enable?.result)).toEqual(["response", "waited", "dryRun"]);
      expect(enable?.flags["schema"]).toMatchObject({ required: true });
      expect(enable?.flags["table"]).toMatchObject({
        type: "string",
        variadic: true,
        required: false,
      });
      expect(enable?.flags["dry-run"]).toMatchObject({ type: "boolean", default: false });
      expect(Object.keys(enable?.flags ?? {})).not.toContain("output");
    }),
  );

  it.effect("describes retained-data disable and its linked cleanup read", () =>
    Effect.gen(function* () {
      const warehouse = yield* warehouseVariant;
      const disable = warehouse["warehouse disable"];
      expect(disable).toMatchObject({
        target: { group: "hosted", consent: "no" },
        stage: { status: "experimental", feature: "warehouse" },
        errors: "standard",
        api: { operationId: "v2-disable-warehouse" },
      });
      expect(disable?.flags["delete-data"]).toMatchObject({ type: "boolean", required: false });
      expect(disable?.flags["wait"]).toMatchObject({ type: "boolean" });
      expect(disable?.flags["timeout"]).toMatchObject({ type: "string" });
      expect(titlesOf(disable?.result)).toEqual(["response", "waited", "dryRun"]);
      expect(warehouse["warehouse teardowns get"]?.flags["operation-id"]).toMatchObject({
        required: false,
      });
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

  it.effect("separates consolidated status from the identity-bound setup waiter", () =>
    Effect.gen(function* () {
      const warehouse = yield* warehouseVariant;
      const status = warehouse["warehouse status"];
      expect(status).toMatchObject({
        api: { operationId: "v2-get-warehouse-status" },
        target: { group: "hosted", consent: "none" },
        stage: { status: "experimental", feature: "warehouse" },
      });
      expect(status?.flags).not.toHaveProperty("inspect-fdw");
      expect(status?.flags).not.toHaveProperty("selection-id");
      expect(status?.flags).not.toHaveProperty("wait");
      expect(status?.flags).not.toHaveProperty("timeout");
      expect(warehouse).not.toHaveProperty("warehouse setups");
      expect(warehouse).not.toHaveProperty("warehouse setups get");
      expect(warehouse["warehouse enable"]?.flags).toMatchObject({
        wait: { type: "boolean" },
        timeout: { type: "string" },
      });
    }),
  );

  it.effect("declares a waited result only for a command that waits on another read", () =>
    Effect.gen(function* () {
      const warehouse = yield* warehouseVariant;
      expect(titlesOf(warehouse["warehouse status"]?.result)).toEqual(["response", "dryRun"]);
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
      const extraction = yield* bundledInputs("src/cli/command-surface/command-surface.ts");
      const runtime = yield* bundledInputs("src/main.ts");
      expect(extraction).toContain("src/commands/api/generated.schemas.ts");
      expect(runtime).not.toContain("src/commands/api/generated.schemas.ts");
      expect(runtime).not.toContain("src/cli/command-surface/command-surface.ts");
    }),
  );
});
