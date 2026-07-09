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
 * `start/lib/docker-create-args.ts` (`docker create`) — shares one
 * implementation instead of duplicating the regex.
 */
export function legacyIsBindMountSource(source: string): boolean {
  return /^[.~/]/.test(source) || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("\\\\");
}
