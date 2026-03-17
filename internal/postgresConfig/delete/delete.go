package delete

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/postgresConfig/get"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, configKeys []string, noRestart bool, fsys afero.Fs) error {
	// 1. Get current config
	currentConfig, err := get.GetCurrentPostgresConfig(ctx, projectRef)
	if err != nil {
		return err
	}

	// 2. Remove specified keys
	for _, key := range configKeys {
		delete(currentConfig, strings.TrimSpace(key))
	}

	// 3. Update config with removed keys
	if noRestart {
		currentConfig["restart_database"] = false
	}
	bts, err := json.Marshal(currentConfig)
	if err != nil {
		return errors.Errorf("failed to serialize config overrides: %w", err)
	}

	resp, err := utils.GetSupabase().V1UpdatePostgresConfigWithBodyWithResponse(ctx, projectRef, "application/json", bytes.NewReader(bts))
	if err != nil {
		return errors.Errorf("failed to update config overrides: %w", err)
	}
	if resp.JSON200 == nil {
		if resp.StatusCode() == 400 {
			return errors.Errorf("failed to update config overrides: %s (%s). This usually indicates that an unsupported or invalid config override was attempted. Please refer to https://supabase.com/docs/guides/platform/custom-postgres-config", resp.Status(), string(resp.Body))
		}
		return errors.Errorf("failed to update config overrides: %s (%s)", resp.Status(), string(resp.Body))
	}

	return get.Run(ctx, projectRef, fsys)
}
