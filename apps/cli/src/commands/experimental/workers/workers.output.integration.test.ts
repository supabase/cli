import { rmSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { WorkersEnvNotSupportedError } from "./workers.errors.ts";
import { makeWorkersProject, setupWorkers } from "../../../../tests/helpers/workers.ts";
import { emitWorkersMachineOutput } from "./workers.output.ts";

/**
 * Every workers command refuses `-o env` up front, before it touches the
 * network, so the encoder's own env branch is a backstop rather than a path a
 * user reaches. It is worth pinning anyway: a new command that forgets the
 * refusal must not silently emit TOML under a flag that asked for env — it
 * raises the same refusal instead.
 */
describe("emitWorkersMachineOutput", () => {
  it.live("refuses -o env rather than falling through to the TOML encoder", () => {
    const created = makeWorkersProject({ "supabase/config.toml": `project_id = "demo"\n` });
    const { layer, out } = setupWorkers({
      workdir: created.dir,
      goOutput: "env",
      routes: {},
    });

    return Effect.gen(function* () {
      const error = yield* emitWorkersMachineOutput({
        project_ref: "demo",
        workers: [],
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersEnvNotSupportedError);
      expect(out.stdoutText).toBe("");
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(created.dir, { recursive: true, force: true }))),
    );
  });
});
