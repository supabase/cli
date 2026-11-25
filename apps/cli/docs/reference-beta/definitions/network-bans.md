---
id: network-bans
kind: command
category: Network Bans
title: network-bans
symbol: supabase network-bans
summary: Manage network bans
stability: stable
deprecated: false
inherits_flags: global
parameters: []
examples: []
---

Lists and lifts temporary bans on IP addresses. An IP is banned when its traffic looks abusive, for example after multiple failed auth attempts.

`remove` asks for confirmation (default No) before unblocking. Pass `--yes` to confirm without asking; JSON, stream-json, `-o` and non-interactive runs fail without it.
