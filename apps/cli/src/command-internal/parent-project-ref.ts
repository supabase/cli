/**
 * A value made entirely of lowercase letters (but not 20 of them, or it would already have
 * been treated as a ref) is a plausible ref typo. Appended to both {@link parentNotLinkedMessage}
 * and `link`'s own branch-not-found message.
 */
export function parentRefTypoHint(value: string): string {
  if (!/^[a-z]+$/.test(value)) return "";
  return `\n  If you meant a project ref: refs are exactly 20 lowercase letters ("${value}" has ${value.length}).`;
}

/**
 * Shared "no project is linked to search for branches" message, produced when
 * `RemoteTarget.parent` reports `"absent"` for a non-ref-shaped
 * `--project-ref`/positional value. Used by both `link` and `config diff`.
 */
export function parentNotLinkedMessage(value: string): string {
  return (
    `Cannot resolve "${value}": it is not a project ref (refs are exactly 20 lowercase letters, ` +
    "like `abcdefghijklmnopqrst`), so it was treated as a branch name — but no project is linked " +
    "to search for branches.\n" +
    "  If it is a branch name, link the parent project first: supabase link --project-ref <parent-ref>" +
    parentRefTypoHint(value)
  );
}

/**
 * Shared "the linked project ref is invalid" message, produced when
 * `RemoteTarget.parent` reports `"invalid"` for a non-ref-shaped
 * `--project-ref`/positional value. Used by both `link` and `config diff`.
 */
export function parentRefInvalidMessage(value: string): string {
  return `Cannot resolve branch "${value}": the linked project ref is invalid (checked SUPABASE_PROJECT_ID, supabase/.temp/linked-project.json, supabase/.temp/project-ref). Relink the parent project first: supabase link --project-ref <parent-ref>`;
}
