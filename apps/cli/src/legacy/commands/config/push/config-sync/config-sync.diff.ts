/**
 * Direct port of Go's `pkg/diff/diff.go` (the BSD-licensed anchored / "patience"
 * unified diff used by `supabase config push`).
 *
 * Byte-exact parity with the Go implementation is the contract: the diff bytes
 * are printed to stderr (`Updating <X> service with config: <diff>`) and locked
 * by golden fixtures generated from the Go binary. We deliberately do NOT use
 * the npm `diff` package — its Myers algorithm picks different hunk boundaries
 * on repeated TOML lines (e.g. `enabled = false`), which drifts the output.
 *
 * @see apps/cli-go/pkg/diff/diff.go
 */

interface Pair {
  x: number;
  y: number;
}

/**
 * Returns an anchored unified diff of the two texts `oldText` and `newText`.
 * If they are identical, returns an empty string (Go returns a nil slice).
 */
export function diff(oldName: string, oldText: string, newName: string, newText: string): string {
  if (oldText === newText) {
    return "";
  }
  const x = lines(oldText);
  const y = lines(newText);

  let out = "";
  out += `diff ${oldName} ${newName}\n`;
  out += `--- ${oldName}\n`;
  out += `+++ ${newName}\n`;

  let done: Pair = { x: 0, y: 0 };
  let chunk: Pair = { x: 0, y: 0 };
  const count: Pair = { x: 0, y: 0 };
  let ctext: Array<string> = [];

  const C = 3; // number of context lines

  for (const m of tgs(x, y)) {
    if (m.x < done.x) {
      // Already handled scanning forward from earlier match.
      continue;
    }

    // Expand matching lines as far as possible.
    const start: Pair = { x: m.x, y: m.y };
    while (start.x > done.x && start.y > done.y && x[start.x - 1] === y[start.y - 1]) {
      start.x--;
      start.y--;
    }
    const end: Pair = { x: m.x, y: m.y };
    while (end.x < x.length && end.y < y.length && x[end.x] === y[end.y]) {
      end.x++;
      end.y++;
    }

    // Emit the mismatched lines before start into this chunk.
    for (const s of x.slice(done.x, start.x)) {
      ctext.push("-" + s);
      count.x++;
    }
    for (const s of y.slice(done.y, start.y)) {
      ctext.push("+" + s);
      count.y++;
    }

    // If we're not at EOF and have too few common lines, the chunk includes all
    // the common lines and continues.
    if (
      (end.x < x.length || end.y < y.length) &&
      (end.x - start.x < C || (ctext.length > 0 && end.x - start.x < 2 * C))
    ) {
      for (const s of x.slice(start.x, end.x)) {
        ctext.push(" " + s);
        count.x++;
        count.y++;
      }
      done = { x: end.x, y: end.y };
      continue;
    }

    // End chunk with common lines for context.
    if (ctext.length > 0) {
      const n = Math.min(end.x - start.x, C);
      for (const s of x.slice(start.x, start.x + n)) {
        ctext.push(" " + s);
        count.x++;
        count.y++;
      }
      done = { x: start.x + n, y: start.y + n };

      // Format and emit chunk. Convert line numbers to 1-indexed.
      // Special case: empty file shows up as 0,0 not 1,0.
      if (count.x > 0) {
        chunk.x++;
      }
      if (count.y > 0) {
        chunk.y++;
      }
      out += `@@ -${chunk.x},${count.x} +${chunk.y},${count.y} @@\n`;
      for (const s of ctext) {
        out += s;
      }
      count.x = 0;
      count.y = 0;
      ctext = [];
    }

    // If we reached EOF, we're done.
    if (end.x >= x.length && end.y >= y.length) {
      break;
    }

    // Otherwise start a new chunk.
    chunk = { x: end.x - C, y: end.y - C };
    for (const s of x.slice(chunk.x, end.x)) {
      ctext.push(" " + s);
      count.x++;
      count.y++;
    }
    done = { x: end.x, y: end.y };
  }

  return out;
}

