package update

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/postgresConfig/get"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, values []string, replaceOverrides, noRestart bool, fsys afero.Fs) error {
	// 1. Prepare config overrides
	newConfigOverrides := make(map[string]string)
	for _, config := range values {
		splits := strings.Split(config, "=")
		if len(splits) != 2 {
			return errors.Errorf("expected config value in key:value format, received: '%s'", config)
		}
		newConfigOverrides[splits[0]] = splits[1]
	}
	// 2. If not in replace mode, retrieve current overrides
	finalOverrides := make(map[string]any)
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
			if vInt, err := strconv.Atoi(v); err == nil {
				finalOverrides[k] = vInt
			} else if vBool, err := strconv.ParseBool(v); err == nil {
				finalOverrides[k] = vBool
			} else {
				finalOverrides[k] = v
			}
		}
	}
	// 4. update config overrides and print out final result
	{
		if noRestart {
			finalOverrides["restart_database"] = false
		}
		// statement_timeout and wal_sender_timeout must be typed as string
		for k, v := range finalOverrides {
			if _, ok := v.(string); strings.HasSuffix(k, "_timeout") && !ok {
				finalOverrides[k] = fmt.Sprintf("%v", v)
			}
		}
		bts, err := json.Marshal(finalOverrides)
		if err != nil {
			return errors.Errorf("failed to serialize config overrides: %w", err)
		}
		resp, err := utils.GetSupabase().V1UpdatePostgresConfigWithBodyWithResponse(ctx, projectRef, "application/json", bytes.NewReader(bts))
		if err != nil {
			return errors.Errorf("failed to update config overrides: %w", err)
		} else if resp.JSON200 == nil {
			return errors.Errorf("unexpected update config overrides status %d: %s", resp.StatusCode(), string(resp.Body))
		}
		var config map[string]any
		err = json.Unmarshal(resp.Body, &config)
		if err != nil {
			return errors.Errorf("failed to unmarshal update response: %w", err)
		}
		return get.PrintOutPostgresConfigOverrides(config)
	}
}
