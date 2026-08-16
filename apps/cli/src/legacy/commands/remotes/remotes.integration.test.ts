import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Exit, Layer } from "effect";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { legacyRemotesAdd } from "./add/add.handler.ts";
import { legacyRemotesList } from "./list/list.handler.ts";
import { legacyRemotesRemove } from "./remove/remove.handler.ts";

const REF_A = "abcdefghijklmnopqrst";
const REF_B = "zzzzzzzzzzzzzzzzzzzz";

function writeConfig(dir: string, content: string) {
  return Effect.promise(async () => {
    await mkdir(join(dir, "supabase"), { recursive: true });
    await writeFile(join(dir, "supabase", "config.toml"), content);
  });
}

function setup(workdir: string, format: "text" | "json" = "text") {
  const out = mockOutput({ format });
  const telemetry = mockLegacyTelemetryStateTracked();
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    mockLegacyCliConfig({ workdir }),
    BunServices.layer,
  );
  return { layer, out, telemetry };
}

describe("supabase remotes", () => {
  const workdir = useLegacyTempWorkdir();

  it.live("add then list then remove a remote end to end", () =>
    Effect.gen(function* () {
      yield* writeConfig(workdir.current, 'project_id = "local"\n');
      const { layer, out, telemetry } = setup(workdir.current);

      yield* legacyRemotesAdd({ name: "staging", projectRef: REF_A }).pipe(Effect.provide(layer));
      expect(telemetry.flushCount).toBe(1);
      expect(out.stdoutText).toContain(`Added remote "staging" -> ${REF_A}.`);

      yield* legacyRemotesList().pipe(Effect.provide(layer));
      expect(out.stdoutText).toContain("staging");
      expect(out.stdoutText).toContain(REF_A);

      yield* legacyRemotesRemove({ name: "staging" }).pipe(Effect.provide(layer));
      expect(out.stdoutText).toContain('Removed remote "staging".');
    }),
  );

  it.live("re-adding the same name with the same ref is a no-op", () =>
    Effect.gen(function* () {
      yield* writeConfig(workdir.current, "");
      const { layer, out } = setup(workdir.current);

      yield* legacyRemotesAdd({ name: "staging", projectRef: REF_A }).pipe(Effect.provide(layer));
      yield* legacyRemotesAdd({ name: "staging", projectRef: REF_A }).pipe(Effect.provide(layer));
      expect(out.stdoutText).toContain("nothing to do");
    }),
  );

  it.live("re-adding the same name with a different ref fails", () =>
    Effect.gen(function* () {
      yield* writeConfig(workdir.current, "");
      const { layer } = setup(workdir.current);

      yield* legacyRemotesAdd({ name: "staging", projectRef: REF_A }).pipe(Effect.provide(layer));
      const exit = yield* legacyRemotesAdd({ name: "staging", projectRef: REF_B }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("removing an unknown remote fails", () =>
    Effect.gen(function* () {
      yield* writeConfig(workdir.current, "");
      const { layer } = setup(workdir.current);

      const exit = yield* legacyRemotesRemove({ name: "ghost" }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("remotes * fails when no project config exists", () =>
    Effect.gen(function* () {
      const { layer } = setup(workdir.current);
      const exit = yield* legacyRemotesList().pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("json mode emits a structured payload instead of a table", () =>
    Effect.gen(function* () {
      yield* writeConfig(workdir.current, `[remotes.staging]\nproject_id = "${REF_A}"\n`);
      const { layer, out } = setup(workdir.current, "json");

      yield* legacyRemotesList().pipe(Effect.provide(layer));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toEqual({ remotes: [{ name: "staging", project_ref: REF_A }] });
    }),
  );
});
