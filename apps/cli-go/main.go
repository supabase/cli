package main

import (
	"github.com/supabase/cli/cmd"
)

// Codegen reads the committed api/v1-openapi.yaml snapshot instead of fetching
// the live upstream spec, so `go generate` is reproducible offline and the
// Codegen CI check only fails on a PR that leaves pkg/api out of sync with the
// snapshot. The API Sync workflow refreshes the snapshot and pkg/api together.
//go:generate go tool oapi-codegen -config pkg/api/types.cfg.yaml api/v1-openapi.yaml
//go:generate go tool oapi-codegen -config pkg/api/client.cfg.yaml api/v1-openapi.yaml

func main() {
	cmd.Execute()
}
