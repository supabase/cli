const titlePattern = /^(?<type>\w+)(?:\((?<scope>.*)\))?(?<breaking>!)?: (.*)$/;

const releaseRank = {
  patch: 1,
  minor: 2,
  major: 3,
};

function highestRelease(current, candidate) {
  if (!current || releaseRank[candidate] > releaseRank[current]) {
    return candidate;
  }

  return current;
}

export function analyzeCommits(_pluginConfig, context) {
  let releaseType = null;

  for (const commit of context.commits) {
    const title = typeof commit.message === "string" ? commit.message.split(/\r?\n/, 1)[0] : "";
    if (!title.trim()) {
      context.logger.log("Skipping commit %s with empty title", commit.hash);
      continue;
    }

    context.logger.log("Analyzing commit: %s", title);
    const match = titlePattern.exec(title);
    if (!match) {
      context.logger.log("The commit should not trigger a release");
      continue;
    }

    const { type, breaking } = match.groups;
    const commitReleaseType =
      breaking === "!"
        ? "major"
        : type === "feat" || type === "FEAT"
          ? "minor"
          : type === "fix" || type === "FIX" || type === "perf" || type === "revert"
            ? "patch"
            : null;

    if (!commitReleaseType) {
      context.logger.log("The commit should not trigger a release");
      continue;
    }

    context.logger.log("The release type for the commit is %s", commitReleaseType);
    releaseType = highestRelease(releaseType, commitReleaseType);
    if (releaseType === "major") {
      break;
    }
  }

  context.logger.log(
    "Analysis of %s commits complete: %s release",
    context.commits.length,
    releaseType || "no",
  );

  return releaseType;
}
