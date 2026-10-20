/** The optimal string alignment distance: an insertion, deletion, substitution or adjacent swap is one edit. */
const editDistance = (a: string, b: string): number => {
  let beforePrevious: ReadonlyArray<number> = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      let distance = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        distance = Math.min(distance, (beforePrevious[column - 2] ?? 0) + 1);
      }
      current[column] = distance;
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length] ?? 0;
};

/** Up to two edits, fewer for a short name, so two unrelated short words never match. */
const allowedEdits = (a: string, b: string): number =>
  Math.min(2, Math.floor(Math.max(a.length, b.length) / 3));

const byName = (a: { readonly name: string }, b: { readonly name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** The item whose name matches `word` ignoring case or within two edits of it; the nearest wins and a tie goes to the first name alphabetically. */
export const closestByName = <T extends { readonly name: string }>(
  items: ReadonlyArray<T>,
  word: string,
): T | undefined => {
  const target = word.trim().toLowerCase();
  let best: { readonly item: T; readonly distance: number } | undefined;
  for (const item of items.toSorted(byName)) {
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

const MIN_NEAR_MISS_NAME_LENGTH = 5;

/**
 * The item a word most likely mistypes: one whose name matches ignoring case, else a non-default
 * one of at least five characters a single edit away. A short or default name never claims a word
 * that reads as an ordinary operand.
 */
export const nearMissByName = <T extends { readonly name: string }>(
  items: ReadonlyArray<T>,
  word: string,
  isDefault: (item: T) => boolean,
): T | undefined => {
  const target = word.toLowerCase();
  const sorted = items.toSorted(byName);
  return (
    sorted.find((item) => item.name.toLowerCase() === target) ??
    sorted.find(
      (item) =>
        !isDefault(item) &&
        item.name.length >= MIN_NEAR_MISS_NAME_LENGTH &&
        editDistance(target, item.name.toLowerCase()) <= 1,
    )
  );
};
