export const TRAINS = [
  { train: "cli", legacyPrefix: "v", namespace: "cli@" },
  { train: "config", legacyPrefix: "config-v", namespace: "config@" },
] as const;

// Each path is taken from the source commit and preserves whether that commit is
// selected for the release train. The integration harness records the generated
// commit SHA against sourceSha so it can assert the exact historical ordering.
export const HISTORICAL_INTERVALS = [
  {
    name: "CLI v2.116.0 to the first v2.117.0 beta",
    train: "cli",
    version: "2.116.0",
    commits: [
      {
        sourceSha: "b4a91990b6ca4451a43056c8bdb45689ea79afd7",
        message: "feat(cli): add supabase workers new (#6261)",
        path: "apps/cli/src/legacy/cli/root.ts",
        selected: true,
      },
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
        sourceSha: "085e5a87579d7f54f4205f87666e71b390edc4f6",
        message: "chore: sync API types from infrastructure (#6428)",
        path: "apps/cli-go/pkg/api/types.gen.go",
        selected: false,
      },
      {
        sourceSha: "d345d942f26703657d2c9b0e5a497a19a9e44d3c",
        message: "fix(deps): bump the go-minor group across 2 directories with 3 updates (#6429)",
        path: "apps/cli-go/go.mod",
        selected: false,
      },
      {
        sourceSha: "4fe9c9da59b6b2cfe3cfde167ae9c959a279e03d",
        message: "chore(codeql): resolve deploy scan findings (#6433)",
        path: "apps/cli/src/shared/functions/serve.main.ts",
        selected: false,
      },
      {
        sourceSha: "44f463a78f6c4e15729653aeaa34063ec52627b5",
        message: "fix(deps): bump the npm-major group across 1 directory with 28 updates (#6430)",
        path: "packages/config/package.json",
        selected: true,
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
        sourceSha: "430d5ede9f76590ae5f2e12a5e4a53b82eecdf5a",
        message: "fix(cli): warn when PowerShell mangles piped dumps (#6418)",
        path: "apps/cli/src/shared/runtime/tty.layer.ts",
        selected: false,
      },
      {
        sourceSha: "2ce71c8de4e495b3b28729fcbffcd4c60cb6a3b0",
        message: "chore: sync API types from infrastructure (#6434)",
        path: "apps/cli-go/pkg/api/types.gen.go",
        selected: false,
      },
      {
        sourceSha: "adbbe1605797eb2b9a8fd73e0d8ed972634b3edc",
        message: "fix(config): align pgdelta format_options example with the 180 default (#6435)",
        path: "packages/config/src/experimental.ts",
        selected: true,
      },
      {
        sourceSha: "ed48f6667c6757bcb5267cdb4eadb6d5e32ef9da",
        message: "test(cli): cover db query, lint and advisors (CLI-1949) (#6420)",
        path: "apps/cli/src/legacy/commands/db/query/query.live.test.ts",
        selected: false,
      },
      {
        sourceSha: "db1856d6c22781ced1cc8cac915b840702ef6578",
        message: "test(cli): cover postgres-config get, update and delete (CLI-2271) (#6427)",
        path: "apps/cli/src/legacy/commands/postgres-config/get/get.live.test.ts",
        selected: false,
      },
      {
        sourceSha: "6b85fba64f0224de609ee109ff7b1519d2965632",
        message: "feat(cli): add config diff command (#6295)",
        path: "packages/config/src/config-diff.ts",
        selected: true,
      },
      {
        sourceSha: "08103c023b8bef74aab01231a9df90c1d87faeaf",
        message: "fix(cli): skip provisioned ledger ddl (CLI-2275) (#6422)",
        path: "apps/cli/src/legacy/shared/legacy-migration-history.ts",
        selected: false,
      },
      {
        sourceSha: "1b482f4de9d3680d89cb811f52813bc98ca139dd",
        message: "ci(config): add Slack notifications to the config release pipeline (#6436)",
        path: "packages/config/AGENTS.md",
        selected: true,
      },
    ],
    currentVersion: "0.2.0",
    hybridVersion: "0.2.0-beta.1",
  },
] as const;
