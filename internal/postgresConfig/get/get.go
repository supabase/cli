package get

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"io"
	"os"
	"text/tabwriter"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	// 1. get current config
	{
		config, err := GetCurrentPostgresConfig(ctx, projectRef)
		if err != nil {
			return err
		}
		PrintOutPostgresConfigOverrides(config)
		return nil
	}
}

func PrintOutPostgresConfigOverrides(config map[string]interface{}) {
	fmt.Println("- Custom Postgres Config -")
	const padding = 4
	w := tabwriter.NewWriter(os.Stdout, 0, 0, padding, ' ', tabwriter.Debug)
	fmt.Fprintf(w, "Config\tValue\t\n")
	for k, v := range config {
		fmt.Fprintf(w, "%s\t%+v\t\n", k, v)
	}
	w.Flush()
	fmt.Println("- End of Custom Postgres Config -")
}

func GetCurrentPostgresConfig(ctx context.Context, projectRef string) (map[string]interface{}, error) {
	resp, err := utils.GetSupabase().GetConfig(ctx, projectRef)
	if err != nil {
		return nil, fmt.Errorf("failed to retrieve Postgres config overrides: %w", err)
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("error in retrieving Postgres config overrides: %s", resp.Status)
	}
	contents, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	var config map[string]interface{}
	err = json.Unmarshal(contents, &config)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal response body: %w. Contents were %s", err, contents)
	}
	return config, nil
}
