/** The Levenshtein distance between two strings. */
const editDistance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
};

/** Up to two edits, fewer for a short name, so two unrelated short words never match. */
const allowedEdits = (a: string, b: string): number =>
  Math.min(2, Math.floor(Math.max(a.length, b.length) / 3));

/** The item whose name matches `word` ignoring case or within two edits of it; the nearest wins and a tie goes to the first name alphabetically. */
export const closestByName = <T extends { readonly name: string }>(
  items: ReadonlyArray<T>,
  word: string,
): T | undefined => {
  const target = word.trim().toLowerCase();
  let best: { readonly item: T; readonly distance: number } | undefined;
  for (const item of items.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const name = item.name.toLowerCase();
    const distance = editDistance(target, name);
    if (
      distance <= allowedEdits(target, name) &&
      (best === undefined || distance < best.distance)
    ) {
      best = { item, distance };
    }
  }
  return best?.item;
};
