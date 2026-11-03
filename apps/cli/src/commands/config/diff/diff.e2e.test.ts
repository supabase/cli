import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

// A fake-but-well-formed token bypasses the auth layer's eager `SUPABASE_ACCESS_TOKEN` check,
// so the run reaches this command's handler instead of failing on "Access token not provided".
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("config diff CLI surface", () => {
  it.live("plain `config diff` parses — no boolean flag is accidentally required", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-config-diff-e2e-" });
      const { stdout, stderr } = yield* runSupabaseEffect(["config", "diff"], {
        cwd,
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
      });
      const combined = `${stdout}\n${stderr}`;
      expect(combined).not.toContain("required flag");
      // This hermetic cwd has no config file, so reaching the handler (not just a binary-launch
      // failure) surfaces this load-error text — guarding against a vacuously green regression.
      expect(combined).toContain(
        "failed to read supabase/config.toml or supabase/config.json: file not found. Run `supabase init` to create one.",
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
