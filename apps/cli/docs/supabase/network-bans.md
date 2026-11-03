## supabase-network-bans

Network bans are IPs that get temporarily blocked if their traffic pattern looks abusive (e.g. multiple failed auth attempts).

The subcommands help you view the current bans, and unblock IPs if desired.

`remove` asks for confirmation (default No) before unblocking. Pass `--yes` to confirm without asking; JSON, stream-json, `-o` and non-interactive runs fail without it.
