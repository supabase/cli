const PROJECT_SCOPES = [
  "api",
  "cli",
  "cli-e2e",
  "cli-go",
  "cli-test-helpers",
  "config",
  "docs",
  "lib",
  "nx-plugins",
  "process-compose",
  "release",
  "stack",
];

// Non-project changes that don't map to a single turbo project.
const ESCAPE_SCOPES = ["ci", "repo", "misc"];

module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", [...PROJECT_SCOPES, ...ESCAPE_SCOPES]],
  },
};
