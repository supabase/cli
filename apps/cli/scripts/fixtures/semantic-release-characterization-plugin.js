import { analyzeCommits as analyzeTitles } from "../analyze-commits-title.js";
import {
  filterCommitsToPackage,
  generateNotes as generateConfigNotes,
} from "../../../../packages/config/scripts/semantic-release-path-filter.ts";

async function selectedCommits(pluginConfig, context) {
  return pluginConfig.train === "config"
    ? filterCommitsToPackage(context.commits, context.cwd)
    : context.commits;
}

export async function analyzeCommits(pluginConfig, context) {
  const commits = await selectedCommits(pluginConfig, context);
  return analyzeTitles(pluginConfig, { ...context, commits });
}

export async function generateNotes(pluginConfig, context) {
  if (pluginConfig.train === "config") {
    return generateConfigNotes(pluginConfig, context);
  }

  return context.commits.map(({ message }) => `- ${message.split(/\r?\n/, 1)[0]}`).join("\n");
}
