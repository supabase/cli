import { SupabaseApiClient, v1ListAllBranches } from "@supabase/api/effect";
import { Effect, Option } from "effect";
import {
  ProjectLinkState,
  ProjectNotLinkedError,
} from "../../../config/project-link-state.service.ts";
import { Output } from "../../../output/output.service.ts";
import { formatTableRow, outputTable } from "../../../output/table.ts";
import { formatUtcDate, formatUtcTime } from "../../../output/time.ts";

export const list = Effect.fn("branches.list")(function* () {
  const output = yield* Output;
  const projectLinkState = yield* ProjectLinkState;
  const apiClient = yield* SupabaseApiClient;

  yield* output.intro("List branches");

  const maybeLinkState = yield* projectLinkState.load;
  if (Option.isNone(maybeLinkState)) {
    return yield* Effect.fail(
      new ProjectNotLinkedError({
        detail: "No project is linked in this directory.",
        suggestion: "Run `supabase link` first.",
      }),
    );
  }

  const { project, active_branch } = maybeLinkState.value;
  const fetching = yield* output.task("Fetching branches...");
  const branches = yield* v1ListAllBranches({ ref: project.ref }).pipe(
    Effect.provideService(SupabaseApiClient, apiClient),
    Effect.tapError(() => fetching.fail()),
  );
  yield* fetching.clear();
  const annotated = branches.map((b) => ({ ...b, active: b.project_ref === active_branch.ref }));

  if (output.format !== "text") {
    yield* output.success("Branches", { branches: annotated });
    return;
  }

  if (branches.length === 0) {
    yield* output.outro("No branches found.");
    return;
  }

  const HEADERS = ["ID", "NAME", "DEFAULT", "GIT BRANCH", "STATUS", "CREATED AT (UTC)"];

  yield* outputTable(
    HEADERS,
    annotated,
    (branch) => [
      branch.project_ref,
      branch.active ? `${branch.name} (active)` : branch.name,
      branch.is_default ? "true" : "false",
      branch.git_branch ?? "",
      branch.status,
      formatUtcDate(branch.created_at),
    ],
    (cells, widths, branch) => {
      const timeIndent = widths.slice(0, -1).reduce((sum, w) => sum + w + 2, 0);
      return (
        formatTableRow(cells, widths) +
        "\n" +
        " ".repeat(timeIndent) +
        formatUtcTime(branch.created_at)
      );
    },
  );
  yield* output.outro(`Found ${branches.length} branch${branches.length === 1 ? "" : "es"}.`);
});
