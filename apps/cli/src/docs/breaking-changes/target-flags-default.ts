import { defineBreakingChange } from "./define.ts";
import migration from "./target-flags-default.md" with { type: "text" };

export const targetFlagsDefault = defineBreakingChange({
  id: "target-flags-default",
  major: 3,
  commands: ["db push", "db pull"],
  flags: ["--remote", "--linked"],
  theme: "Targeting",
  summary:
    "Bare `db push` / `db pull` now target the local database instead of the linked project; pass `--remote` to reach the linked project.",
  migration,
  warnInPrevious: true,
});
