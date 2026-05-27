import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { mockOutput, mockTty } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  legacyJsonResponse,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyBackupsRestore } from "./restore.handler.ts";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  status?: number;
  network?: "fail";
}

const tempRoot = useLegacyTempWorkdir("supabase-backups-restore-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    // POST returns 201 with an empty/null body in the real Management API.
    response: { status: opts.status ?? 201, body: null },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy backups restore integration", () => {
  it.live("sends recovery_time_target_unix=0 when --timestamp is omitted", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.none(),
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.body).toEqual({ recovery_time_target_unix: 0 });
    }).pipe(Effect.provide(layer));
  });

  it.live("sends the supplied timestamp when --timestamp is provided", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.some(1_707_407_047),
      });
      expect(api.requests[0]?.body).toEqual({ recovery_time_target_unix: 1_707_407_047 });
    }).pipe(Effect.provide(layer));
  });

  it.live("writes 'Started PITR restore: <ref>\\n' to stderr in text mode (Go parity)", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.none(),
      });
      expect(out.stderrText).toBe(`Started PITR restore: ${LEGACY_VALID_REF}\n`);
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success event for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.none(),
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("Started PITR restore");
      expect(success?.data).toEqual({ project_ref: LEGACY_VALID_REF });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.none(),
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toEqual({ project_ref: LEGACY_VALID_REF });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits indented JSON to stdout for --output json (Go-compat)", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.none(),
      });
      expect(out.stdoutText).toContain('"message": "Started PITR restore"');
      expect(out.stdoutText).toContain(`"project_ref": "${LEGACY_VALID_REF}"`);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "renders the stderr text line for --output {pretty,yaml,toml,env} (Go ignores --output)",
    () => {
      const { layer, out } = setup({ goOutput: "yaml" });
      return Effect.gen(function* () {
        yield* legacyBackupsRestore({
          projectRef: Option.none(),
          timestamp: Option.none(),
        });
        expect(out.stderrText).toBe(`Started PITR restore: ${LEGACY_VALID_REF}\n`);
        expect(out.stdoutText).toBe("");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("uses --project-ref flag over LegacyCliConfig.projectId", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.some(flagRef),
        timestamp: Option.none(),
      });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBackupRestoreUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBackupsRestore({ projectRef: Option.none(), timestamp: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyBackupRestoreUnexpectedStatusError");
        expect(errorJson).toContain("unexpected restore backup status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBackupRestoreNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBackupsRestore({ projectRef: Option.none(), timestamp: Option.none() }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyBackupRestoreNetworkError");
        expect(errorJson).toContain("failed to restore backup");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectNotLinkedError non-interactively when no ref source", () => {
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-backups-restore-int-noref-"));
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({});
    const cliConfig = mockLegacyCliConfig({
      workdir: localTempRoot,
      projectId: Option.none(),
    });
    const layer = buildLegacyTestRuntime({ out, api, cliConfig });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBackupsRestore({ projectRef: Option.none(), timestamp: Option.none() }).pipe(
          Effect.provide(layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectNotLinkedError");
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(localTempRoot, { recursive: true, force: true }))),
    );
  });

  it.live("prompts via TTY when no ref source matches and stdin is a TTY", () => {
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-backups-restore-int-prompt-"));
    const out = mockOutput({
      format: "text",
      promptSelectResponses: [LEGACY_VALID_REF],
    });
    // The resolver lists projects, then POSTs the restore. Branch on the path
    // to give the list endpoint its project array and let the restore endpoint
    // succeed with a 201.
    const api = mockLegacyPlatformApi({
      handler: (request) => {
        if (request.url.includes("/v1/projects") && !request.url.includes("/database/backups")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify([
                  {
                    id: LEGACY_VALID_REF,
                    ref: LEGACY_VALID_REF,
                    organization_id: "org_123",
                    organization_slug: "acme",
                    name: "alpha",
                    region: "us-east-1",
                    created_at: "2026-01-01T00:00:00Z",
                    status: "ACTIVE_HEALTHY",
                    database: {
                      host: "db.example.com",
                      version: "15.0",
                      postgres_engine: "supabase-postgres",
                      release_channel: "ga",
                    },
                  },
                ]),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            ),
          );
        }
        return Effect.succeed(legacyJsonResponse(request, 201, null));
      },
    });
    const cliConfig = mockLegacyCliConfig({
      workdir: localTempRoot,
      projectId: Option.none(),
    });
    const layer = buildLegacyTestRuntime({
      out,
      api,
      cliConfig,
      tty: mockTty({ stdinIsTty: true, stdoutIsTty: true }),
    });

    return Effect.gen(function* () {
      yield* legacyBackupsRestore({ projectRef: Option.none(), timestamp: Option.none() }).pipe(
        Effect.provide(layer),
      );
      expect(out.promptSelectCalls).toHaveLength(1);
      expect(out.stderrText).toContain(`Started PITR restore: ${LEGACY_VALID_REF}\n`);
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(localTempRoot, { recursive: true, force: true }))),
    );
  });

  it.live("accepts --timestamp short alias -t in the same way (no separate parse path)", () => {
    // The flag layer is responsible for parsing -t into `timestamp`; once parsed,
    // the handler does not differentiate, so we just verify the handler honors the value.
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBackupsRestore({
        projectRef: Option.none(),
        timestamp: Option.some(42),
      });
      expect(api.requests[0]?.body).toEqual({ recovery_time_target_unix: 42 });
    }).pipe(Effect.provide(layer));
  });
});
