import { Effect } from "effect";
import { failureMessage } from "../internal/failure-message.ts";
import {
  DatabaseSnapshotError,
  decodeSnapshotStop,
  type SnapshotBackend,
  SnapshotRun,
  SnapshotStep,
} from "../services/DatabaseSnapshot.ts";

/** Quotes one POSIX shell word. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const busybox = "/usr/bin/busybox";
// The database image ships GNU cp at /usr/local/bin for reflink copies.
const cp = "/usr/local/bin/cp";
const stopMarker = "snapshot-stop:";
const stepMarker = "snapshot-step:";
const doneMarker = "snapshot-done";

const stepScript = (step: SnapshotStep, adoptOwner: string | undefined): string => {
  const stop = (outcome: string) => `{ echo ${stopMarker}${outcome}; exit 0; }`;
  const body = SnapshotStep.$match(step, {
    Ensure: ({ directory }) => `${busybox} mkdir -p ${shellQuote(directory)}`,
    Clear: ({ directory }) =>
      `[ ! -L ${shellQuote(directory)} ] || { echo ${shellQuote(`${directory} is a symbolic link`)} >&2; exit 1; }; ${busybox} mkdir -p ${shellQuote(directory)}; ${busybox} find ${shellQuote(directory)} -mindepth 1 -maxdepth 1 -exec ${busybox} rm -rf -- {} +`,
    Recover: ({ stages, entries }) =>
      `for retired in ${shellQuote(stages)}/retired-*; do [ -d "$retired" ] || continue; digest=\${retired##*/retired-}; digest=\${digest%%-*}; if [ ! -e ${shellQuote(entries)}/"$digest" ]; then ${busybox} mkdir -p ${shellQuote(entries)}; ${busybox} mv "$retired" ${shellQuote(entries)}/"$digest"; fi; done`,
    Expect: ({ path, present, otherwise }) =>
      `[ ${present ? "" : "! "}-e ${shellQuote(path)} ] || ${stop(otherwise)}`,
    ExpectEmpty: ({ directory, otherwise }) =>
      `if [ -d ${shellQuote(directory)} ] && [ -n "$(${busybox} find ${shellQuote(directory)} -mindepth 1 -print -quit)" ]; then ${stop(otherwise)}; fi`,
    ExpectText: ({ file, text, otherwise }) =>
      `if [ ! -f ${shellQuote(file)} ] || [ "$(${busybox} cat ${shellQuote(file)})" != ${shellQuote(text)} ]; then echo ${stopMarker}${otherwise}; ${busybox} cat ${shellQuote(file)} 2>/dev/null || true; exit 0; fi`,
    Copy: ({ from, to }) =>
      `[ ! -e ${shellQuote(to)} ] || { echo "Snapshot copy destination exists" >&2; exit 1; }; unsupported=$(${busybox} find ${shellQuote(from)} \\( ! -type f ! -type d \\) -print -quit); [ -z "$unsupported" ] || { echo "Unsupported filesystem entry $unsupported" >&2; exit 1; }; ${cp} -a --reflink=auto ${shellQuote(from)} ${shellQuote(to)}`,
    Adopt: ({ directory }) =>
      adoptOwner === undefined ? ":" : `${busybox} chown -R ${adoptOwner} ${shellQuote(directory)}`,
    Write: ({ file, text }) => `printf '%s' ${shellQuote(text)} > ${shellQuote(file)}`,
    Rename: ({ from, to, optional }) =>
      optional
        ? `if [ -e ${shellQuote(from)} ] && [ ! -e ${shellQuote(to)} ]; then ${busybox} mv ${shellQuote(from)} ${shellQuote(to)}; fi`
        : `${busybox} mkdir -p "$(${busybox} dirname ${shellQuote(to)})"; if [ -d ${shellQuote(to)} ]; then ${busybox} rmdir ${shellQuote(to)}; elif [ -e ${shellQuote(to)} ]; then echo ${shellQuote(`${to} already exists`)} >&2; exit 1; fi; ${busybox} mv ${shellQuote(from)} ${shellQuote(to)}`,
    Remove: ({ path }) => `${busybox} rm -rf ${shellQuote(path)}`,
    Touch: ({ path }) => `${busybox} touch ${shellQuote(path)}`,
    // `%y` sorts by nanosecond modification time; entry names never contain spaces.
    Prune: ({ directory, keep, except }) =>
      `${busybox} find ${shellQuote(directory)} -mindepth 1 -maxdepth 1 ! -name ${shellQuote(except)} -exec ${busybox} stat -c '%y %n' {} + | ${busybox} sort -r | ${busybox} tail -n +${keep + 1} | ${busybox} cut -d ' ' -f 4- | ${busybox} xargs -r ${busybox} rm -rf`,
  });
  return `step=${step._tag.toLowerCase()}\n${body}`;
};

// A helper exec outlives an interrupted or killed client, so each script holds the store lock
// itself; this also serializes hosts that share one daemon.
const prologue = (root: string) =>
  [
    "step=preflight",
    `for helper_binary in ${busybox} ${cp}; do command -v "$helper_binary" >/dev/null 2>&1 || { echo "Database snapshot helper image is missing required binary: $helper_binary" >&2; exit 97; }; done`,
    "step=lock",
    `${busybox} mkdir -p ${shellQuote(root)}`,
    `exec 9>${shellQuote(`${root}/.lock`)}`,
    `attempt=0; until lock_error=$(${busybox} flock -n 9 2>&1); do if [ -n "$lock_error" ]; then echo "$lock_error" >&2; exit 1; fi; if [ "$attempt" -ge 120 ]; then echo 'Timed out waiting for database snapshot lock' >&2; exit 1; fi; attempt=$((attempt + 1)); ${busybox} sleep 1; done`,
  ].join("\n");

const helperError = (message: string, cause: unknown) => {
  const step = new RegExp(`^${stepMarker}(\\w+)$`, "mu").exec(message);
  return new DatabaseSnapshotError({
    operation: step?.[1] ?? "helper",
    message: message.replace(new RegExp(`\\n?^${stepMarker}\\w+$`, "mu"), "").trim(),
    cause,
  });
};

const parseRun = (output: string) =>
  Effect.gen(function* () {
    const [first = "", ...rest] = output.split("\n");
    if (first === doneMarker) return SnapshotRun.Completed();
    if (!first.startsWith(stopMarker))
      return yield* new DatabaseSnapshotError({
        operation: "helper",
        message: `Snapshot helper returned unexpected output: ${first}`,
      });
    const outcome = yield* decodeSnapshotStop(first.slice(stopMarker.length)).pipe(
      Effect.mapError(
        (cause) => new DatabaseSnapshotError({ operation: "helper", message: cause.message }),
      ),
    );
    return SnapshotRun.Stopped({ outcome, text: rest.join("\n") });
  });

/** Runs each snapshot program as one POSIX shell script inside a storage helper container. */
export const makeDockerSnapshotBackend = <E>(options: {
  readonly lockKey: string;
  readonly root: string;
  readonly data: string;
  readonly restoreStages: string;
  /** Owner applied to restored data before publication; unset keeps copied ownership. */
  readonly adoptOwner?: string;
  /** Runs on every exit of the script, after the program. */
  readonly epilogue?: string;
  readonly exec: (script: string) => Effect.Effect<string, E>;
}): SnapshotBackend => {
  const onExit = `status=$?; if [ "$status" -ne 0 ]; then echo "${stepMarker}$step" >&2; fi; ${options.epilogue ?? ":"}; exit "$status"`;
  return {
    lockKey: options.lockKey,
    entries: `${options.root}/entries`,
    stages: `${options.root}/stages`,
    restoreStages: options.restoreStages,
    data: options.data,
    join: (...parts) => parts.join("/"),
    run: (steps) =>
      options
        .exec(
          [
            "set -eu",
            `trap ${shellQuote(onExit)} EXIT`,
            prologue(options.root),
            ...steps.map((step) => stepScript(step, options.adoptOwner)),
            `echo ${doneMarker}`,
          ].join("\n"),
        )
        .pipe(
          Effect.mapError((cause) => helperError(failureMessage(cause), cause)),
          Effect.flatMap(parseRun),
        ),
  };
};
