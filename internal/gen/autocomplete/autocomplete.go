package autocomplete

import (
	"context"
	"fmt"

	"github.com/supabase/cli/pkg/config"
)

func Run(ctx context.Context) error {
	schema, err := config.GenerateConfigJSONSchema()
	if err != nil {
		return fmt.Errorf("failed to generate config JSON schema: %w", err)
	}

	// Write the JSON schema to the console
	fmt.Println(schema)

	return nil
}
