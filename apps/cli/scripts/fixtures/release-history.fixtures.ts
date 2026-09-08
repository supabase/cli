export const TRAINS = [
  { train: "cli", legacyPrefix: "v", namespace: "cli@" },
  { train: "config", legacyPrefix: "config-v", namespace: "config@" },
] as const;

export const HISTORICAL_INTERVALS = [
  {
    name: "CLI v2.116.0 to the first v2.117.0 beta",
    train: "cli",
    version: "2.116.0",
    commits: [
      { message: "feat(cli): add supabase workers new (#6261)", path: "apps/cli/workers-new.ts" },
      { message: "chore(repo): migrate live tasks to Turborepo (#6343)", path: "turbo.json" },
    ],
    currentVersion: "2.117.0-beta.1",
    hybridVersion: "2.117.0-beta.1",
  },
  {
    name: "config-v0.1.0 to config-v0.1.1",
    train: "config",
    version: "0.1.0",
    commits: [
      {
        message: "fix(deps): bump the npm-major group across 1 directory with 28 updates (#6430)",
        path: "packages/config/package.json",
      },
    ],
    currentVersion: "0.1.1",
    hybridVersion: "0.1.1-beta.1",
  },
  {
    name: "config-v0.1.1 to config-v0.2.0",
    train: "config",
    version: "0.1.1",
    commits: [
      {
        message: "feat(cli): add config diff command (#6295)",
        path: "packages/config/src/config-diff.ts",
      },
      {
        message: "ci(config): add Slack notifications to the config release pipeline (#6436)",
        path: ".github/workflows/release-config.yml",
      },
    ],
    currentVersion: "0.2.0",
    hybridVersion: "0.2.0-beta.1",
  },
] as const;
