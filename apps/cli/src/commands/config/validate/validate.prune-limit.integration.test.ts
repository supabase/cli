import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { vi } from "vitest";

import { configValuesLayer } from "../../../../tests/helpers/config-values-layer.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockProcessControl } from "../../../../tests/helpers/mocks.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { configValidate } from "./validate.handler.ts";

// oxlint-disable-next-line effecttsgo/async-function -- vi.mock factories are promise-based
vi.mock("../../../config/cli-config-validation.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/cli-config-validation.ts")>()),
  MAX_PRUNE_ROUNDS: 0,
}));

const tempRoot = useTempWorkdir("supabase-config-validate-prune-");

const validate = Effect.fnUntraced(function* (text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(tempRoot.current, "supabase", "config.toml");
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(target, text);
  const out = mockOutput({ format: "json" });
  const processControl = mockProcessControl();
  yield* configValidate().pipe(
    Effect.provide(
      Layer.mergeAll(
        out.layer,
        mockTelemetryStateTracked().layer,
        processControl.layer,
        mockCommandSettings({ workdir: tempRoot.current, explicitWorkdir: true }),
        Layer.succeed(OutputFlag, Option.none()),
        configValuesLayer({}),
        BunServices.layer,
      ),
    ),
  );
  return {
    payload: out.messages.find((message) => message.type === "success")?.data,
    exitCode: processControl.exitCode,
  };
});

describe("config validate when the schema prune limit is reached", () => {
  it.effect("keeps the schema issues it found and reports an incomplete run", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        'project_id = "demo"\n[storage.buckets.images]\npublic = "yes"\n',
      );

      expect(result.exitCode).toBe(1);
      expect(result.payload).toMatchObject({
        valid: false,
        complete: false,
        stopped_at: "schema_limit",
        errors: [{ code: "invalid_type", key: "storage.buckets.images.public" }],
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
