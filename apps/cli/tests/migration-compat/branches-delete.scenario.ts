import type { Scenario } from "./scenario.ts";

const branch = "11111111-1111-4111-8111-111111111111";
const parent = "abcdefghijklmnopqrst";

export const branchesDelete = {
  name: "branches-delete",
  argv: [
    "branches",
    "delete",
    branch,
    `--remote=${parent}`,
    "--output-format",
    "<format>",
    "--yes",
  ],
  cases: (["json", "stream-json"] as const).flatMap((format) =>
    ([200, 500] as const).map((status) => ({
      name: `${format}/${status}`,
      format,
      exitCode: status === 200 ? 0 : 1,
      routes: {
        [`GET /v1/branches/${branch}`]: {
          body: {
            ref: branch,
            postgres_version: "15",
            postgres_engine: "15",
            release_channel: "ga",
            status: "ACTIVE_HEALTHY",
            db_host: "h",
            db_port: 5432,
          },
        },
        [`GET /v1/projects/${parent}`]: {
          body: {
            id: parent,
            ref: parent,
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
          },
        },
        [`DELETE /v1/branches/${branch}`]: {
          status,
          body: status === 200 ? { message: "ok" } : {},
          required: true,
        },
      },
    })),
  ),
} satisfies Scenario;
