import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";

import { mockOutput } from "../../tests/helpers/mocks.ts";
import { flagInput } from "../../tests/helpers/config-snapshot-layer.ts";
import { CliConfigFlagInputs, makeCliConfigFlagInputs } from "../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../config/cli-config-values.layer.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import { resolveLinkedPassword } from "./db-config.layer.ts";
import { Output } from "../shared/output/output.service.ts";
import { DebugLogger } from "../shared/output/debug-logger.service.ts";

const LINKED = "linkedprojectrefabcd";
const TARGET = "targetprojectrefabcd";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const workdir = (opts: { readonly linkedRef?: string; readonly dotenv?: string } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "db-config-password-"));
  dirs.push(dir);
  mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
  if (opts.linkedRef !== undefined) {
    writeFileSync(join(dir, "supabase", ".temp", "project-ref"), opts.linkedRef);
  }
  if (opts.dotenv !== undefined) writeFileSync(join(dir, "supabase", ".env"), opts.dotenv);
  return dir;
};

const run = <A, E>(
  effect: Effect.Effect<A, E, CliConfigValues | DebugLogger | Output>,
  opts: {
    readonly env?: Record<string, string>;
    readonly flagPassword?: string;
  } = {},
) => {
  const out = mockOutput();
  const debugLines: Array<string> = [];
  const layer = Layer.mergeAll(
    out.layer,
    cliConfigValuesLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          BunServices.layer,
          out.layer,
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord(opts.env ?? {}, { preserveEmptyStrings: true }),
          ),
          Layer.succeed(
            CliConfigFlagInputs,
            makeCliConfigFlagInputs(
              opts.flagPassword === undefined
                ? []
                : [flagInput("linkedDb.password", "password", opts.flagPassword)],
            ),
          ),
        ),
      ),
    ),
    Layer.succeed(DebugLogger, {
      debug: (message) => Effect.sync(() => void debugLines.push(message)),
      http: () => Effect.void,
    }),
  );
  return effect.pipe(
    Effect.provide(layer),
    Effect.map((result) => ({
      result,
      stderr: out.stderrText,
      warnings: out.messages.filter((m) => m.type === "warn").map((m) => m.message),
      debugLines,
    })),
  );
};

const ENV = { SUPABASE_DB_PASSWORD: "env-password" };

describe("resolveLinkedPassword", () => {
  it.effect("uses the env password when the target is the linked project", () => {
    const dir = workdir({ linkedRef: TARGET });
    return run(resolveLinkedPassword(TARGET, dir, Option.none()), { env: ENV }).pipe(
      Effect.tap(({ result, warnings, debugLines }) =>
        Effect.sync(() => {
          expect(result).toBe("env-password");
          expect(warnings).toEqual([]);
          expect(debugLines).toEqual([
            "Using database password from SUPABASE_DB_PASSWORD (environment)...",
          ]);
        }),
      ),
    );
  });

  it.effect("uses the env password when the workdir is not linked", () => {
    const dir = workdir();
    return run(resolveLinkedPassword(TARGET, dir, Option.none()), { env: ENV }).pipe(
      Effect.tap(({ result, warnings }) =>
        Effect.sync(() => {
          expect(result).toBe("env-password");
          expect(warnings).toEqual([]);
        }),
      ),
    );
  });

  it.effect(
    "ignores the env password for a project other than the linked one and says so once",
    () => {
      const dir = workdir({ linkedRef: LINKED });
      return run(
        Effect.gen(function* () {
          const first = yield* resolveLinkedPassword(TARGET, dir, Option.none(), true);
          const second = yield* resolveLinkedPassword(TARGET, dir, Option.none(), true);
          return [first, second];
        }),
        { env: ENV },
      ).pipe(
        Effect.tap(({ result, warnings, debugLines }) =>
          Effect.sync(() => {
            expect(result).toEqual(["", ""]);
            expect(warnings).toEqual([
              `Not sending SUPABASE_DB_PASSWORD to ${TARGET}: this directory is linked to ${LINKED}. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN). Pass --password to use a password for ${TARGET}.`,
            ]);
            expect(debugLines).toEqual([
              "No database password found; using a temporary login role...",
              "No database password found; using a temporary login role...",
            ]);
          }),
        ),
      );
    },
  );

  it.effect("omits the --password sentence for commands without a --password binding", () => {
    const dir = workdir({ linkedRef: LINKED });
    return run(resolveLinkedPassword(TARGET, dir, Option.none()), { env: ENV }).pipe(
      Effect.tap(({ warnings }) =>
        Effect.sync(() => {
          expect(warnings).toEqual([
            `Not sending SUPABASE_DB_PASSWORD to ${TARGET}: this directory is linked to ${LINKED}. Using a temporary login role instead (needs supabase login or SUPABASE_ACCESS_TOKEN).`,
          ]);
        }),
      ),
    );
  });

  it.effect("ignores a project .env password for a project other than the linked one", () => {
    const dir = workdir({ linkedRef: LINKED, dotenv: "SUPABASE_DB_PASSWORD=dotenv-password\n" });
    return run(resolveLinkedPassword(TARGET, dir, Option.none())).pipe(
      Effect.tap(({ result, warnings }) =>
        Effect.sync(() => {
          expect(result).toBe("");
          expect(warnings).toHaveLength(1);
        }),
      ),
    );
  });

  it.effect("uses the project .env password for the linked project", () => {
    const dir = workdir({ linkedRef: TARGET, dotenv: "SUPABASE_DB_PASSWORD=dotenv-password\n" });
    return run(resolveLinkedPassword(TARGET, dir, Option.none())).pipe(
      Effect.tap(({ result, debugLines }) =>
        Effect.sync(() => {
          expect(result).toBe("dotenv-password");
          expect(debugLines[0]).toContain("SUPABASE_DB_PASSWORD (");
          expect(debugLines[0]).toContain(".env");
        }),
      ),
    );
  });

  it.effect("uses the --password flag for a foreign project without a notice", () => {
    const dir = workdir({ linkedRef: LINKED });
    return run(resolveLinkedPassword(TARGET, dir, Option.none()), {
      env: ENV,
      flagPassword: "flag-password",
    }).pipe(
      Effect.tap(({ result, stderr, debugLines }) =>
        Effect.sync(() => {
          expect(result).toBe("flag-password");
          expect(debugLines).toEqual(["Using database password from --password..."]);
          expect(stderr).not.toContain("SUPABASE_DB_PASSWORD");
        }),
      ),
    );
  });

  it.effect("prefers --password over the env password for the linked project", () => {
    const dir = workdir({ linkedRef: TARGET });
    return run(resolveLinkedPassword(TARGET, dir, Option.none()), {
      env: ENV,
      flagPassword: "flag-password",
    }).pipe(Effect.tap(({ result }) => Effect.sync(() => expect(result).toBe("flag-password"))));
  });

  it.effect("returns a caller-supplied password without loading config", () => {
    const dir = workdir({ linkedRef: LINKED });
    return run(resolveLinkedPassword(TARGET, dir, Option.some("created-password")), {
      env: ENV,
    }).pipe(
      Effect.tap(({ result, stderr }) =>
        Effect.sync(() => {
          expect(result).toBe("created-password");
          expect(stderr).toBe("");
        }),
      ),
    );
  });
});
