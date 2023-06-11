package update

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/postgresConfig/get"
	"github.com/supabase/cli/internal/utils"
	"strconv"
	"strings"
)

func Run(ctx context.Context, projectRef string, values []string, replaceOverrides bool, fsys afero.Fs) error {
	// 1. Prepare config overrides
	newConfigOverrides := make(map[string]string)
	for _, config := range values {
		splits := strings.Split(config, ":")
		if len(splits) != 2 {
			return fmt.Errorf("expected config value in key:value format, received: '%s'", config)
		}
		newConfigOverrides[splits[0]] = splits[1]
	}
	// 2. If not in replace mode, retrieve current overrides
	finalOverrides := make(map[string]interface{})
	{
		if !replaceOverrides {
			config, err := get.GetCurrentPostgresConfig(ctx, projectRef)
			if err != nil {
				return err
			}
			finalOverrides = config
		}
	}
	// 3. Create the list of final overrides
	{
		for k, v := range newConfigOverrides {
			// this is hacky - if we're able to convert the value to an integer, we do so
			// if we start supporting config fields with e.g. floating pt overrides this'll need to be updated
			attemptedConvert, err := strconv.Atoi(v)
			if err != nil {
				finalOverrides[k] = v
			} else {
				finalOverrides[k] = attemptedConvert
			}
		}
	}
	// 4. update config overrides and print out final result
	{
		bts, err := json.Marshal(finalOverrides)
		if err != nil {
			return fmt.Errorf("failed to serialize config overrides: %w", err)
		}
		resp, err := utils.GetSupabase().UpdateConfigWithBodyWithResponse(ctx, projectRef, "application/json", bytes.NewReader(bts))
		if err != nil {
			return err
		}
		if resp.JSON200 == nil {
			if resp.StatusCode() == 400 {
				return fmt.Errorf("failed to update config overrides: %s (%s). This usually indicates that an unsupported or invalid config override was attempted. Please refer to https://supabase.com/docs/guides/platform/custom-postgres-config", resp.Status(), string(resp.Body))
			}
			return fmt.Errorf("failed to update config overrides: %s", resp.Status())
		}
	}
	return get.Run(ctx, projectRef, fsys)
}