/**
 * Returns the lines in the text, including newlines. If the text does not end
 * in a newline, one is supplied along with a warning about the missing newline
 * (matching BSD/GNU diff, including the leading backslash).
 */
function lines(text: string): Array<string> {
  const l = splitAfter(text, "\n");
  if (l[l.length - 1] === "") {
    l.pop();
  } else {
    l[l.length - 1] += "\n\\ No newline at end of file\n";
  }
  return l;
}

/**
 * Port of Go's `strings.SplitAfter(s, "\n")` — splits after each separator,
 * keeping the separator attached to the preceding substring. A trailing
 * separator yields a final empty element.
 */
function splitAfter(s: string, sep: string): Array<string> {
  const result: Array<string> = [];
  let start = 0;
  let idx = s.indexOf(sep, start);
  while (idx !== -1) {
    result.push(s.slice(start, idx + sep.length));
    start = idx + sep.length;
    idx = s.indexOf(sep, start);
  }
  result.push(s.slice(start));
  return result;
}

/**
 * Returns the pairs of indexes of the longest common subsequence of unique
 * lines in x and y, where a unique line is one that appears once in x and once
 * in y. Adds sentinel pairs {0,0} and {len(x),len(y)}.
 *
 * Algorithm A from Szymanski's paper (https://research.swtch.com/tgs170.pdf).
 */
function tgs(x: Array<string>, y: Array<string>): Array<Pair> {
  // Count occurrences: 0, 1, many counted as 0, -1, -2 for x and 0, -4, -8 for y.
  const m = new Map<string, number>();
  for (const s of x) {
    const c = m.get(s) ?? 0;
    if (c > -2) {
      m.set(s, c - 1);
    }
  }
  for (const s of y) {
    const c = m.get(s) ?? 0;
    if (c > -8) {
      m.set(s, c - 4);
    }
  }

  // Unique strings are identified by m[s] == -1 + -4 == -5.
  const xi: Array<number> = [];
  const yi: Array<number> = [];
  const inv: Array<number> = [];
  for (let i = 0; i < y.length; i++) {
    const s = y[i] as string;
    if (m.get(s) === -1 + -4) {
      m.set(s, yi.length);
      yi.push(i);
    }
  }
  for (let i = 0; i < x.length; i++) {
    const s = x[i] as string;
    const j = m.get(s);
    if (j !== undefined && j >= 0) {
      xi.push(i);
      inv.push(j);
    }
  }

  // Apply Algorithm A: A = J = inv, B = [0, n).
  const J = inv;
  const n = xi.length;
  const T: Array<number> = Array.from({ length: n }, () => n + 1);
  const L: Array<number> = Array.from({ length: n }, () => 0);
  for (let i = 0; i < n; i++) {
    // sort.Search: first k in [0, n) where T[k] >= J[i].
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((T[mid] as number) >= (J[i] as number)) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    const k = lo;
    T[k] = J[i] as number;
    L[i] = k + 1;
  }
  let k = 0;
  for (const v of L) {
    if (k < v) {
      k = v;
    }
  }
  // Go `make([]pair, 2+k)` zero-initialises every entry to {0,0}; match that so
  // any index not overwritten below behaves identically.
  const seq: Array<Pair> = Array.from({ length: 2 + k }, () => ({ x: 0, y: 0 }));
  seq[1 + k] = { x: x.length, y: y.length }; // sentinel at end
  // NB: Go's `internal/diff` never reassigns `lastj` inside this loop; we match
  // it exactly to preserve byte-for-byte parity.
  const lastj = n;
  for (let i = n - 1; i >= 0; i--) {
    if (L[i] === k && (J[i] as number) < lastj) {
      seq[k] = { x: xi[i] as number, y: yi[J[i] as number] as number };
      k--;
    }
  }
  seq[0] = { x: 0, y: 0 }; // sentinel at start
  return seq;
}
