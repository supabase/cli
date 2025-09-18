package get

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	// 1. get current config
	config, err := GetCurrentPostgresConfig(ctx, projectRef)
	if err != nil {
		return err
	}
	err = PrintOutPostgresConfigOverrides(config)
	if err != nil {
		return err
	}
	return nil
}

func PrintOutPostgresConfigOverrides(config map[string]any) error {
	if utils.OutputFormat.Value != utils.OutputPretty {
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, config)
	}
	fmt.Println("- Custom Postgres Config -")
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
	fmt.Println("- End of Custom Postgres Config -")
	return nil
}

func GetCurrentPostgresConfig(ctx context.Context, projectRef string) (map[string]any, error) {
	resp, err := utils.GetSupabase().V1GetPostgresConfig(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to retrieve Postgres config overrides: %w", err)
	}
	if resp.StatusCode != 200 {
		return nil, errors.Errorf("error in retrieving Postgres config overrides: %s", resp.Status)
	}
	contents, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, errors.Errorf("failed to read response body: %w", err)
	}
	var config map[string]any
	err = json.Unmarshal(contents, &config)
	if err != nil {
		return nil, errors.Errorf("failed to unmarshal response body: %w. Contents were %s", err, contents)
	}
	return config, nil
}
