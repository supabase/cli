import { type V1ListAllBackupsOutput, type V1ListAllProjectsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path, Schema } from "effect";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockCommandPlatformApi,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import { realLinkedProjectCache } from "../../../../tests/helpers/permission-real-layers.ts";
import { backupsList } from "./list.handler.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const PROJECT: (typeof V1ListAllProjectsOutput.Type)[number] = {
  id: VALID_REF,
  ref: VALID_REF,
  organization_id: "org-123",
  organization_slug: "acme",
  name: "alpha",
  region: "us-east-1",
  created_at: "2026-05-27T01:02:03Z",
  status: "ACTIVE_HEALTHY",
  database: {
    host: "db.alpha.supabase.co",
    version: "15.1",
    postgres_engine: "15",
    release_channel: "ga",
  },
};

const PITR_RESPONSE: typeof V1ListAllBackupsOutput.Type = {
  region: "ap-southeast-1",
  walg_enabled: true,
  pitr_enabled: true,
  backups: [],
  physical_backup_data: {},
};

const LOGICAL_RESPONSE: typeof V1ListAllBackupsOutput.Type = {
  region: "ap-southeast-1",
  walg_enabled: true,
  pitr_enabled: true,
  backups: [
    {
      id: 1,
      is_physical_backup: true,
      status: "COMPLETED",
      inserted_at: "2026-02-08T16:44:07Z",
    },
  ],
  physical_backup_data: {},
};

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: typeof V1ListAllBackupsOutput.Type;
  status?: number;
  network?: "fail";
  apiUrl?: string;
  userAgent?: string;
}

const tempRoot = useTempWorkdir("supabase-backups-list-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? PITR_RESPONSE },
    network: opts.network,
    apiUrl: opts.apiUrl,
    userAgent: opts.userAgent,
  });
  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    apiUrl: opts.apiUrl,
    userAgent: opts.userAgent,
  });
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api };
}

