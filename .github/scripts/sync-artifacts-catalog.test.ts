import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InvalidPayloadError, nativeFileNames, nativeObjectUrl } from "./slim-mirror-payload.ts";
import {
  CATALOG_PATH,
  planSlimUpdates,
  planUpdatesForService,
  refreshCatalogPin,
  runPlanUpdates,
  validateSlimReleasePublishedPayload,
  type RevisionIo,
} from "./sync-artifacts-catalog.ts";

const NATIVE_TARGETS = ["darwin-arm64", "linux-amd64", "linux-arm64"] as const;

const hex = (seed: string): string => new Bun.CryptoHasher("sha256").update(seed).digest("hex");
const digest = (seed: string): string => `sha256:${hex(seed)}`;

type NativeDigests = Record<(typeof NATIVE_TARGETS)[number], { archive: string; manifest: string }>;

const nativeDigests = (seed: string): NativeDigests => ({
  "darwin-arm64": { archive: hex(`${seed}a`), manifest: hex(`${seed}A`) },
  "linux-amd64": { archive: hex(`${seed}b`), manifest: hex(`${seed}B`) },
  "linux-arm64": { archive: hex(`${seed}c`), manifest: hex(`${seed}C`) },
});

/** Builds a `SHA256SUMS` body via the same file-name helper the sync script reads. */
function checksumsFor(service: string, releaseVersion: string, digests: NativeDigests): string {
  return NATIVE_TARGETS.map((target) => {
    const files = nativeFileNames(service, releaseVersion, target);
    return `${digests[target].archive}  ${files.archive}\n${digests[target].manifest}  ${files.manifest}`;
  }).join("\n");
}

/** An `io` whose S3 copies always match the given checksums. */
function matchingS3(
  service: string,
  releaseVersion: string,
  digests: NativeDigests,
): RevisionIo["s3Sha256"] {
  const byUrl = new Map<string, string>();
  for (const target of NATIVE_TARGETS) {
    const files = nativeFileNames(service, releaseVersion, target);
    byUrl.set(nativeObjectUrl(service, releaseVersion, files.archive), digests[target].archive);
    byUrl.set(nativeObjectUrl(service, releaseVersion, files.manifest), digests[target].manifest);
  }
  return async (url) => byUrl.get(url);
}

/**
 * Runs the repo's pinned `oxfmt` binary over `source`, the way `slim-release-published.yml`
 * formats the catalog after every write, so parsing tests exercise real formatter output
 * (line-wrapping, trailing commas) instead of a hand-written single-line literal.
 */
