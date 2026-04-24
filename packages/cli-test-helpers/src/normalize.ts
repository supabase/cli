/**
 * Normalize CLI output by stripping non-deterministic content before parity
 * comparisons. Applied to both Go and ts-legacy output so spurious differences
 * in timestamps, versions, paths, and stack traces don't produce false failures.
 */
export function normalize(output: string): string {
  return (
    output
      // 1. Strip ANSI escape codes (color, bold, reset, etc.) — \u001b is ESC
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
      // 2. Semantic version strings (e.g. 1.187.0, v2.0.0-rc.1).
      //    Lookbehind prevents matching mid-IP-address (e.g. 0.0.1 inside 127.0.0.1).
      //    Lookahead prevents matching where more dotted-number segments follow.
      .replace(/(?<![.\d])\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b(?!\.)/g, "<VERSION>")
      // 3. ISO-8601 timestamps (2026-04-15T10:46:15Z or with milliseconds)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>")
      // 4. Display timestamps (2026-04-15 10:46:15 — space-separated, no T)
      .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "<TIMESTAMP>")
      // 5. UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
      // 6. Durations (e.g. 1.23s, 123ms, 42s)
      .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, "<DURATION>")
      // 7. Unix absolute paths (/home/…, /Users/…, /tmp/…, /var/…, /opt/…, /usr/…)
      .replace(/\/(?:home|Users|tmp|var|opt|usr)\/\S+/g, "<PATH>")
      // 8. Windows absolute paths (C:\…)
      .replace(/[A-Z]:\\\S+/g, "<PATH>")
      // 9. Go stack frame addresses (0x1a2b3c4d) — vary per run due to ASLR
      .replace(/\(0x[0-9a-f]+\)/gi, "(0xADDR)")
      // 10. CLI version-update notification lines emitted by the Go binary
      .replace(
        /^.*(?:A new version of Supabase CLI is available|We recommend updating regularly|upgrade at:|upgrade using:).*\n?/gim,
        "",
      )
      // 11. Go goroutine stack trace blocks (goroutine N [state]:\n...)
      .replace(/^goroutine \d+ \[.*?\]:(?:\n[^\n]+)*/gm, "<STACK_TRACE>")
      // 12. Node/Bun stack trace lines (one or more consecutive "    at …" lines)
      .replace(/(?:^[ \t]+at [^\n]+\n?)+/gm, "<STACK_TRACE>\n")
      // 13. File reference line numbers (file.ts:123 or file.ts:123:45)
      .replace(/\b(\w[\w.-]*\.(?:ts|js|go|tsx|jsx|mts|mjs|cjs)):\d+(?::\d+)?\b/g, "$1:<LINE>")
      // 14. JWT tokens (header starts with eyJ — base64url of `{"`)
      //     Replaces full three-part token so non-deterministic signatures and
      //     Unix-integer timestamps in the payload don't cause false parity failures.
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "<JWT>")
      // 15. JWK key material fields (base64url-encoded cryptographic bytes).
      //     UUIDs in "kid" are already handled by rule 5. These fields contain
      //     random key bytes that differ across invocations.
      .replace(/"(d|x|y|n|e|p|q|dp|dq|qi|k)"\s*:\s*"[A-Za-z0-9_-]+"/g, '"$1":"<KEY_BYTES>"')
      // 16. db query agent-mode boundary: a 32-char hex string generated randomly
      //     per process. Both the JSON key value and its appearance inside the
      //     warning string (unicode-escaped in raw JSON) must be replaced.
      .replace(/"boundary"\s*:\s*"[0-9a-f]{32}"/g, '"boundary": "<BOUNDARY>"')
      .replace(/\\u003c[0-9a-f]{32}\\u003e/g, "\\u003c<BOUNDARY>\\u003e")
      // 17. Docker shadow-DB endpoint lines emitted when a container starts:
      //     "endpoint <adjective_noun> (<64-hex>)" — both parts are random per container.
      .replace(/\bendpoint \w+_\w+ \([0-9a-f]{64}\)/g, "endpoint <CONTAINER> (<ENDPOINT_HASH>)")
      // 18. Trailing whitespace on each line
      .replace(/[ \t]+$/gm, "")
      // 19. Collapse 3+ consecutive blank lines to two newlines
      .replace(/\n{3,}/g, "\n\n")
  );
}
