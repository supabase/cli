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
		return errors.Errorf("failed to delete config overrides: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected delete config overrides status %d: %s", resp.StatusCode(), string(resp.Body))
	}

	var config map[string]any
	err = json.Unmarshal(resp.Body, &config)
	if err != nil {
		return errors.Errorf("failed to unmarshal delete response: %w", err)
	}
	return get.PrintOutPostgresConfigOverrides(config)
}
