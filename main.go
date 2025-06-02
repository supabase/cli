package main

import (
	"github.com/supabase/cli/cmd"
)

//go:generate go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen --config=pkg/api/types.cfg.yaml https://api.supabase.green/api/v1-yaml
//go:generate go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen --config=pkg/api/client.cfg.yaml https://api.supabase.green/api/v1-yaml

func main() {
	cmd.Execute()
}
