## supabase-postgres-config-update

Overriding the default Postgres config could result in unstable database behavior.
Custom configuration also overrides the optimizations generated based on the compute add-ons in use.
The update asks for confirmation (default No) before changing the overrides. Pass `--yes` to confirm without asking; JSON, stream-json, `-o` and non-interactive runs fail without it.
