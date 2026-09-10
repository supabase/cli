import { rmSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ComputeEnvNotSupportedError } from "./compute.errors.ts";
import { makeComputeProject, setupCompute } from "../../../tests/helpers/compute.ts";
import { emitComputeMachineOutput } from "./compute.output.ts";

/**
 * Every compute command refuses `-o env` up front, before it touches the
 * network, so the encoder's own env branch is a backstop rather than a path a
 * user reaches. It is worth pinning anyway: a new command that forgets the
 * refusal must not silently emit TOML under a flag that asked for env — it
 * raises the same refusal instead.
 */
describe("emitComputeMachineOutput", () => {
  it.live("refuses -o env rather than falling through to the TOML encoder", () => {
    const created = makeComputeProject({ "supabase/config.toml": `project_id = "demo"\n` });
    const { layer, out } = setupCompute({
      workdir: created.dir,
      goOutput: "env",
      routes: {},
    });

    return Effect.gen(function* () {
      const error = yield* emitComputeMachineOutput({
        project_ref: "demo",
        compute: [],
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ComputeEnvNotSupportedError);
      expect(out.stdoutText).toBe("");
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(created.dir, { recursive: true, force: true }))),
    );
  });
});
