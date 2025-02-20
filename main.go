package main

import (
	"fmt"

	"github.com/supabase/cli/cmd"
)

//go:generate go run github.com/deepmap/oapi-codegen/v2/cmd/oapi-codegen --config=pkg/api/types.cfg.yaml api/beta.yaml
//go:generate go run github.com/deepmap/oapi-codegen/v2/cmd/oapi-codegen --config=pkg/api/client.cfg.yaml api/beta.yaml

func main() {
	fmt.Println("=== TESTING BUILD ===")
	cmd.Execute()
}
