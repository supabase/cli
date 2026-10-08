import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";

import { mockOutput } from "../../tests/helpers/mocks.ts";
import { CliConfigFlagInputs } from "../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../config/cli-config-values.layer.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import { resolveLinkedPassword } from "./db-config.layer.ts";
import { Output } from "../shared/output/output.service.ts";
import { DebugLogger } from "./debug-logger.service.ts";

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
  opts: { readonly env?: Record<string, string>; readonly flagPassword?: string } = {},
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
            opts.flagPassword === undefined
              ? new Map()
              : new Map([
                  [
                    "linkedDb.password",
                    { path: "linkedDb.password", flag: "password", value: opts.flagPassword },
                  ],
                ]),
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
    Effect.map((result) => ({ result, stderr: out.stderrText, debugLines })),
  );
};

const ENV = { SUPABASE_DB_PASSWORD: "env-password" };

describe("resolveLinkedPassword", () => {
  it.effect("uses the env password when the target is the linked project", () => {
    const dir = workdir({ linkedRef: TARGET });
    return run(resolveLinkedPassword(TARGET, dir, Option.none()), { env: ENV }).pipe(
      Effect.tap(({ result, stderr, debugLines }) =>
        Effect.sync(() => {
          expect(result).toBe("env-password");
          expect(stderr).not.toContain("WARN");
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
      Effect.tap(({ result, stderr }) =>
        Effect.sync(() => {
          expect(result).toBe("env-password");
          expect(stderr).not.toContain("WARN");
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
          const first = yield* resolveLinkedPassword(TARGET, dir, Option.none());
          const second = yield* resolveLinkedPassword(TARGET, dir, Option.none());
          return [first, second];
        }),
        { env: ENV },
      ).pipe(
        Effect.tap(({ result, stderr, debugLines }) =>
          Effect.sync(() => {
            expect(result).toEqual(["", ""]);
            const warnings = stderr.split("\n").filter((line) => line.includes("WARN"));
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("SUPABASE_DB_PASSWORD");
            expect(warnings[0]).toContain(LINKED);
            expect(warnings[0]).toContain(TARGET);
            expect(warnings[0]).toContain("--password");
            expect(debugLines).toEqual([
              "No database password found; using a temporary login role...",
              "No database password found; using a temporary login role...",
            ]);
          }),
        ),
      );
    },
  );

  it.effect("ignores a project .env password for a project other than the linked one", () => {
    const dir = workdir({ linkedRef: LINKED, dotenv: "SUPABASE_DB_PASSWORD=dotenv-password\n" });
    return run(resolveLinkedPassword(TARGET, dir, Option.none())).pipe(
      Effect.tap(({ result, stderr }) =>
        Effect.sync(() => {
          expect(result).toBe("");
          expect(stderr).toContain("WARN");
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
