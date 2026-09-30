import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDockerfileServiceImages } from "../../apps/cli/src/shared/services/parse-dockerfile-service-images.ts";
import { isOrioleImage, slimCatalogPin } from "../../apps/cli/src/shared/services/slim-images.ts";
import { InvalidPayloadError, nativeFileNames, nativeObjectUrl } from "./slim-mirror-payload.ts";
import {
  CATALOG_PATH,
  findHotfixMatches,
  planArtifactCatalogUpdate,
  refreshCatalogPin,
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
 * Runs the repo's pinned `oxfmt` binary over `source`, the way `sync-artifacts-catalog.yml`
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

/** A catalog whose Postgres 15 additional pin is already resolved (not a `placeholderPin`), at `r3`. */
const resolvedFixture = fixture.replace(
  '{ "15.14.1.168": placeholderPin("postgres", "15.14.1.168") },',
  '{ "15.14.1.168": { upstreamVersion: "15.14.1.168", revision: 3, image: "ghcr.io/supabase/cli/postgres:15.14.1.168-r3@sha256:0000000000000000000000000000000000000000000000000000000000000", natives: {} } },',
);

describe("findHotfixMatches", () => {
  test("selects the Postgres 15 entry for a higher revision of the same upstream", () => {
    const matches = findHotfixMatches(resolvedFixture, {
      service: "postgres",
      upstream_version: "15.14.1.168",
      revision: 4,
      release_version: "15.14.1.168-r4",
    });

    expect(matches).toEqual([{ target: "additional", currentRevision: 3 }]);
  });

  test("ignores an equal or lower revision of the same upstream", () => {
    for (const revision of [3, 2]) {
      const matches = findHotfixMatches(resolvedFixture, {
        service: "postgres",
        upstream_version: "15.14.1.168",
        revision,
        release_version: `15.14.1.168-r${revision}`,
      });
      expect(matches).toEqual([]);
    }
  });

  test("ignores a higher revision of a different upstream version", () => {
    const matches = findHotfixMatches(resolvedFixture, {
      service: "postgres",
      upstream_version: "15.14.1.999",
      revision: 4,
      release_version: "15.14.1.999-r4",
    });

    expect(matches).toEqual([]);
  });

  test("matches the default pin too, once it is resolved", () => {
    const withResolvedDefault = resolvedFixture.replace(
      'placeholderPin("postgres", "17.6.1.168")',
      '{ upstreamVersion: "17.6.1.168", revision: 1, image: "ghcr.io/supabase/cli/postgres:17.6.1.168-r1@sha256:1111111111111111111111111111111111111111111111111111111111111", natives: {} }',
    );
    const matches = findHotfixMatches(withResolvedDefault, {
      service: "postgres",
      upstream_version: "17.6.1.168",
      revision: 2,
      release_version: "17.6.1.168-r2",
    });

    expect(matches).toEqual([{ target: "default", currentRevision: 1 }]);
  });

  test("treats an unresolved placeholderPin as always eligible for a hotfix", () => {
    const matches = findHotfixMatches(fixture, {
      service: "postgrest",
      upstream_version: "v16.2",
      revision: 0,
      release_version: "v16.2-r0",
    });

    expect(matches).toEqual([{ target: "default", currentRevision: -1 }]);
  });

  test("survives real oxfmt formatting", async () => {
    const formatted = await formatWithOxfmt(resolvedFixture);
    const matches = findHotfixMatches(formatted, {
      service: "postgres",
      upstream_version: "15.14.1.168",
      revision: 4,
      release_version: "15.14.1.168-r4",
    });

    expect(matches).toEqual([{ target: "additional", currentRevision: 3 }]);
  });
});

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

describe("planArtifactCatalogUpdate", () => {
  test("pins to the highest committed revision, writing every native target's digests", async () => {
    const digests = nativeDigests("c");
    const io: RevisionIo = {
      listReleaseTags: async () => [
        "postgrest-v16.3-r0",
        "postgrest-v16.3-r1",
        "postgrest-v16.3-r2",
        "unrelated-tag",
      ],
      fetchChecksums: async (service, releaseVersion) =>
        service === "postgrest" && releaseVersion === "v16.3-r2"
          ? checksumsFor("postgrest", "v16.3-r2", digests)
          : undefined,
      imageDigest: async () => digest("d"),
      s3Sha256: matchingS3("postgrest", "v16.3-r2", digests),
    };

    const plan = await planArtifactCatalogUpdate({
      baseDockerfile: "FROM postgrest/postgrest:v16.2 AS postgrest\n",
      dockerfile: "FROM postgrest/postgrest:v16.3 AS postgrest\n",
      catalog: fixture,
      io,
    });

    expect(plan.skipped).toEqual([]);
    expect(plan.updates).toEqual([
      {
        service: "postgrest",
        version: "v16.3",
        revision: 2,
        previousVersion: "v16.2",
        target: "default",
      },
    ]);
    expect(plan.source).toContain('upstreamVersion: "v16.3"');
    expect(plan.source).toContain("revision: 2");
    expect(plan.source).toContain(
      `image: "ghcr.io/supabase/cli/postgrest:v16.3-r2@${digest("d")}"`,
    );
    for (const target of NATIVE_TARGETS) {
      expect(plan.source).toContain(`"${target}": { archive: "${digests[target].archive}"`);
      expect(plan.source).toContain(`manifest: "${digests[target].manifest}" }`);
    }
    // The other postgres line is untouched.
    expect(plan.source).toContain('placeholderPin("postgres", "15.14.1.168")');
  });

  test("a legacy release with no -rN tag is a blocking missing pin", async () => {
    const io: RevisionIo = {
      listReleaseTags: async () => ["postgrest-v16.3"],
      fetchChecksums: async () => undefined,
      imageDigest: async () => undefined,
      s3Sha256: async () => undefined,
    };

    const plan = await planArtifactCatalogUpdate({
      baseDockerfile: "FROM postgrest/postgrest:v16.2 AS postgrest\n",
      dockerfile: "FROM postgrest/postgrest:v16.3 AS postgrest\n",
      catalog: fixture,
      io,
    });

    expect(plan.updates).toEqual([]);
    expect(plan.source).toBe(fixture);
    expect(plan.skipped).toEqual([
      {
        alias: "postgrest",
        reason: "postgrest:v16.3 has no published slim-services revision.",
        blocking: true,
      },
    ]);
  });

  test("a longer upstream version's release tag does not satisfy a prefix collision", async () => {
    const io: RevisionIo = {
      // A decoy tag for a different (longer) upstream version must not count as v1.79.2's.
      listReleaseTags: async () => ["storage-v1.79.23-r0"],
      fetchChecksums: async () => undefined,
      imageDigest: async () => undefined,
      s3Sha256: async () => undefined,
    };

    const plan = await planArtifactCatalogUpdate({
      baseDockerfile: "FROM supabase/storage-api:v1.73.0 AS storage\n",
      dockerfile: "FROM supabase/storage-api:v1.79.2 AS storage\n",
      catalog: fixture,
      io,
    });

    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        alias: "storage",
        reason: "storage:v1.79.2 has no published slim-services revision.",
        blocking: true,
      },
    ]);
  });

  test("a stale S3 copy is a blocking error", async () => {
    const digests = nativeDigests("e");
    const io: RevisionIo = {
      listReleaseTags: async () => ["postgrest-v16.3-r0"],
      fetchChecksums: async () => checksumsFor("postgrest", "v16.3-r0", digests),
      imageDigest: async () => digest("f"),
      s3Sha256: async (url) => {
        const files = nativeFileNames("postgrest", "v16.3-r0", "darwin-arm64");
        if (url === nativeObjectUrl("postgrest", "v16.3-r0", files.archive)) return hex("stale");
        return matchingS3("postgrest", "v16.3-r0", digests)(url);
      },
    };

    const plan = await planArtifactCatalogUpdate({
      baseDockerfile: "FROM postgrest/postgrest:v16.2 AS postgrest\n",
      dockerfile: "FROM postgrest/postgrest:v16.3 AS postgrest\n",
      catalog: fixture,
      io,
    });

    expect(plan.updates).toEqual([]);
    expect(plan.source).toBe(fixture);
    expect(plan.skipped).toEqual([
      {
        alias: "postgrest",
        reason: "S3 copy of v16.3-r0 darwin-arm64 is stale; run the slim-services mirror backfill",
        blocking: true,
      },
    ]);
  });

  test("a Dependabot bump older than the catalog pin is a non-blocking, unchanged skip", async () => {
    const ahead = fixture.replace(
      'placeholderPin("postgrest", "v16.2")',
      'placeholderPin("postgrest", "v16.5")',
    );
    const io: RevisionIo = {
      listReleaseTags: async () => {
        throw new Error("should not be reached for an older bump");
      },
      fetchChecksums: async () => undefined,
      imageDigest: async () => undefined,
      s3Sha256: async () => undefined,
    };

    const plan = await planArtifactCatalogUpdate({
      baseDockerfile: "FROM postgrest/postgrest:v16.2 AS postgrest\n",
      dockerfile: "FROM postgrest/postgrest:v16.3 AS postgrest\n",
      catalog: ahead,
      io,
    });

    expect(plan.updates).toEqual([]);
    expect(plan.source).toBe(ahead);
    expect(plan.skipped).toEqual([
      {
        alias: "postgrest",
        reason: "postgrest v16.3 is older than the catalog pin v16.5.",
        blocking: false,
      },
    ]);
    expect(plan.skipped.some((skip) => skip.blocking)).toBe(false);
  });

  test("refuses a tag that would escape the catalog string", async () => {
    await expect(
      planArtifactCatalogUpdate({
        dockerfile: 'FROM supabase/gotrue:v1" AS gotrue\n',
        catalog: fixture,
        io: {
          listReleaseTags: async () => [],
          fetchChecksums: async () => undefined,
          imageDigest: async () => undefined,
          s3Sha256: async () => undefined,
        },
      }),
    ).rejects.toThrow(InvalidPayloadError);
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

describe("against the real catalog", () => {
  test("every slim Dockerfile alias is a catalog entry", async () => {
    const dockerfile = await Bun.file("apps/cli/src/shared/services/Dockerfile").text();
    const catalog = await Bun.file(CATALOG_PATH).text();

    const pins = parseDockerfileServiceImages(dockerfile)
      .filter((from) => !isOrioleImage(from.image))
      .map((from) => slimCatalogPin(from.alias, from.image))
      .filter((pin): pin is NonNullable<typeof pin> => pin !== undefined);

    const resolved = pins.map((pin) => {
      const releaseVersion = `${pin.version}-r0`;
      const digests = nativeDigests(pin.service);
      return {
        service: pin.service,
        releaseVersion,
        checksums: checksumsFor(pin.service, releaseVersion, digests),
        digests,
      };
    });

    const io: RevisionIo = {
      listReleaseTags: async () =>
        resolved.map((entry) => `${entry.service}-${entry.releaseVersion}`),
      fetchChecksums: async (service, releaseVersion) =>
        resolved.find(
          (entry) => entry.service === service && entry.releaseVersion === releaseVersion,
        )?.checksums,
      imageDigest: async () => digest("real"),
      s3Sha256: async (url) => {
        for (const entry of resolved) {
          for (const target of NATIVE_TARGETS) {
            const files = nativeFileNames(entry.service, entry.releaseVersion, target);
            if (url === nativeObjectUrl(entry.service, entry.releaseVersion, files.archive)) {
              return entry.digests[target].archive;
            }
            if (url === nativeObjectUrl(entry.service, entry.releaseVersion, files.manifest)) {
              return entry.digests[target].manifest;
            }
          }
        }
        return undefined;
      },
    };

    const plan = await planArtifactCatalogUpdate({ dockerfile, catalog, io });

    expect(plan.skipped.filter((skip) => skip.blocking)).toEqual([]);
  });

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
