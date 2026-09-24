import { describe, expect, test } from "bun:test";

import { InvalidPayloadError } from "./slim-mirror-payload.ts";
import {
  CATALOG_PATH,
  planArtifactCatalogUpdate,
  publicationFrom,
  type ReleasePublication,
} from "./sync-artifacts-catalog.ts";

const DIGEST_B = `sha256:${"b".repeat(64)}`;
const POSTGRES_17 = `ghcr.io/supabase/cli/postgres:17.6.1.168@sha256:${"9".repeat(64)}`;
const POSTGRES_15 = `ghcr.io/supabase/cli/postgres:15.14.1.168@sha256:${"f".repeat(64)}`;

const fixture = `const workloadCatalog = {
  database: definition(
    "postgres",
    "17.6.1.168",
    "${POSTGRES_17}",
    "bin/supabase-postgres-start",
    ["bin/supabase-postgres-start"],
    { "15.14.1.168": "${POSTGRES_15}" },
  ),
  rest: definition("postgrest", "v16.2", "ghcr.io/supabase/cli/postgrest:v16.2", "bin/postgrest"),
  analytics: definition(
    "analytics",
    "v1.50.9",
    "ghcr.io/supabase/cli/analytics:v1.50.9@sha256:${"a".repeat(64)}",
    "bin/logflare",
  ),
};
`;

const published = (digest?: string): ReleasePublication => ({ status: "published", digest });

describe("planArtifactCatalogUpdate", () => {
  test("pins Dockerfile tags that changed and leaves the other postgres line", async () => {
    const plan = await planArtifactCatalogUpdate({
      baseDockerfile: `FROM supabase/postgres:17.6.1.168 AS pg
FROM postgrest/postgrest:v16.2 AS postgrest
FROM supabase/logflare:1.50.9 AS logflare
`,
      dockerfile: `FROM supabase/postgres:17.6.1.171 AS pg
FROM library/kong:2.8.1 AS kong
FROM postgrest/postgrest:v16.3 AS postgrest
FROM supabase/logflare:1.50.9 AS logflare
`,
      catalog: fixture,
      publication: async (service) => published(service === "postgres" ? DIGEST_B : undefined),
    });

    expect(plan.updates.map((update) => `${update.service} ${update.version}`)).toEqual([
      "postgres 17.6.1.171",
      "postgrest v16.3",
    ]);
    expect(plan.source).toContain(`"ghcr.io/supabase/cli/postgres:17.6.1.171@${DIGEST_B}"`);
    expect(plan.source).toContain(`"${POSTGRES_15}"`);
    expect(plan.source).toContain(`"ghcr.io/supabase/cli/postgrest:v16.3"`);
    expect(plan.source).toContain(`"v1.50.9"`);
    expect(plan.skipped).toEqual([]);
  });

  test("a missing release blocks the commit and OrioleDB does not", async () => {
    const movesPostgres = await planArtifactCatalogUpdate({
      baseDockerfile: "FROM supabase/postgres:17.6.1.168 AS pg\n",
      dockerfile: `FROM supabase/postgres:17.6.1.171 AS pg
FROM postgrest/postgrest:v16.3 AS postgrest
`,
      catalog: fixture,
      publication: async () => ({ status: "missing" }),
    });
    expect(movesPostgres.updates).toEqual([]);
    expect(movesPostgres.source).toBe(fixture);
    expect(movesPostgres.skipped.every((skip) => skip.blocking)).toBe(true);

    const oriole = await planArtifactCatalogUpdate({
      baseDockerfile:
        "FROM supabase/postgres:17.6.1.168 AS pg\nFROM postgrest/postgrest:v16.2 AS postgrest\n",
      dockerfile: `FROM supabase/postgres:16.0.0.1-orioledb AS pg
FROM postgrest/postgrest:v16.3 AS postgrest
`,
      catalog: fixture,
      publication: async () => published(),
    });
    expect(oriole.updates.map((update) => update.service)).toEqual(["postgrest"]);
    expect(oriole.skipped).toEqual([
      {
        alias: "pg",
        reason: "pg supabase/postgres:16.0.0.1-orioledb has no slim image.",
        blocking: false,
      },
    ]);
    expect(oriole.source).toContain(`"${POSTGRES_17}"`);
  });

  test("an image the ECR mirror does not serve under the GHCR digest blocks the commit", async () => {
    const plan = await planArtifactCatalogUpdate({
      baseDockerfile: "FROM supabase/postgres:17.6.1.168 AS pg\n",
      dockerfile: "FROM supabase/postgres:17.6.1.171 AS pg\n",
      catalog: fixture,
      publication: async () => ({ status: "unmirrored" }),
    });
    expect(plan.source).toBe(fixture);
    expect(plan.skipped).toEqual([
      {
        alias: "pg",
        reason: "postgres:17.6.1.171 is not on public.ecr.aws/supabase/cli under the GHCR digest.",
        blocking: true,
      },
    ]);
  });

  test("refuses a backward pin and a tag that would escape the catalog string", async () => {
    const backward = await planArtifactCatalogUpdate({
      baseDockerfile: "FROM supabase/postgres:17.6.1.170 AS pg\n",
      dockerfile: "FROM supabase/postgres:17.6.1.171 AS pg\n",
      catalog: fixture.replaceAll("17.6.1.168", "17.6.1.173"),
      publication: async () => {
        throw new Error("publication lookup");
      },
    });
    expect(backward.updates).toEqual([]);
    expect(backward.skipped.map((skip) => skip.blocking)).toEqual([true]);
    expect(backward.source).toContain(`"17.6.1.173"`);

    await expect(
      planArtifactCatalogUpdate({
        dockerfile: 'FROM supabase/gotrue:v1" AS gotrue\n',
        catalog: fixture,
        publication: async () => published(),
      }),
    ).rejects.toThrow(InvalidPayloadError);
  });
});

describe("publicationFrom", () => {
  const ghcr = { probe: "published", digest: DIGEST_B } as const;

  test("publishes only when the ECR Public mirror serves the GHCR digest", () => {
    expect(publicationFrom({ manifest: ghcr, mirror: ghcr, native: "published" })).toEqual(
      published(DIGEST_B),
    );
    expect(
      publicationFrom({ manifest: ghcr, mirror: { probe: "missing" }, native: "published" }),
    ).toEqual({ status: "unmirrored" });
    expect(
      publicationFrom({
        manifest: ghcr,
        mirror: { probe: "published", digest: `sha256:${"c".repeat(64)}` },
        native: "published",
      }),
    ).toEqual({ status: "unmirrored" });
    expect(
      publicationFrom({ manifest: ghcr, mirror: { probe: "lookup-failed" }, native: "published" }),
    ).toEqual({ status: "lookup-failed" });
  });
});

describe("against the real catalog", () => {
  test("every slim Dockerfile alias is a catalog entry", async () => {
    const dockerfile = await Bun.file("apps/cli/src/shared/services/Dockerfile").text();
    const catalog = await Bun.file(CATALOG_PATH).text();
    const plan = await planArtifactCatalogUpdate({
      dockerfile,
      catalog,
      publication: async () => published(`sha256:${"a".repeat(64)}`),
    });

    expect(
      plan.skipped.filter((skip) => skip.blocking && !skip.reason.includes("older than")),
    ).toEqual([]);
  });
});
