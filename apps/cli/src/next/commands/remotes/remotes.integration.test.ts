import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { mockOutput, mockProjectHome } from "../../../../tests/helpers/mocks.ts";
import { add } from "./add/add.handler.ts";
import { list } from "./list/list.handler.ts";
import { remove } from "./remove/remove.handler.ts";

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
  const layer = Layer.mergeAll(
    out.layer,
    mockProjectHome({ projectRoot: workdir }),
    BunServices.layer,
  );
  return { layer, out };
}

describe("supabase remotes (next)", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "supabase-next-test-"));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it.live("add then list then remove a remote end to end", () =>
    Effect.gen(function* () {
      yield* writeConfig(workdir, 'project_id = "local"\n');
      const { layer, out } = setup(workdir);

      yield* add({ name: "staging", projectRef: REF_A }).pipe(Effect.provide(layer));
      expect(out.stdoutText).toContain(`Added remote "staging" -> ${REF_A}.`);

      yield* list().pipe(Effect.provide(layer));
      expect(out.stdoutText).toContain("staging");
      expect(out.stdoutText).toContain(REF_A);

      yield* remove({ name: "staging" }).pipe(Effect.provide(layer));
      expect(out.stdoutText).toContain('Removed remote "staging".');
    }),
  );

  it.live("re-adding the same name with the same ref is a no-op", () =>
    Effect.gen(function* () {
      yield* writeConfig(workdir, "");
      const { layer, out } = setup(workdir);

      yield* add({ name: "staging", projectRef: REF_A }).pipe(Effect.provide(layer));
      yield* add({ name: "staging", projectRef: REF_A }).pipe(Effect.provide(layer));
      expect(out.stdoutText).toContain("nothing to do");
    }),
  );

  it.live("re-adding the same name with a different ref fails", () =>
    Effect.gen(function* () {
      yield* writeConfig(workdir, "");
      const { layer } = setup(workdir);

      yield* add({ name: "staging", projectRef: REF_A }).pipe(Effect.provide(layer));
      const exit = yield* add({ name: "staging", projectRef: REF_B }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("removing an unknown remote fails", () =>
    Effect.gen(function* () {
      yield* writeConfig(workdir, "");
      const { layer } = setup(workdir);

      const exit = yield* remove({ name: "ghost" }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("remotes * fails when no project config exists", () =>
    Effect.gen(function* () {
      const { layer } = setup(workdir);
      const exit = yield* list().pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("json mode emits a structured payload instead of a table", () =>
    Effect.gen(function* () {
      yield* writeConfig(workdir, `[remotes.staging]\nproject_id = "${REF_A}"\n`);
      const { layer, out } = setup(workdir, "json");

      yield* list().pipe(Effect.provide(layer));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toEqual({ remotes: [{ name: "staging", project_ref: REF_A }] });
    }),
  );
});
