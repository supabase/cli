import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path } from "effect";

import { configValuesLayer } from "../../tests/helpers/config-values-layer.ts";
import { mockCommandSettings } from "../../tests/helpers/command-mocks.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import { planDbSeed } from "./seed-remote-consent.ts";

const REF = "abcdefghijklmnopqrst";

const plan = (
  toml: string,
  options: {
    readonly projectRef?: Option.Option<string>;
    readonly env?: Record<string, string>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "seed-plan-" });
    yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
    yield* fs.writeFileString(path.join(workdir, "supabase", "config.toml"), toml);
    const configValues = yield* CliConfigValues;
    const resolved = yield* configValues.load({
      workdir,
      projectRef: options.projectRef ?? Option.some(REF),
    });
    return yield* planDbSeed(resolved, { workdir, ref: REF });
  }).pipe(
    Effect.scoped,
    Effect.provide(configValuesLayer({ env: options.env })),
    Effect.provide(mockCommandSettings({ workdir: "/unused" })),
    Effect.provide(BunServices.layer),
  );

const FILES = ["supabase/seed.sql", "supabase/seed_users.sql"];

describe("planDbSeed", () => {
  it.effect("describes the files without naming a remote when none matched", () =>
    Effect.gen(function* () {
      const { input, detail } = yield* plan("", { projectRef: Option.none() });
      expect(input.consent).toBeUndefined();
      expect(detail(FILES)).toBe("seed 2 files");
      expect(detail(FILES.slice(0, 1))).toBe("seed 1 file");
    }),
  );

  it.effect("names the matched remote and what turned seeding on", () =>
    Effect.gen(function* () {
      const { input, detail } = yield* plan(`[remotes.prod]\nproject_id = "${REF}"\n`, {
        env: { SUPABASE_DB_SEED_ENABLED: "true" },
      });
      expect(input.enabled).toBe(true);
      expect(input.consent).toMatchObject({ remote: "prod", ref: REF });
      expect(input.consent?.enabledBy).toContain("SUPABASE_DB_SEED_ENABLED");
      expect(detail(FILES)).toBe(
        `seed 2 files into [remotes.prod] (seeding enabled by ${input.consent?.enabledBy})`,
      );
    }),
  );

  it.effect("omits the origin when the remote enables seeding itself", () =>
    Effect.gen(function* () {
      const { input, detail } = yield* plan(
        `[remotes.prod]\nproject_id = "${REF}"\n[remotes.prod.db.seed]\nenabled = true\n`,
      );
      expect(input.consent).toBeUndefined();
      expect(detail(FILES)).toBe("seed 2 files into [remotes.prod]");
    }),
  );

  it.effect("has no detail when a matched remote leaves seeding off", () =>
    Effect.gen(function* () {
      const { input, detail } = yield* plan(`[remotes.prod]\nproject_id = "${REF}"\n`);
      expect(input.enabled).toBe(false);
      expect(detail(FILES)).toBeUndefined();
    }),
  );

  it.effect("has no detail when seeding is off or there is nothing to seed", () =>
    Effect.gen(function* () {
      const off = yield* plan("[db.seed]\nenabled = false\n");
      expect(off.input.enabled).toBe(false);
      expect(off.detail(FILES)).toBeUndefined();

      const none = yield* plan("");
      expect(none.detail([])).toBeUndefined();
    }),
  );
});
