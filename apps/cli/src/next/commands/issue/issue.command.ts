import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { browserLayer } from "../../../shared/runtime/browser.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { openBugIssue, openDocsIssue, openFeatureIssue } from "./issue.handler.ts";

const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Print the issue form URL without opening a browser"),
);

const optionalTextFlag = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.withDescription(description), Flag.optional);

const commonContextFlag = optionalTextFlag(
  "additional-context",
  "Extra context to prefill on the issue form",
);

const bugFlags = {
  area: optionalTextFlag("area", "Affected CLI area"),
  command: optionalTextFlag("command", "Command that failed"),
  actualOutput: optionalTextFlag("actual-output", "Actual output or error text"),
  expectedBehavior: optionalTextFlag("expected-behavior", "Expected behavior"),
  reproduce: optionalTextFlag("reproduce", "Steps to reproduce"),
  crashReportId: optionalTextFlag("crash-report-id", "Crash report ID printed by --create-ticket"),
  dockerServices: optionalTextFlag("docker-services", "Relevant Docker service status or logs"),
  additionalContext: commonContextFlag,
  noBrowser: noBrowserFlag,
} as const;

const featureFlags = {
  existingIssues: Flag.boolean("existing-issues").pipe(
    Flag.withDescription("Prefill the existing issues checklist"),
  ),
  area: optionalTextFlag("area", "Affected CLI area"),
  problem: optionalTextFlag("problem", "Problem the feature should solve"),
  proposedSolution: optionalTextFlag("proposed-solution", "Proposed solution"),
  alternatives: optionalTextFlag("alternatives", "Alternatives considered"),
  additionalContext: commonContextFlag,
  noBrowser: noBrowserFlag,
} as const;

const docsFlags = {
  link: optionalTextFlag("link", "Relevant documentation link"),
  issueType: optionalTextFlag("issue-type", "Documentation issue type"),
  problem: optionalTextFlag("problem", "What is confusing, missing, or incorrect"),
  improvement: optionalTextFlag("improvement", "Suggested documentation improvement"),
  additionalContext: commonContextFlag,
  noBrowser: noBrowserFlag,
} as const;

export type BugIssueFlags = CliCommand.Command.Config.Infer<typeof bugFlags>;
export type FeatureIssueFlags = CliCommand.Command.Config.Infer<typeof featureFlags>;
export type DocsIssueFlags = CliCommand.Command.Config.Infer<typeof docsFlags>;

const bugIssueCommand = Command.make("bug", bugFlags).pipe(
  Command.withDescription("Open a GitHub bug report with local CLI details prefilled."),
  Command.withShortDescription("Open a bug report"),
  Command.withExamples([
    {
      command:
        'supabase issue bug --command "supabase start" --actual-output "database failed to start"',
      description: "Open a prefilled bug report for a failing command",
    },
    {
      command: 'supabase issue bug --crash-report-id "abc123" --no-browser',
      description: "Print a prefilled issue URL with a crash report ID",
    },
  ]),
  Command.withHandler((flags) =>
    openBugIssue(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["issue", "bug"])),
  Command.provide(browserLayer),
);

const featureIssueCommand = Command.make("feature", featureFlags).pipe(
  Command.withDescription("Open a GitHub feature request with useful context prefilled."),
  Command.withShortDescription("Open a feature request"),
  Command.withExamples([
    {
      command:
        'supabase issue feature --problem "I need to rotate local secrets" --proposed-solution "Add a secrets rotate command"',
      description: "Open a prefilled feature request",
    },
  ]),
  Command.withHandler((flags) =>
    openFeatureIssue(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["issue", "feature"])),
  Command.provide(browserLayer),
);

const docsIssueCommand = Command.make("docs", docsFlags).pipe(
  Command.withDescription("Open a GitHub documentation issue with useful context prefilled."),
  Command.withShortDescription("Open a documentation issue"),
  Command.withExamples([
    {
      command:
        'supabase issue docs --link "https://supabase.com/docs/guides/cli" --problem "The flag description is outdated"',
      description: "Open a prefilled documentation issue",
    },
  ]),
  Command.withHandler((flags) =>
    openDocsIssue(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["issue", "docs"])),
  Command.provide(browserLayer),
);

export const issueCommand = Command.make("issue").pipe(
  Command.withDescription("Open Supabase CLI GitHub issue forms."),
  Command.withShortDescription("Open GitHub issue forms"),
  Command.withSubcommands([bugIssueCommand, featureIssueCommand, docsIssueCommand]),
);
