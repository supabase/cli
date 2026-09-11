import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ComputeEnvNotSupportedError } from "./compute.errors.ts";
import { makeComputeProject, setupCompute } from "../../../../tests/helpers/compute.ts";
import { emitComputeMachineOutput } from "./compute.output.ts";

/**
 * The env branch here is unreachable in production (commands refuse `-o env`
 * earlier); this pins it as a backstop against silently falling through to TOML.
 */
describe("emitComputeMachineOutput", () => {
  it.live("refuses -o env rather than falling through to the TOML encoder", () => {
    return Effect.scoped(
      Effect.gen(function* () {
        const created = yield* makeComputeProject({
          "supabase/config.toml": `project_id = "demo"\n`,
        });
        const { layer, out } = setupCompute({ workdir: created.dir, goOutput: "env", routes: {} });
        const error = yield* emitComputeMachineOutput({
          project_ref: "demo",
          compute: [],
        }).pipe(Effect.flip, Effect.provide(layer));

        expect(error).toBeInstanceOf(ComputeEnvNotSupportedError);
        expect(out.stdoutText).toBe("");
      }),
    ).pipe(Effect.provide(BunServices.layer));
  });
});
