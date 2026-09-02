import { rmSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { LegacyWorkersEnvNotSupportedError } from "./workers.errors.ts";
import {
  makeWorkersProject,
  setupLegacyWorkers,
} from "../../../../../tests/helpers/legacy-workers.ts";
import { legacyEmitWorkersMachineOutput, legacyEmitWorkersPayload } from "./workers.output.ts";

/**
 * Every workers command refuses `-o env` up front, before it touches the
 * network, so the encoder's own env branch is a backstop rather than a path a
 * user reaches. It is worth pinning anyway: a new command that forgets the
 * refusal must not silently emit TOML under a flag that asked for env — it
 * raises the same refusal instead.
 */
describe("legacyEmitWorkersMachineOutput", () => {
  it.live("refuses -o env rather than falling through to the TOML encoder", () => {
    const created = makeWorkersProject({ "supabase/config.toml": `project_id = "demo"\n` });
    const { layer, out } = setupLegacyWorkers({
      workdir: created.dir,
      goOutput: "env",
      routes: {},
    });

    return Effect.gen(function* () {
      const error = yield* legacyEmitWorkersMachineOutput({
        project_ref: "demo",
        workers: [],
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LegacyWorkersEnvNotSupportedError);
      expect(out.stdoutText).toBe("");
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(created.dir, { recursive: true, force: true }))),
    );
  });
});

/**
 * The one place the two format flags are reconciled, so the precedence between
 * them is pinned here rather than once per command.
 */
describe("legacyEmitWorkersPayload", () => {
  const PAYLOAD = { project_ref: "demo", workers: [] };

  function setup(options: Parameters<typeof setupLegacyWorkers>[0]) {
    const created = makeWorkersProject({ "supabase/config.toml": `project_id = "demo"\n` });
    const it = setupLegacyWorkers({ ...options, workdir: created.dir, routes: {} });
    return {
      ...it,
      cleanup: () => rmSync(created.dir, { recursive: true, force: true }),
    };
  }

  const structured = (out: ReturnType<typeof setupLegacyWorkers>["out"]) =>
    out.messages.filter((message) => message.type === "success");

  it.live("hands a plain text run back to its caller", () => {
    const { layer, out, cleanup } = setup({ workdir: "" });

    return Effect.gen(function* () {
      expect(yield* legacyEmitWorkersPayload(PAYLOAD)).toBe(false);
      expect(structured(out)).toHaveLength(0);
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(cleanup)));
  });

  it.live("emits one structured result for --output-format json", () => {
    const { layer, out, cleanup } = setup({ workdir: "", format: "json" });

    return Effect.gen(function* () {
      expect(yield* legacyEmitWorkersPayload(PAYLOAD)).toBe(true);
      expect(structured(out)).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(cleanup)));
  });

  it.live("writes the encoded payload and nothing else for -o json", () => {
    const { layer, out, cleanup } = setup({ workdir: "", goOutput: "json" });

    return Effect.gen(function* () {
      expect(yield* legacyEmitWorkersPayload(PAYLOAD)).toBe(true);
      // Not `output.success`, which would put human text on the same stdout.
      expect(structured(out)).toHaveLength(0);
      expect(JSON.parse(out.stdoutText)).toMatchObject({ project_ref: "demo" });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(cleanup)));
  });

  // `-o` outranks `--output-format`, and `-o pretty` encodes nothing — so this
  // pair asks for the text rendering. Branching on `output.format` alone emitted
  // JSON instead, which is the opposite of what was asked for.
  it.live("lets -o pretty override --output-format json", () => {
    const { layer, out, cleanup } = setup({ workdir: "", goOutput: "pretty", format: "json" });

    return Effect.gen(function* () {
      expect(yield* legacyEmitWorkersPayload(PAYLOAD)).toBe(false);
      expect(structured(out)).toHaveLength(0);
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(cleanup)));
  });
});
