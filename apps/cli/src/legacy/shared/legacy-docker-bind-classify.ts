/**
 * Go's `loader.ParseVolume` bind-vs-named-volume classification (docker/cli's
 * vendored `compose-go/v2/loader.ParseVolume`, read by `DockerStart` when it
 * splits `HostConfig.Binds` into bind mounts vs named volumes —
 * `apps/cli-go/internal/utils/docker.go:388-399`): a bind's source is a bind
 * mount when it looks like a file path (starts with `.`, `/`, `~`, or a
 * Windows drive/UNC prefix); otherwise it is a named volume.
 *
 * Hoisted here so every `docker run`/`docker create` argv builder that needs
 * this classification — `legacy-docker-run.args.ts` (`docker run`) and
 * `legacy/shared/db-bootstrap/docker-create-args.ts` (`docker create`) — shares one
 * implementation instead of duplicating the regex.
 */
export function legacyIsBindMountSource(source: string): boolean {
  return /^[.~/]/.test(source) || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("\\\\");
}

/**
 * Extracts the `source` field from a `source:target[:mode]` bind spec, Windows-drive-aware.
 * Go's `loader.ParseVolume` (vendored `compose-go/v2/format.ParseVolume`, `format/volume.go`) is a
 * character-by-character state machine whose `isWindowsDrive` check treats the colon after a
 * single-letter prefix as part of the path, not a field separator — so `C:\repo\functions:/home/
 * deno/functions:ro` keeps `C:\repo\functions` as one field. A naive `bind.split(":")[0]` instead
 * truncates that down to `"C"`, which {@link legacyIsBindMountSource} then misclassifies as a
 * named-volume name instead of a bind-mount path. Every caller that needs the source field for
 * classification must use this instead of a raw split.
 */
export function legacyBindMountSpecSource(bind: string): string {
  if (/^[A-Za-z]:[\\/]/.test(bind)) {
    const nextColon = bind.indexOf(":", 2);
    return nextColon === -1 ? bind : bind.slice(0, nextColon);
  }
  return bind.split(":")[0] ?? "";
}
