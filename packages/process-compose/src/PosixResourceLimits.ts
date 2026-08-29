/**
 * Wraps a command in a POSIX shell that sets its soft open-file limit before
 * replacing itself with the original process.
 *
 * Command and arguments are passed as positional parameters. This keeps
 * service-provided values out of the shell program and preserves argv exactly.
 */
export const makePosixNofileLimitedCommand = (
  command: string,
  args: ReadonlyArray<string>,
  requested: number,
): { readonly command: "/bin/sh"; readonly args: ReadonlyArray<string> } => ({
  command: "/bin/sh",
  args: [
    "-c",
    `
requested="$1"
shift
hard=$(ulimit -Hn) || {
  printf '%s\\n' 'failed to query the POSIX nofile hard limit' >&2
  exit 125
}
case "$hard" in
  unlimited) limit="$requested" ;;
  ''|*[!0-9]*)
    printf '%s\\n' "invalid POSIX nofile hard limit: $hard" >&2
    exit 125
    ;;
  *)
    if [ "$hard" -lt "$requested" ]; then limit="$hard"; else limit="$requested"; fi
    ;;
esac
if ! ulimit -Sn "$limit"; then
  printf '%s\\n' "failed to set the POSIX nofile soft limit to $limit" >&2
  exit 125
fi
exec "$@"
`,
    "process-compose-posix-limit",
    String(requested),
    command,
    ...args,
  ],
});
