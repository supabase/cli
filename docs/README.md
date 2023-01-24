## Extended man pages for CLI commands

### Build

Update [version string](https://github.com/supabase/cli/blob/main/docs/main.go#L33) to match latest release.

```bash
go run docs/main.go > cli_v1_commands.yaml
```

### Release

1. Clone the [supabase/supabase](https://github.com/supabase/supabase) repo
2. Copy over the formatted CLI reference

```bash
npx prettier -w cli_v1_commands.yaml
mv cli_v1_commands.yaml ../supabase/specs/
```

3. If there are new commands added, update [common-cli-sections.json](https://github.com/supabase/supabase/blob/master/spec/common-cli-sections.json) manually