async function formatWithOxfmt(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sync-artifacts-catalog-"));
  const filePath = join(dir, "Artifacts.ts");
  try {
    await writeFile(filePath, source);
    const proc = Bun.spawn(["node_modules/.bin/oxfmt", "--config", ".oxfmtrc.json", filePath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) throw new Error(`oxfmt failed: ${stderr}`);
    return await readFile(filePath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fixture = `const workloadCatalog = {
  database: definition(
    "postgres",
    placeholderPin("postgres", "17.6.1.168"),
    "bin/supabase-postgres-start",
    ["bin/supabase-postgres-start"],
    { "15.14.1.168": placeholderPin("postgres", "15.14.1.168") },
  ),
  rest: definition("postgrest", placeholderPin("postgrest", "v16.2"), "bin/postgrest"),
  storage: definition("storage", placeholderPin("storage", "v1.73.0"), "bin/storage", ["bin/storage"]),
  analytics: definition(
    "analytics",
    placeholderPin("analytics", "v1.50.9"),
    "bin/logflare",
  ),
};
`;

const vectorFixture = `const workloadCatalog = {
  vector: definition("vector", placeholderPin("vector", "0.53.0"), "bin/vector"),
};
`;

/**
 * Fully resolved (not `placeholderPin`) fixtures for `planSlimUpdates`: a committed catalog
 * always carries resolved pins (see the design doc's one-time alignment), so these give every
 * pin a real revision instead of the `-1` an unresolved placeholder would carry.
 */
const plannerFixture = `const workloadCatalog = {
  rest: definition(
    "postgrest",
    {
      upstreamVersion: "v16.2",
      revision: 0,
      image: "ghcr.io/supabase/cli/postgrest:v16.2-r0@sha256:1111111111111111111111111111111111111111111111111111111111111",
      natives: {},
    },
    "bin/postgrest",
  ),
  storage: definition(
    "storage",
    {
      upstreamVersion: "v1.73.0",
      revision: 0,
      image: "ghcr.io/supabase/cli/storage:v1.73.0-r0@sha256:2222222222222222222222222222222222222222222222222222222222222",
      natives: {},
    },
    "bin/storage",
    ["bin/storage"],
  ),
};
`;

/** Postgres carries two lines (17 default, 15 additional), both resolved. */
const postgresPlannerFixture = `const workloadCatalog = {
  database: definition(
    "postgres",
    {
      upstreamVersion: "17.6.1.168",
      revision: 1,
      image: "ghcr.io/supabase/cli/postgres:17.6.1.168-r1@sha256:3333333333333333333333333333333333333333333333333333333333333",
      natives: {},
    },
    "bin/supabase-postgres-start",
    ["bin/supabase-postgres-start"],
    {
      "15.14.1.168": {
        upstreamVersion: "15.14.1.168",
        revision: 3,
        image: "ghcr.io/supabase/cli/postgres:15.14.1.168-r3@sha256:4444444444444444444444444444444444444444444444444444444444444",
        natives: {},
      },
    },
  ),
};
`;

describe("validateSlimReleasePublishedPayload", () => {
  test("rejects a newline injected into upstream_version", () => {
    expect(() =>
      validateSlimReleasePublishedPayload({
        service: "postgres",
        upstream_version: "15.14.1.168\nrevision=999\ninjected=yes",
        revision: "0",
        release_version: "15.14.1.168\nrevision=999\ninjected=yes-r0",
      }),
    ).toThrow(InvalidPayloadError);
  });

  test("accepts a Studio-style calendar-versioned upstream", () => {
    const payload = validateSlimReleasePublishedPayload({
      service: "studio",
      upstream_version: "2026.09.04-sha-5a67366",
      revision: "1",
      release_version: "2026.09.04-sha-5a67366-r1",
    });

    expect(payload).toEqual({
      service: "studio",
      upstream_version: "2026.09.04-sha-5a67366",
      revision: 1,
      release_version: "2026.09.04-sha-5a67366-r1",
    });
  });

  test("accepts a Postgres four-part upstream version", () => {
    const payload = validateSlimReleasePublishedPayload({
      service: "postgres",
      upstream_version: "15.14.1.168",
      revision: "3",
      release_version: "15.14.1.168-r3",
    });

    expect(payload).toEqual({
      service: "postgres",
      upstream_version: "15.14.1.168",
      revision: 3,
      release_version: "15.14.1.168-r3",
    });
  });

  test("rejects a release_version that does not match the derived value", () => {
    expect(() =>
      validateSlimReleasePublishedPayload({
        service: "postgres",
        upstream_version: "15.14.1.168",
        revision: "3",
        release_version: "15.14.1.168-r4",
      }),
    ).toThrow(InvalidPayloadError);
  });
});

describe("planSlimUpdates", () => {
  test("hotfix only: a higher committed revision of the pinned upstream", () => {
    const { updates, warnings } = planSlimUpdates(plannerFixture, "postgrest", [
      "postgrest-v16.2-r1",
    ]);

    expect(warnings).toEqual([]);
    expect(updates).toEqual([
      {
        kind: "hotfix",
        line: undefined,
        branch: "slim-hotfix/postgrest",
        title: "chore(stack): pin postgrest v16.2-r1",
        fromRelease: "v16.2-r0",
        toUpstream: "v16.2",
        toRelease: "v16.2-r1",
      },
    ]);
  });

  test("upgrade only: a newer committed upstream on the same line", () => {
    const { updates } = planSlimUpdates(plannerFixture, "postgrest", ["postgrest-v16.4-r0"]);

    expect(updates).toEqual([
      {
        kind: "upgrade",
        line: undefined,
        branch: "slim-bump/postgrest",
        title: "chore(stack): bump postgrest to v16.4-r0",
        fromRelease: "v16.2-r0",
        toUpstream: "v16.4",
        toRelease: "v16.4-r0",
      },
    ]);
  });

  test("both a hotfix and an upgrade can be planned in the same run", () => {
    const { updates } = planSlimUpdates(plannerFixture, "postgrest", [
      "postgrest-v16.2-r1",
      "postgrest-v16.4-r0",
    ]);

    expect(updates).toEqual([
      {
        kind: "hotfix",
        line: undefined,
        branch: "slim-hotfix/postgrest",
        title: "chore(stack): pin postgrest v16.2-r1",
        fromRelease: "v16.2-r0",
        toUpstream: "v16.2",
        toRelease: "v16.2-r1",
      },
      {
        kind: "upgrade",
        line: undefined,
        branch: "slim-bump/postgrest",
        title: "chore(stack): bump postgrest to v16.4-r0",
        fromRelease: "v16.2-r0",
        toUpstream: "v16.4",
        toRelease: "v16.4-r0",
      },
    ]);
  });

  test("an older committed upstream is a backlog republish: it plans nothing", () => {
    const { updates, warnings } = planSlimUpdates(plannerFixture, "postgrest", [
      "postgrest-v16.1-r0",
    ]);

    expect(updates).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("postgres: upgrade on the 17 line, hotfix on the 15 line, a major-18 release ignored and warned about", () => {
    const { updates, warnings } = planSlimUpdates(postgresPlannerFixture, "postgres", [
      "postgres-17.11.0.002-r0",
      "postgres-15.14.1.168-r4",
      "postgres-18.0.0.001-r0",
    ]);

    // The ignored major-18 tag is warned about, but doesn't block the two valid updates
    // alongside it (P1: a warning must never corrupt or swallow the plan).
    expect(warnings).toEqual([
      "::warning ::postgres 18.0.0.001 is not on a release line packages/stack/src/Artifacts.ts carries for it; ignoring postgres-18.0.0.001-r0.",
    ]);
    expect(updates).toEqual([
      {
        kind: "upgrade",
        line: "17",
        branch: "slim-bump/postgres-17",
        title: "chore(stack): bump postgres to 17.11.0.002-r0",
        fromRelease: "17.6.1.168-r1",
        toUpstream: "17.11.0.002",
        toRelease: "17.11.0.002-r0",
      },
      {
        kind: "hotfix",
        line: "15",
        branch: "slim-hotfix/postgres-15",
        title: "chore(stack): pin postgres 15.14.1.168-r4",
        fromRelease: "15.14.1.168-r3",
        toUpstream: "15.14.1.168",
        toRelease: "15.14.1.168-r4",
      },
    ]);
  });

  test("Studio: a newer date upgrades; the same date with a different sha does not", () => {
    const studioFixture = `const workloadCatalog = {
  studio: definition(
    "studio",
    {
      upstreamVersion: "2026.09.14-sha-aaaaaaa",
      revision: 0,
      image: "ghcr.io/supabase/cli/studio:2026.09.14-sha-aaaaaaa-r0@sha256:1111111111111111111111111111111111111111111111111111111111111",
      natives: {},
    },
    "bin/studio",
  ),
};
`;

    const sameDate = planSlimUpdates(studioFixture, "studio", ["studio-2026.09.14-sha-bbbbbbb-r0"]);
    expect(sameDate.updates).toEqual([]);

    const newerDate = planSlimUpdates(studioFixture, "studio", [
      "studio-2026.09.28-sha-ccccccc-r0",
    ]);
    expect(newerDate.updates).toEqual([
      {
        kind: "upgrade",
        line: undefined,
        branch: "slim-bump/studio",
        title: "chore(stack): bump studio to 2026.09.28-sha-ccccccc-r0",
        fromRelease: "2026.09.14-sha-aaaaaaa-r0",
        toUpstream: "2026.09.28-sha-ccccccc",
        toRelease: "2026.09.28-sha-ccccccc-r0",
      },
    ]);
  });

  test("Studio: a year rollover upgrades even though releaseLine differs (single-pin services accept any upstream)", () => {
    const studioFixture = `const workloadCatalog = {
  studio: definition(
    "studio",
    {
      upstreamVersion: "2026.09.28-sha-5e59b60",
      revision: 0,
      image: "ghcr.io/supabase/cli/studio:2026.09.28-sha-5e59b60-r0@sha256:5555555555555555555555555555555555555555555555555555555555555",
      natives: {},
    },
    "bin/studio",
  ),
};
`;

    const { updates, warnings } = planSlimUpdates(studioFixture, "studio", [
      "studio-2027.01.01-sha-abcdef0-r0",
    ]);

    expect(warnings).toEqual([]);
    expect(updates).toEqual([
      {
        kind: "upgrade",
        line: undefined,
        branch: "slim-bump/studio",
        title: "chore(stack): bump studio to 2027.01.01-sha-abcdef0-r0",
        fromRelease: "2026.09.28-sha-5e59b60-r0",
        toUpstream: "2027.01.01-sha-abcdef0",
        toRelease: "2027.01.01-sha-abcdef0-r0",
      },
    ]);
  });

  test("postgrest: a major-version bump upgrades even though releaseLine differs (single-pin services accept any upstream)", () => {
    const { updates, warnings } = planSlimUpdates(plannerFixture, "postgrest", [
      "postgrest-v17.0-r0",
    ]);

    expect(warnings).toEqual([]);
    expect(updates).toEqual([
      {
        kind: "upgrade",
        line: undefined,
        branch: "slim-bump/postgrest",
        title: "chore(stack): bump postgrest to v17.0-r0",
        fromRelease: "v16.2-r0",
        toUpstream: "v17.0",
        toRelease: "v17.0-r0",
      },
    ]);
  });

  test("a non-comparable version (OrioleDB-style suffix) is ignored and warned about", () => {
    const { updates, warnings } = planSlimUpdates(plannerFixture, "postgrest", [
      "postgrest-v16.2-orioledb-r0",
    ]);

    expect(updates).toEqual([]);
    expect(warnings).toEqual([
      "::warning ::postgrest v16.2-orioledb is not a comparable version; ignoring.",
    ]);
  });

  test("a legacy tag with no -rN is ignored", () => {
    const { updates, warnings } = planSlimUpdates(plannerFixture, "postgrest", ["postgrest-v16.4"]);

    expect(updates).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("postgrest tags never match postgres, even as a prefix", () => {
    const { updates } = planSlimUpdates(postgresPlannerFixture, "postgres", [
      "postgrest-v16.4-r0",
      "postgres-17.11.0.002-r0",
    ]);

    expect(updates).toEqual([
      {
        kind: "upgrade",
        line: "17",
        branch: "slim-bump/postgres-17",
        title: "chore(stack): bump postgres to 17.11.0.002-r0",
        fromRelease: "17.6.1.168-r1",
        toUpstream: "17.11.0.002",
        toRelease: "17.11.0.002-r0",
      },
    ]);
  });

  test("branch and title carry no -<line> suffix for a service with a single line", () => {
    const { updates } = planSlimUpdates(plannerFixture, "storage", ["storage-v1.74.0-r0"]);

    expect(updates).toEqual([
      {
        kind: "upgrade",
        line: undefined,
        branch: "slim-bump/storage",
        title: "chore(stack): bump storage to v1.74.0-r0",
        fromRelease: "v1.73.0-r0",
        toUpstream: "v1.74.0",
        toRelease: "v1.74.0-r0",
      },
    ]);
  });

  test("rejects an emitted value that fails the anchored patterns, even from a trusted-looking catalog", () => {
    // The catalog's own pinned upstream carries a space here — never written by `refreshCatalogPin`
    // (which validates every field it resolves), but this simulates a corrupted catalog, or a
    // release tag whose upstream portion isn't newline-only-unsafe (`.` already excludes
    // newlines) yet still fails `UPSTREAM_VERSION_PATTERN`. Ruling 6 requires every value the
    // planner emits to be checked, regardless of source.
    const adversarial = `const workloadCatalog = {
  rest: definition(
    "postgrest",
    {
      upstreamVersion: "v16.2 injected",
      revision: 0,
      image: "ghcr.io/supabase/cli/postgrest:v16.2-r0@sha256:2222222222222222222222222222222222222222222222222222222222222",
      natives: {},
    },
    "bin/postgrest",
  ),
};
`;

    expect(() =>
      planSlimUpdates(adversarial, "postgrest", ["postgrest-v16.2 injected-r1"]),
    ).toThrow(InvalidPayloadError);
  });

  test("plans nothing for a service the catalog does not model, and warns about it", () => {
    const { updates, warnings } = planSlimUpdates(plannerFixture, "no-such-service", [
      "no-such-service-v1.0-r0",
    ]);

    expect(updates).toEqual([]);
    expect(warnings).toEqual([
      "::warning ::packages/stack/src/Artifacts.ts has no slim entry for no-such-service; nothing to plan.",
    ]);
  });
});

describe("planUpdatesForService (the plan-updates transport's IO seam)", () => {
  test("an ignored tag alongside a valid update: the valid record comes back, plus a separate warning", async () => {
    const result = await planUpdatesForService({
      catalog: postgresPlannerFixture,
      service: "postgres",
      listReleaseTags: async () => [
        "postgres-17.11.0.002-r0",
        "postgres-18.0.0.001-r0", // ignored: no line 18
      ],
    });

    expect(result.warnings).toEqual([
      "::warning ::postgres 18.0.0.001 is not on a release line packages/stack/src/Artifacts.ts carries for it; ignoring postgres-18.0.0.001-r0.",
    ]);
    expect(result.updates).toEqual([
      {
        kind: "upgrade",
        line: "17",
        branch: "slim-bump/postgres-17",
        title: "chore(stack): bump postgres to 17.11.0.002-r0",
        fromRelease: "17.6.1.168-r1",
        toUpstream: "17.11.0.002",
        toRelease: "17.11.0.002-r0",
      },
    ]);
  });
});

describe("runPlanUpdates (the actual plan-updates CLI mode, not just the pure planner)", () => {
  test("an ignored tag plus a valid update: --output gets exactly the valid record, and the warning reaches stdout", async () => {
    // Real catalog, real "auth" pin — `io.listReleaseTags` is the seam this CLI mode injects, so
    // this exercises its own file/stdout wiring (P1) without a network call.
    const catalog = await Bun.file(CATALOG_PATH).text();
    const pinMatch =
      /definition\(\s*"auth",\s*\{\s*upstreamVersion:\s*"([^"]+)",\s*revision:\s*(\d+)/.exec(
        catalog,
      );
    if (pinMatch === null) throw new Error("auth pin not found in the real catalog");
    const pinnedUpstream = pinMatch[1] as string;
    const pinnedRevision = Number(pinMatch[2]);
    const hotfixRelease = `${pinnedUpstream}-r${pinnedRevision + 1}`;

    const dir = await mkdtemp(join(tmpdir(), "plan-updates-cli-"));
    const outputPath = join(dir, "slim-updates.tsv");
    const logs: string[] = [];
    const originalLog = console.log;
    let content: string;
    try {
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      // No exception reaching past this call is this mode's own success condition — `main()`'s
      // wrapper only calls `process.exit(1)` when `runPlanUpdates` rejects, so resolving here is
      // the in-process analogue of "the exit status is 0".
      await runPlanUpdates(["--service", "auth", "--format", "lines", "--output", outputPath], {
        listReleaseTags: async () => [
          `auth-${hotfixRelease}`,
          `auth-${pinnedUpstream}-orioledb-r0`, // ignored: not a comparable version
        ],
      });
      content = await readFile(outputPath, "utf8");
    } finally {
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }

    expect(logs).toEqual([
      `::warning ::auth ${pinnedUpstream}-orioledb is not a comparable version; ignoring.`,
    ]);
    expect(content).toBe(
      `hotfix\x1fslim-hotfix/auth\x1fchore(stack): pin auth ${hotfixRelease}\x1f${hotfixRelease}\x1f${pinnedUpstream}-r${pinnedRevision}\n`,
    );
  });

  test("a missing --output exits non-zero before any network call", async () => {
    const proc = Bun.spawn(
      ["bun", ".github/scripts/sync-artifacts-catalog.ts", "plan-updates", "--service", "auth"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      "Usage: sync-artifacts-catalog.ts plan-updates --service <service> --output <path>",
    );
  });
});

describe("refreshCatalogPin", () => {
  test("refreshes a service to the highest revision of its currently pinned upstream", async () => {
    const digests = nativeDigests("g");
    const io: RevisionIo = {
      listReleaseTags: async () => ["analytics-v1.50.9-r0", "analytics-v1.50.9-r1"],
      fetchChecksums: async () => checksumsFor("analytics", "v1.50.9-r1", digests),
      imageDigest: async () => digest("h"),
      s3Sha256: matchingS3("analytics", "v1.50.9-r1", digests),
    };

    const result = await refreshCatalogPin({ catalog: fixture, service: "analytics", io });

    expect(result.update).toEqual({
      service: "analytics",
      version: "v1.50.9",
      revision: 1,
      previousVersion: "v1.50.9",
      target: "default",
    });
    expect(result.source).toContain("revision: 1");
    expect(result.source).toContain(
      `image: "ghcr.io/supabase/cli/analytics:v1.50.9-r1@${digest("h")}"`,
    );
  });

  test("a resolved pin survives real formatting and can be refreshed again", async () => {
    const first = nativeDigests("i");
    const firstIo: RevisionIo = {
      listReleaseTags: async () => ["postgrest-v16.2-r0"],
      fetchChecksums: async () => checksumsFor("postgrest", "v16.2-r0", first),
      imageDigest: async () => digest("j"),
      s3Sha256: matchingS3("postgrest", "v16.2-r0", first),
    };
    const written = await refreshCatalogPin({
      catalog: fixture,
      service: "postgrest",
      io: firstIo,
    });
    expect(written.update?.revision).toBe(0);

    const formatted = await formatWithOxfmt(written.source);
    // The formatter actually wrapped the literal onto several lines with trailing commas;
    // otherwise this test would not be exercising what it claims to.
    expect(formatted.split("\n").length).toBeGreaterThan(written.source.split("\n").length);

    const second = nativeDigests("k");
    const secondIo: RevisionIo = {
      listReleaseTags: async () => ["postgrest-v16.2-r0", "postgrest-v16.2-r1"],
      fetchChecksums: async () => checksumsFor("postgrest", "v16.2-r1", second),
      imageDigest: async () => digest("l"),
      s3Sha256: matchingS3("postgrest", "v16.2-r1", second),
    };
    const refreshed = await refreshCatalogPin({
      catalog: formatted,
      service: "postgrest",
      io: secondIo,
    });

    expect(refreshed.update).toEqual({
      service: "postgrest",
      version: "v16.2",
      revision: 1,
      previousVersion: "v16.2",
      target: "default",
    });
    expect(refreshed.source).toContain("revision: 1");
    expect(refreshed.source).toContain(second["darwin-arm64"].archive);
  });

  test("refreshes the Postgres 15 additional pin, including after formatting", async () => {
    const digests = nativeDigests("m");
    const io: RevisionIo = {
      listReleaseTags: async () => ["postgres-15.14.1.168-r0"],
      fetchChecksums: async () => checksumsFor("postgres", "15.14.1.168-r0", digests),
      imageDigest: async () => digest("n"),
      s3Sha256: matchingS3("postgres", "15.14.1.168-r0", digests),
    };

    const written = await refreshCatalogPin({
      catalog: fixture,
      service: "postgres",
      upstream: "15.14.1.168",
      io,
    });
    expect(written.update).toEqual({
      service: "postgres",
      version: "15.14.1.168",
      revision: 0,
      previousVersion: "15.14.1.168",
      target: "additional",
    });
    // The default (17.x) postgres line is untouched.
    expect(written.source).toContain('placeholderPin("postgres", "17.6.1.168")');

    const formatted = await formatWithOxfmt(written.source);
    const nextDigests = nativeDigests("o");
    const nextIo: RevisionIo = {
      listReleaseTags: async () => ["postgres-15.14.1.168-r0", "postgres-15.14.1.168-r1"],
      fetchChecksums: async () => checksumsFor("postgres", "15.14.1.168-r1", nextDigests),
      imageDigest: async () => digest("p"),
      s3Sha256: matchingS3("postgres", "15.14.1.168-r1", nextDigests),
    };

    const refreshed = await refreshCatalogPin({
      catalog: formatted,
      service: "postgres",
      upstream: "15.14.1.168",
      io: nextIo,
    });

    expect(refreshed.update).toEqual({
      service: "postgres",
      version: "15.14.1.168",
      revision: 1,
      previousVersion: "15.14.1.168",
      target: "additional",
    });
    expect(refreshed.source).toContain('placeholderPin("postgres", "17.6.1.168")');
    expect(refreshed.source).toContain(nextDigests["linux-arm64"].manifest);
  });

  test("moves the Postgres 15 additional pin to a new upstream version, updating its key", async () => {
    const digests = nativeDigests("u");
    const io: RevisionIo = {
      listReleaseTags: async () => ["postgres-15.19.0.002-r0"],
      fetchChecksums: async () => checksumsFor("postgres", "15.19.0.002-r0", digests),
      imageDigest: async () => digest("v"),
      s3Sha256: matchingS3("postgres", "15.19.0.002-r0", digests),
    };

    const written = await refreshCatalogPin({
      catalog: fixture,
      service: "postgres",
      upstream: "15.19.0.002",
      io,
    });
    expect(written.update).toEqual({
      service: "postgres",
      version: "15.19.0.002",
      revision: 0,
      previousVersion: "15.14.1.168",
      target: "additional",
    });
    // The old key is gone; the new key matches the resolved pin's `upstreamVersion`.
    expect(written.source).not.toContain('"15.14.1.168"');
    expect(written.source).toContain('"15.19.0.002": { upstreamVersion: "15.19.0.002"');
    // The default (17.x) postgres line is untouched.
    expect(written.source).toContain('placeholderPin("postgres", "17.6.1.168")');

    // The renamed key resolves the entry again after real formatting, e.g. for a later hotfix.
    const formatted = await formatWithOxfmt(written.source);
    const nextDigests = nativeDigests("w");
    const nextIo: RevisionIo = {
      listReleaseTags: async () => ["postgres-15.19.0.002-r0", "postgres-15.19.0.002-r1"],
      fetchChecksums: async () => checksumsFor("postgres", "15.19.0.002-r1", nextDigests),
      imageDigest: async () => digest("x"),
      s3Sha256: matchingS3("postgres", "15.19.0.002-r1", nextDigests),
    };
    const refreshed = await refreshCatalogPin({
      catalog: formatted,
      service: "postgres",
      upstream: "15.19.0.002",
      io: nextIo,
    });

    expect(refreshed.update).toEqual({
      service: "postgres",
      version: "15.19.0.002",
      revision: 1,
      previousVersion: "15.19.0.002",
      target: "additional",
    });
    expect(refreshed.source).toContain(nextDigests["linux-arm64"].manifest);
  });
});

describe("refreshCatalogPin --release", () => {
  test("pins exactly the requested committed release, not the highest one", async () => {
    const digests = nativeDigests("release-0");
    const io: RevisionIo = {
      listReleaseTags: async () => ["postgrest-v16.2-r0", "postgrest-v16.2-r1"],
      fetchChecksums: async () => checksumsFor("postgrest", "v16.2-r0", digests),
      imageDigest: async () => digest("release-digest-0"),
      s3Sha256: matchingS3("postgrest", "v16.2-r0", digests),
    };

    const result = await refreshCatalogPin({
      catalog: fixture,
      service: "postgrest",
      release: "v16.2-r0",
      io,
    });

    expect(result.update).toEqual({
      service: "postgrest",
      version: "v16.2",
      revision: 0,
      previousVersion: "v16.2",
      target: "default",
    });
  });

  test("fails when the requested release is not committed", async () => {
    const io: RevisionIo = {
      listReleaseTags: async () => ["postgrest-v16.2-r0"],
      fetchChecksums: async () => undefined,
      imageDigest: async () => undefined,
      s3Sha256: async () => undefined,
    };

    await expect(
      refreshCatalogPin({ catalog: fixture, service: "postgrest", release: "v16.2-r1", io }),
    ).rejects.toThrow(InvalidPayloadError);
  });

  test("rejects --upstream and --release given together", async () => {
    const io: RevisionIo = {
      listReleaseTags: async () => [],
      fetchChecksums: async () => undefined,
      imageDigest: async () => undefined,
      s3Sha256: async () => undefined,
    };

    await expect(
      refreshCatalogPin({
        catalog: fixture,
        service: "postgrest",
        upstream: "v16.2",
        release: "v16.2-r0",
        io,
      }),
    ).rejects.toThrow(InvalidPayloadError);
  });
});

describe("refreshCatalogPin backfills upstreamImage", () => {
  test("resolves a derived service's upstreamImage from its per-target manifests", async () => {
    const digests = nativeDigests("y");
    const io: RevisionIo = {
      listReleaseTags: async () => ["analytics-v1.50.9-r0", "analytics-v1.50.9-r1"],
      fetchChecksums: async () => checksumsFor("analytics", "v1.50.9-r1", digests),
      imageDigest: async () => digest("z"),
      s3Sha256: matchingS3("analytics", "v1.50.9-r1", digests),
      fetchManifest: async () => JSON.stringify({ upstream_image: "supabase/logflare:1.50.9" }),
    };

    const result = await refreshCatalogPin({ catalog: fixture, service: "analytics", io });

    expect(result.source).toContain('upstreamImage: "supabase/logflare:1.50.9"');
  });

  test("falls back to source_image when a target's manifest has no upstream_image (image-derived build)", async () => {
    const digests = nativeDigests("aa");
    const io: RevisionIo = {
      listReleaseTags: async () => ["analytics-v1.50.9-r0"],
      fetchChecksums: async () => checksumsFor("analytics", "v1.50.9-r0", digests),
      imageDigest: async () => digest("ab"),
      s3Sha256: matchingS3("analytics", "v1.50.9-r0", digests),
      fetchManifest: async () => JSON.stringify({ source_image: "supabase/logflare:1.50.9" }),
    };

    const result = await refreshCatalogPin({ catalog: fixture, service: "analytics", io });

    expect(result.source).toContain('upstreamImage: "supabase/logflare:1.50.9"');
  });

  test("strips a docker.io prefix and a digest from the resolved upstreamImage", async () => {
    const digests = nativeDigests("ac");
    const io: RevisionIo = {
      listReleaseTags: async () => ["analytics-v1.50.9-r0"],
      fetchChecksums: async () => checksumsFor("analytics", "v1.50.9-r0", digests),
      imageDigest: async () => digest("ad"),
      s3Sha256: matchingS3("analytics", "v1.50.9-r0", digests),
      fetchManifest: async () =>
        JSON.stringify({ upstream_image: "docker.io/supabase/logflare:1.50.9@sha256:deadbeef" }),
    };

    const result = await refreshCatalogPin({ catalog: fixture, service: "analytics", io });

    expect(result.source).toContain('upstreamImage: "supabase/logflare:1.50.9"');
  });

  test("fails loudly when a derived service's manifests disagree across native targets", async () => {
    const digests = nativeDigests("ae");
    let call = 0;
    const io: RevisionIo = {
      listReleaseTags: async () => ["analytics-v1.50.9-r0"],
      fetchChecksums: async () => checksumsFor("analytics", "v1.50.9-r0", digests),
      imageDigest: async () => digest("af"),
      s3Sha256: matchingS3("analytics", "v1.50.9-r0", digests),
      fetchManifest: async () => {
        call += 1;
        return JSON.stringify({ upstream_image: `supabase/logflare:1.50.${call}` });
      },
    };

    await expect(refreshCatalogPin({ catalog: fixture, service: "analytics", io })).rejects.toThrow(
      /manifests disagree/,
    );
  });

  test("resolves a mirrored service's upstreamImage from its oci-provenance source", async () => {
    const digests = nativeDigests("ag");
    const io: RevisionIo = {
      listReleaseTags: async () => ["vector-0.53.0-r0"],
      fetchChecksums: async () => checksumsFor("vector", "0.53.0-r0", digests),
      imageDigest: async () => digest("ah"),
      s3Sha256: matchingS3("vector", "0.53.0-r0", digests),
      fetchProvenance: async () =>
        JSON.stringify({ source: "docker.io/timberio/vector:0.53.0-alpine" }),
    };

    const result = await refreshCatalogPin({ catalog: vectorFixture, service: "vector", io });

    expect(result.source).toContain('upstreamImage: "timberio/vector:0.53.0-alpine"');
  });

  test("leaves upstreamImage absent when io has no manifest/provenance fetchers", async () => {
    const digests = nativeDigests("ai");
    const io: RevisionIo = {
      listReleaseTags: async () => ["analytics-v1.50.9-r0"],
      fetchChecksums: async () => checksumsFor("analytics", "v1.50.9-r0", digests),
      imageDigest: async () => digest("aj"),
      s3Sha256: matchingS3("analytics", "v1.50.9-r0", digests),
    };

    const result = await refreshCatalogPin({ catalog: fixture, service: "analytics", io });

    expect(result.source).not.toContain("upstreamImage");
  });

  test("rejects a manifest upstream_image carrying a quote or template expression, writing nothing", async () => {
    const digests = nativeDigests("ak");
    const io: RevisionIo = {
      listReleaseTags: async () => ["analytics-v1.50.9-r0"],
      fetchChecksums: async () => checksumsFor("analytics", "v1.50.9-r0", digests),
      imageDigest: async () => digest("al"),
      s3Sha256: matchingS3("analytics", "v1.50.9-r0", digests),
      fetchManifest: async () =>
        JSON.stringify({ upstream_image: 'supabase/logflare:1.50.9"] }; import("evil"); //' }),
    };

    await expect(refreshCatalogPin({ catalog: fixture, service: "analytics", io })).rejects.toThrow(
      InvalidPayloadError,
    );
  });
});

describe("against the real catalog", () => {
  test("a real catalog entry survives real formatting and can be refreshed again", async () => {
    const catalog = await Bun.file(CATALOG_PATH).text();
    const pinnedVersion = /definition\(\s*"auth",\s*\{\s*upstreamVersion:\s*"([^"]+)"/.exec(
      catalog,
    )?.[1];
    if (pinnedVersion === undefined) throw new Error("auth pin not found in the real catalog");

    const first = nativeDigests("q");
    const firstIo: RevisionIo = {
      listReleaseTags: async () => [`auth-${pinnedVersion}-r0`],
      fetchChecksums: async () => checksumsFor("auth", `${pinnedVersion}-r0`, first),
      imageDigest: async () => digest("r"),
      s3Sha256: matchingS3("auth", `${pinnedVersion}-r0`, first),
    };
    const written = await refreshCatalogPin({ catalog, service: "auth", io: firstIo });
    expect(written.update?.revision).toBe(0);

    const formatted = await formatWithOxfmt(written.source);
    expect(formatted).toContain(`upstreamVersion: "${pinnedVersion}"`);

    const second = nativeDigests("s");
    const secondIo: RevisionIo = {
      listReleaseTags: async () => [`auth-${pinnedVersion}-r0`, `auth-${pinnedVersion}-r1`],
      fetchChecksums: async () => checksumsFor("auth", `${pinnedVersion}-r1`, second),
      imageDigest: async () => digest("t"),
      s3Sha256: matchingS3("auth", `${pinnedVersion}-r1`, second),
    };
    const refreshed = await refreshCatalogPin({
      catalog: formatted,
      service: "auth",
      io: secondIo,
    });

    expect(refreshed.update).toEqual({
      service: "auth",
      version: pinnedVersion,
      revision: 1,
      previousVersion: pinnedVersion,
      target: "default",
    });
    expect(refreshed.source).toContain("revision: 1");
    expect(refreshed.source).toContain(second["darwin-arm64"].manifest);
  });
});
