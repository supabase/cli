package get

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	// 1. get current config
	{
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
}

func PrintOutPostgresConfigOverrides(config map[string]interface{}) error {
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

	if err := list.RenderTable(strings.Join(markdownTable, "")); err != nil {
		return err
	}
	fmt.Println("- End of Custom Postgres Config -")
	return nil
}

func GetCurrentPostgresConfig(ctx context.Context, projectRef string) (map[string]interface{}, error) {
	resp, err := utils.GetSupabase().GetConfig(ctx, projectRef)
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

	var config map[string]interface{}
	err = json.Unmarshal(contents, &config)
	if err != nil {
		return nil, errors.Errorf("failed to unmarshal response body: %w. Contents were %s", err, contents)
	}
	return config, nil
}
