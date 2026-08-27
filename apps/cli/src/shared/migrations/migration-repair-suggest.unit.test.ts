import { describe, expect, test } from "vitest";
import {
  formatHistoryConflict,
  formatLiveEditCommands,
  formatMigrationRepairCommand,
  formatMigrationsPullCommand,
  formatMigrationsPushCommand,
  formatSchemaPullCommand,
  repairFlagsForTarget,
} from "./migration-repair-suggest.ts";

const linked = {
  kind: "linked" as const,
  identity: "abcdefghijklmnop",
  connectionString: "postgresql://postgres:secret@db.example/postgres",
  disposable: false,
  durable: true,
  connectionVerified: true,
  projectRef: "abcdefghijklmnop",
};

const local = {
  kind: "local" as const,
  identity: "local:default",
  connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  disposable: true,
  durable: false,
  connectionVerified: true,
};

const url = {
  kind: "url" as const,
  identity: "connection-string",
  connectionString: "postgresql://postgres:secret@db.example/postgres",
  disposable: false,
  durable: true,
  connectionVerified: false,
};

describe("formatMigrationRepairCommand", () => {
  test("prefills linked applied versions", () => {
    expect(
      formatMigrationRepairCommand({
        status: "applied",
        versions: ["20260819120000"],
      }),
    ).toBe("supabase migration repair --status applied 20260819120000");
  });

  test("adds --local and space-separated versions", () => {
    expect(
      formatMigrationRepairCommand({
        status: "reverted",
        versions: ["111", "222"],
        flags: { local: true },
      }),
    ).toBe("supabase migration repair --local --status reverted 111 222");
  });

  test("uses a same-url placeholder for flag URL targets", () => {
    expect(
      formatMigrationRepairCommand({
        status: "applied",
        versions: ["20260819120000"],
        flags: { dbUrlSame: true },
      }),
    ).toBe("supabase migration repair --db-url <same-url> --status applied 20260819120000");
  });

  test("uses an env-var placeholder for env URL targets", () => {
    expect(
      formatMigrationRepairCommand({
        status: "applied",
        versions: ["20260819120000"],
        flags: { dbUrlEnvVar: "SUPABASE_DB_URL" },
      }),
    ).toBe('supabase migration repair --db-url "$SUPABASE_DB_URL" --status applied 20260819120000');
  });
});

describe("repairFlagsForTarget", () => {
  test("marks local targets", () => {
    expect(repairFlagsForTarget(local)).toEqual({ local: true });
  });

  test("keeps an explicit --project-ref on linked targets", () => {
    expect(repairFlagsForTarget(linked, { projectRef: "abcdefghijklmnop" })).toEqual({
      projectRef: "abcdefghijklmnop",
    });
  });

  test("picks up projectRef from a linked target without opts", () => {
    expect(repairFlagsForTarget(linked)).toEqual({
      projectRef: "abcdefghijklmnop",
    });
  });

  test("uses a same-url placeholder for explicit --db-url / --from targets", () => {
    expect(repairFlagsForTarget(url)).toEqual({ dbUrlSame: true });
  });

  test("uses the env var name when the URL came from the environment", () => {
    const previousSupa = process.env["SUPABASE_DB_URL"];
    const previousDb = process.env["DATABASE_URL"];
    delete process.env["SUPABASE_DB_URL"];
    delete process.env["DATABASE_URL"];
    try {
      expect(repairFlagsForTarget({ ...url, connectionSource: "env" })).toEqual({
        dbUrlEnvVar: "DATABASE_URL",
      });
    } finally {
      if (previousSupa === undefined) delete process.env["SUPABASE_DB_URL"];
      else process.env["SUPABASE_DB_URL"] = previousSupa;
      if (previousDb === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = previousDb;
    }
  });
});

describe("formatHistoryConflict", () => {
  test("points remote-only and pending at migrations pull", () => {
    expect(
      formatHistoryConflict({
        remoteOnly: ["19990101000000"],
        pending: ["20260819120000"],
        flags: { dbUrlSame: true },
      }),
    ).toEqual({
      detail:
        "Local and remote migration histories have diverged (remote-only: 19990101000000; pending: 20260819120000).",
      suggestion: "supabase migrations pull --from <same-url>",
    });
  });
});

describe("formatMigrationsPullCommand", () => {
  test("points remote-only history at fetch-pull without echoing secrets", () => {
    expect(formatMigrationsPullCommand()).toBe("supabase migrations pull --from linked");
    expect(formatMigrationsPullCommand({ local: true })).toBe(
      "supabase migrations pull --from local",
    );
    expect(formatMigrationsPullCommand({ dbUrlEnvVar: "DATABASE_URL" })).toBe(
      'supabase migrations pull --from "$DATABASE_URL"',
    );
    expect(formatMigrationsPullCommand({ dbUrlSame: true })).toBe(
      "supabase migrations pull --from <same-url>",
    );
    expect(formatSchemaPullCommand()).toBe("supabase schema pull --from linked");
    expect(formatSchemaPullCommand({ local: true })).toBe("supabase schema pull --from local");
  });
});

describe("formatMigrationsPushCommand", () => {
  test("keeps linked push bare and preserves URL targets", () => {
    expect(formatMigrationsPushCommand()).toBe("supabase migrations push");
    expect(formatMigrationsPushCommand({ projectRef: "abcdefghijklmnop" })).toBe(
      "supabase migrations push",
    );
    expect(formatMigrationsPushCommand({ local: true })).toBe("supabase migrations apply");
    expect(formatMigrationsPushCommand({ dbUrlSame: true })).toBe(
      "supabase migrations push --db-url <same-url> --allow-remote",
    );
    expect(formatMigrationsPushCommand({ dbUrlEnvVar: "SUPABASE_DB_URL" })).toBe(
      'supabase migrations push --db-url "$SUPABASE_DB_URL" --allow-remote',
    );
  });
});

describe("formatLiveEditCommands", () => {
  test("names diff then repair, not pull", () => {
    expect(formatLiveEditCommands()).toBe(
      [
        "supabase migrations diff --against linked --file supabase/migrations/<version>_<name>.sql",
        "supabase migration repair --status applied <version>",
      ].join("\n"),
    );
  });
});
