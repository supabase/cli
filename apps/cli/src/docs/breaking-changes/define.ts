/** A change that breaks existing usage of a command in a new CLI major. */
export interface BreakingChange {
  /** Kebab-case slug; becomes the migration guide anchor. */
  readonly id: string;
  /** The CLI major that ships the change. */
  readonly major: number;
  /** Affected commands as typed, without the `supabase` prefix, e.g. `db push`. */
  readonly commands: ReadonlyArray<string>;
  /** Affected flags, e.g. `--remote`, shown on the matching flag row. */
  readonly flags?: ReadonlyArray<string>;
  readonly summary: string;
  /** Migration guide section the change is listed under. */
  readonly theme: string;
  /** Markdown shown under the change in the migration guide. */
  readonly migration: string;
  /** A command that moved: `command` is the old spelling, `to` its replacement. */
  readonly renamedFrom?: { readonly command: string; readonly to: string };
  /** The previous major already warns at runtime, so its reference page announces the change. */
  readonly warnInPrevious?: boolean;
}

/** Declares a breaking change for the docs generator; see the registry in `./index.ts`. */
export function defineBreakingChange(change: BreakingChange): BreakingChange {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(change.id)) {
    throw new Error(
      `defineBreakingChange: id "${change.id}" must be kebab-case; it is used as a URL anchor.`,
    );
  }
  if (change.commands.length === 0) {
    throw new Error(`defineBreakingChange: "${change.id}" lists no commands.`);
  }
  return change;
}
