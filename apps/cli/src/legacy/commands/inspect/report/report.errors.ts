import { Data } from "effect";

/**
 * Creating the dated `<output-dir>/<YYYY-MM-DD>/` directory failed. Mirrors Go's
 * `utils.MkdirIfNotExistFS` error (`apps/cli-go/internal/utils/misc.go:265-271`),
 * which wraps the failure as `failed to mkdir: %w`.
 */
export class LegacyInspectReportMkdirError extends Data.TaggedError(
  "LegacyInspectReportMkdirError",
)<{ readonly message: string }> {}

/**
 * Writing one of the report CSV files failed. Mirrors Go's `copyToCSV`
 * (`apps/cli-go/internal/inspect/report.go:66-69`), which wraps an `OpenFile`
 * failure as `failed to create output file: %w`. The TS port collects the COPY
 * bytes first and writes them afterwards, so a file-write failure surfaces here
 * with Go's matching text.
 */
export class LegacyInspectReportWriteError extends Data.TaggedError(
  "LegacyInspectReportWriteError",
)<{ readonly message: string }> {}
