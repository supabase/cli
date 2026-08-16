import { addRemote, listRemotes, removeRemote } from "@supabase/config";
import { Effect } from "effect";
import { columnWidths, formatTableRow } from "../output/table.ts";
import { Output } from "../output/output.service.ts";
import { NoProjectConfigError } from "./remotes.errors.ts";

const LIST_HEADERS = ["NAME", "PROJECT REF"] as const;

/** `remotes list` body — shared by `legacy/` and `next/`. */
export const remotesList = Effect.fnUntraced(function* (cwd: string) {
  const output = yield* Output;

  const remotes = yield* listRemotes(cwd);
  if (remotes === null) {
    return yield* Effect.fail(
      new NoProjectConfigError({
        message: "No supabase/config.toml or supabase/config.json found.",
      }),
    );
  }

  if (output.format !== "text") {
    yield* output.success("Remotes listed.", {
      remotes: remotes.map((remote) => ({ name: remote.name, project_ref: remote.projectRef })),
    });
    return;
  }

  if (remotes.length === 0) {
    yield* output.raw("No remotes configured.\n");
    return;
  }

  const rows = remotes.map((remote) => [remote.name, remote.projectRef]);
  const widths = columnWidths(LIST_HEADERS, rows);
  const lines = [
    formatTableRow(LIST_HEADERS, widths),
    ...rows.map((row) => formatTableRow(row, widths)),
  ];
  yield* output.raw(`${lines.join("\n")}\n`);
});

/** `remotes add <name> --project-ref <ref>` body — shared by `legacy/` and `next/`. */
export const remotesAdd = Effect.fnUntraced(function* (
  cwd: string,
  name: string,
  projectRef: string,
) {
  const output = yield* Output;

  const result = yield* addRemote({ cwd, name, projectRef });
  if (result === null) {
    return yield* Effect.fail(
      new NoProjectConfigError({
        message: "No supabase/config.toml or supabase/config.json found.",
      }),
    );
  }

  const message = result.wrote
    ? `Added remote "${name}" -> ${projectRef}.`
    : `Remote "${name}" already targets ${projectRef} — nothing to do.`;

  if (output.format !== "text") {
    yield* output.success(message, { name, project_ref: projectRef, wrote: result.wrote });
    return;
  }
  yield* output.raw(`${message}\n`);
});

/** `remotes remove <name>` body — shared by `legacy/` and `next/`. */
export const remotesRemove = Effect.fnUntraced(function* (cwd: string, name: string) {
  const output = yield* Output;

  const result = yield* removeRemote({ cwd, name });
  if (result === null) {
    return yield* Effect.fail(
      new NoProjectConfigError({
        message: "No supabase/config.toml or supabase/config.json found.",
      }),
    );
  }

  const message = `Removed remote "${name}".`;
  if (output.format !== "text") {
    yield* output.success(message, { name });
    return;
  }
  yield* output.raw(`${message}\n`);
});