describe("backups list integration", () => {
  it.effect("renders a PITR-only table when no physical backups exist", () => {
    const { layer, out } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("REGION");
      expect(out.stdoutText).toContain("WALG");
      expect(out.stdoutText).toContain("PITR");
      expect(out.stdoutText).toContain("EARLIEST TIMESTAMP");
      expect(out.stdoutText).toContain("LATEST TIMESTAMP");
      expect(out.stdoutText).toContain("Southeast Asia (Singapore)");
      expect(out.stdoutText).toContain("| true ");
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders a logical backups table with PHYSICAL classification", () => {
    const { layer, out } = setup({ response: LOGICAL_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("BACKUP TYPE");
      expect(out.stdoutText).toContain("PHYSICAL");
      expect(out.stdoutText).toContain("COMPLETED");
      expect(out.stdoutText).toContain("2026-02-08 16:44:07");
    }).pipe(Effect.provide(layer));
  });

  it.effect("translates ap-southeast-1 to Southeast Asia (Singapore)", () => {
    const { layer, out } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("Southeast Asia (Singapore)");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a JSON success event when --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ region: "ap-southeast-1", walg_enabled: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a result event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ region: "ap-southeast-1" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits indented JSON to stdout for --output json (Go-compat)", () => {
    const { layer, out } = setup({ goOutput: "json", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toBe(
        `{
  "backups": null,
  "physical_backup_data": {},
  "pitr_enabled": true,
  "region": "ap-southeast-1",
  "walg_enabled": true
}
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits YAML to stdout for --output yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("region: ap-southeast-1");
      expect(out.stdoutText).toContain("walgenabled: true");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits TOML to stdout for --output toml", () => {
    const { layer, out } = setup({ goOutput: "toml", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('Region = "ap-southeast-1"');
      expect(out.stdoutText).toContain("WalgEnabled = true");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits [[Backups]] array-of-tables for --output toml with logical backups", () => {
    const { layer, out } = setup({ goOutput: "toml", response: LOGICAL_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toBe(`PitrEnabled = true
Region = "ap-southeast-1"
WalgEnabled = true

[[Backups]]
  Id = 1
  InsertedAt = "2026-02-08T16:44:07Z"
  IsPhysicalBackup = true
  Status = "COMPLETED"

[PhysicalBackupData]
`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits KEY=VALUE lines for --output env", () => {
    const { layer, out } = setup({ goOutput: "env", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('REGION="ap-southeast-1"');
      expect(out.stdoutText).toContain('WALG_ENABLED="true"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats --output pretty as identical to text mode (Glamour table)", () => {
    const { layer, out } = setup({ goOutput: "pretty", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("Southeast Asia (Singapore)");
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output flag value wins over --output-format when both provided", () => {
    const { layer, out } = setup({
      format: "json",
      goOutput: "yaml",
      response: PITR_RESPONSE,
    });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("region: ap-southeast-1");
      expect(out.stdoutText.startsWith("{")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes the resolved project ref into the listAllBackups URL", () => {
    const { layer, api } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/database/backups`);
      assertPermissionDrift({ command: "backups list", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses --project-ref flag value over CommandSettings.projectId env", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.some(flagRef) });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
      assertPermissionDrift({
        command: "backups list",
        activeFlags: { "project-ref": true },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "lists projects for the picker, then the backups, then fills the linked-project cache",
    () => {
      const out = mockOutput({ promptSelectResponses: [VALID_REF] });
      const api = mockCommandPlatformApi({
        handler: (request) => {
          if (request.url === "https://api.supabase.com/v1/projects") {
            return Effect.succeed(jsonResponse(request, 200, [PROJECT]));
          }
          if (request.url === `https://api.supabase.com/v1/projects/${VALID_REF}`) {
            return Effect.succeed(jsonResponse(request, 200, PROJECT));
          }
          return Effect.succeed(jsonResponse(request, 200, PITR_RESPONSE));
        },
      });
      const cliSettings = mockCommandSettings({
        workdir: tempRoot.current,
        projectId: Option.none(),
      });
      const layer = buildTestRuntime({
        out,
        api,
        cliSettings,
        tty: mockTty({ stdinIsTty: true }),
        linkedProjectCache: realLinkedProjectCache({
          httpClient: api.httpClientLayer,
          cliSettings,
        }),
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
        expect(yield* fs.exists(cachePath)).toBe(false);
        yield* backupsList({ projectRef: Option.none() });
        expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
          "GET https://api.supabase.com/v1/projects",
          `GET https://api.supabase.com/v1/projects/${VALID_REF}/database/backups`,
          `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
        ]);
        expect(out.stdoutText).toContain("Southeast Asia (Singapore)");
        expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
          ref: VALID_REF,
        });
        assertPermissionDrift({ command: "backups list", requests: api.requests, exact: true });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("reads supabase/.temp/project-ref when env and flag are unset", () => {
    const fileRef = "filerefabcdefghijklm";
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: PITR_RESPONSE } });
    const cliSettings = mockCommandSettings({
      workdir: tempRoot.current,
      projectId: Option.none(),
    });
    const layer = buildTestRuntime({ out, api, cliSettings });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = path.join(tempRoot.current, "supabase", ".temp");
      yield* fs.makeDirectory(tempDir, { recursive: true });
      yield* fs.writeFileString(path.join(tempDir, "project-ref"), fileRef);

      yield* backupsList({ projectRef: Option.none() });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${fileRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with ProjectRefNotLinkedError when no ref source matches off-TTY", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: PITR_RESPONSE } });
    const cliSettings = mockCommandSettings({
      workdir: tempRoot.current,
      projectId: Option.none(),
    });
    const layer = buildTestRuntime({ out, api, cliSettings });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        backupsList({ projectRef: Option.none() }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("ProjectRefNotLinkedError");
      }
    });
  });

  it.effect("fails with InvalidProjectRefError when the resolved ref is malformed", () => {
    const { layer } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(backupsList({ projectRef: Option.some("BADREF") }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("InvalidProjectRefError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BackupListUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: PITR_RESPONSE });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(backupsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BackupListUnexpectedStatusError");
        expect(causeText).toContain("unexpected list backup status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BackupListNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(backupsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BackupListNetworkError");
        expect(causeText).toContain("failed to list physical backups");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* backupsList({ projectRef: Option.none() }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "sends User-Agent SupabaseCLI/<version> and no X-Supabase-Command headers (Go parity)",
    () => {
      const { layer, api } = setup({
        response: PITR_RESPONSE,
        userAgent: "SupabaseCLI/1.42.0",
      });
      return Effect.gen(function* () {
        yield* backupsList({ projectRef: Option.none() });
        const headers = api.requests[0]?.headers;
        expect(headers?.["user-agent"]).toBe("SupabaseCLI/1.42.0");
        expect(headers?.["x-supabase-command"]).toBeUndefined();
        expect(headers?.["x-supabase-command-run-id"]).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );
});
