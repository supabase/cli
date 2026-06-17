/**
 * Sort data rows within each pipe-separated table block so that non-deterministic
 * map-iteration order in the Go CLI doesn't cause flaky parity failures.
 * Only the rows after each separator line are sorted; header and non-table lines
 * are left in place.
 */
export function sortTableRows(output: string): string {
  const lines = output.split("\n");
  let i = 0;
  const result: string[] = [];

  while (i < lines.length) {
    const line = lines[i]!;
    result.push(line);
    if (/^[\s\-|]+$/.test(line) && line.includes("-")) {
      i++;
      const dataRows: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "") {
        dataRows.push(lines[i]!);
        i++;
      }
      dataRows.sort();
      result.push(...dataRows);
    } else {
      i++;
    }
  }

  return result.join("\n");
}

export interface NormalizeOptions {
  readonly versions?: boolean;
  readonly stripPatterns?: readonly RegExp[];
}

/**
 * Normalize CLI output by stripping non-deterministic content before parity
 * comparisons. Applied to both Go and ts-legacy output so spurious differences
 * in timestamps, versions, paths, and stack traces don't produce false failures.
 */
export function normalize(output: string, options: NormalizeOptions = {}): string {
  const normalizeVersions = options.versions ?? true;
  const withoutAnsi = output
    // 1. Strip ANSI escape codes (color, bold, reset, etc.) — \u001b is ESC
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
  const withoutVersions = normalizeVersions
    ? withoutAnsi.replace(
        // 2. Semantic version strings (e.g. 1.187.0, v2.0.0-rc.1, v14.13).
        //    Lookbehind prevents matching mid-IP-address (e.g. 0.0.1 inside 127.0.0.1).
        //    Lookahead prevents matching where more dotted-number segments follow.
        /(?<![.\d])\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b(?!\.)/g,
        "<VERSION>",
      )
    : withoutAnsi;
  const withoutStrippedPatterns = (options.stripPatterns ?? []).reduce(
    (acc, pattern) => acc.replace(pattern, ""),
    withoutVersions,
  );

  return (
    withoutStrippedPatterns
      // 3. ISO-8601 timestamps (2026-04-15T10:46:15Z or with milliseconds)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>")
      // 4. Display timestamps (2026-04-15 10:46:15 — space-separated, no T)
      .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "<TIMESTAMP>")
      // 5. UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
      // 6. JWK key material fields (base64url-encoded cryptographic bytes).
      //     UUIDs in "kid" are already handled by rule 5. These fields contain
      //     random key bytes that differ across invocations, and must be scrubbed
      //     before duration normalization because opaque bytes can contain
      //     duration-looking substrings such as "100s".
      .replace(/"(d|x|y|n|e|p|q|dp|dq|qi|k)"\s*:\s*"[A-Za-z0-9_-]+"/g, '"$1":"<KEY_BYTES>"')
      // 6b. JWT tokens (header starts with eyJ — base64url of `{"`). Masks the
      //     full three-part token so non-deterministic signatures and Unix
      //     timestamps in the payload don't cause false parity failures. Must run
      //     BEFORE duration normalization (rule 7): a random base64url signature
      //     can contain a duration-looking substring (e.g. "-60s-") bounded by
      //     `-`/`_`/`.`, which the duration pass would otherwise inject `<DURATION>`
      //     into mid-token. Same ordering rationale as the JWK key bytes above.
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "<JWT>")
      // 7. Durations (e.g. 1.23s, 123ms, 42s)
      .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, "<DURATION>")
      // 8. Unix absolute paths (/home/…, /Users/…, /tmp/…, /var/…, /opt/…, /usr/…)
      .replace(/\/(?:home|Users|tmp|var|opt|usr)\/\S+/g, "<PATH>")
      // 9. Windows absolute paths (C:\…)
      .replace(/[A-Z]:\\\S+/g, "<PATH>")
      // 10. Go stack frame addresses (0x1a2b3c4d) — vary per run due to ASLR
      .replace(/\(0x[0-9a-f]+\)/gi, "(0xADDR)")
      // 11. CLI version-update notification lines emitted by the Go binary
      .replace(
        /^.*(?:A new version of Supabase CLI is available|We recommend updating regularly|upgrade at:|upgrade using:).*\n?/gim,
        "",
      )
      // 12. Go goroutine stack trace blocks (goroutine N [state]:\n...)
      .replace(/^goroutine \d+ \[.*?\]:(?:\n[^\n]+)*/gm, "<STACK_TRACE>")
      // 12b. github.com/go-errors/errors stack frames. The Go CLI prints these in
      //      dev builds (`utils.Version == ""`) before the actual error message:
      //          <PATH> (0xADDR)
      //          \t<funcName>: <source-snippet>
      //      The TS port intentionally doesn't reconstruct these — strip the
      //      frame block plus the trailing blank line so parity comparisons ignore them.
      .replace(/(?:^<PATH> \(0xADDR\)\n\t[^\n]+\n)+\n?/gm, "")
      // 12c. A go-errors frame glued to a preceding prompt on the same line, e.g.
      //      `Enter a new root key: <PATH> (0xADDR)\n\t<funcName>: …`. Rule 12b
      //      only strips frames that begin at line start, so when a command writes
      //      a prompt to stderr without a trailing newline (`encryption update-root-key`),
      //      the first frame stays glued to the prompt and survives. Strip that
      //      residual frame too, leaving just the prompt text.
      .replace(/<PATH> \(0xADDR\)\n\t[^\n]+\n/g, "")
      // 13. Node/Bun stack trace lines (one or more consecutive "    at …" lines)
      .replace(/(?:^[ \t]+at [^\n]+\n?)+/gm, "<STACK_TRACE>\n")
      // 14. File reference line numbers (file.ts:123 or file.ts:123:45)
      .replace(/\b(\w[\w.-]*\.(?:ts|js|go|tsx|jsx|mts|mjs|cjs)):\d+(?::\d+)?\b/g, "$1:<LINE>")
      // 16. db query agent-mode boundary: a 32-char hex string generated randomly
      //     per process. Both the JSON key value and its appearance inside the
      //     warning string (unicode-escaped in raw JSON) must be replaced.
      .replace(/"boundary"\s*:\s*"[0-9a-f]{32}"/g, '"boundary": "<BOUNDARY>"')
      .replace(/\\u003c[0-9a-f]{32}\\u003e/g, "\\u003c<BOUNDARY>\\u003e")
      // 17. Docker shadow-DB endpoint lines emitted when a container starts:
      //     "endpoint <adjective_noun> (<64-hex>)" — both parts are random per container.
      .replace(/\bendpoint \w+_\w+ \([0-9a-f]{64}\)/g, "endpoint <CONTAINER> (<ENDPOINT_HASH>)")
      // 17b. System-keyring availability noise. The Go CLI uses an OS keyring
      //      (dbus Secret Service on Linux) and prints "Keyring is not supported
      //      on WSL" to stderr when it is unavailable — e.g. on headless CI
      //      runners with no D-Bus session. The ts-legacy keyring
      //      (`@napi-rs/keyring`) uses the kernel keyutils backend, which is
      //      always available, so it never prints this. The line is a
      //      keyring-backend implementation detail, not command behavior, so
      //      strip it from both sides. (Same class of divergence that defers the
      //      login/logout parity tests in auth.e2e.test.ts.)
      .replace(/^Keyring is not supported on WSL\n?/gm, "")
      // 18. Trailing whitespace on each line
      .replace(/[ \t]+$/gm, "")
      // 19. Collapse 3+ consecutive blank lines to two newlines
      .replace(/\n{3,}/g, "\n\n")
  );
}
