package get

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	config, err := GetCurrentPostgresConfig(ctx, projectRef)
	if err != nil {
		return err
	}
	return PrintOutPostgresConfigOverrides(config)
}

func PrintOutPostgresConfigOverrides(config map[string]any) error {
	if utils.OutputFormat.Value != utils.OutputPretty {
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, config)
	}
	fmt.Fprintln(os.Stderr, "- Custom Postgres Config -")
	markdownTable := []string{
		"|Parameter|Value|\n|-|-|\n",
	}
	for k, v := range config {
		markdownTable = append(markdownTable, fmt.Sprintf(
			"|`%s`|`%+v`|\n",
			k, v,
		))
	}
	if err := utils.RenderTable(strings.Join(markdownTable, "")); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "- End of Custom Postgres Config -")
	return nil
}

func GetCurrentPostgresConfig(ctx context.Context, projectRef string) (map[string]any, error) {
	resp, err := utils.GetSupabase().V1GetPostgresConfigWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to retrieve Postgres config overrides: %w", err)
	} else if resp.JSON200 == nil {
		return nil, errors.Errorf("unexpected config overrides status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	var config map[string]any
	err = json.Unmarshal(resp.Body, &config)
	if err != nil {
		return nil, errors.Errorf("failed to unmarshal response body: %w", err)
	}
	return config, nil
}
