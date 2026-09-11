const PROJECT_SCOPES = [
  "api",
  "cli",
  "cli-e2e",
  "cli-go",
  "cli-test-helpers",
  "config",
  "docs",
  "process-compose",
  "stack",
];

// Non-project changes that don't map to a single turbo project. `release`
// isn't a turbo project (tools/release has no package.json) but is a real
// scope emitted by the automated release-notes-proposal commit.
const ESCAPE_SCOPES = ["ci", "deps", "repo", "misc", "release"];

module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", [...PROJECT_SCOPES, ...ESCAPE_SCOPES]],
  },
};
