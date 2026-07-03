const repository = process.env.RENOVATE_REPOSITORY;

module.exports = {
  // postUpgradeTasks can execute commands only when the self-hosted runner
  // allowlists them globally. Keep this as narrow as the generated file sync.
  allowedCommands: ["^bun packages/stack/scripts/sync-versions-from-dockerfile\\.ts$"],
  onboarding: false,
  platform: "github",
  ...(repository === undefined ? {} : { repositories: [repository] }),
  requireConfig: "required",
};
