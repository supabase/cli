/**
 * Classifies a bind spec's source as a bind mount or a named volume: it is a bind mount when it
 * looks like a file path (starts with `.`, `/`, `~`, or a Windows drive/UNC prefix), otherwise a
 * named volume.
 */
export function isBindMountSource(source: string): boolean {
  return /^[.~/]/.test(source) || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("\\\\");
}

/**
 * Extracts the `source` field from a `source:target[:mode]` bind spec, Windows-drive-aware.
 * A naive `bind.split(":")[0]` truncates `C:\repo\functions:/home/deno/functions:ro` down to
 * `"C"`, which {@link isBindMountSource} would then misclassify as a named volume.
 */
export function bindMountSpecSource(bind: string): string {
  if (/^[A-Za-z]:[\\/]/.test(bind)) {
    const nextColon = bind.indexOf(":", 2);
    return nextColon === -1 ? bind : bind.slice(0, nextColon);
  }
  return bind.split(":")[0] ?? "";
}
