package config

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
)

func (u *ConfigUpdater) UpdateLocalApiConfig(ctx context.Context, projectRef string, c api) error {
	apiConfig, err := u.client.V1GetPostgrestServiceConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read API config: %w", err)
	} else if apiConfig.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", apiConfig.StatusCode(), string(apiConfig.Body))
	}
	newConfig := c.fromRemoteApiConfig(*apiConfig.JSON200)
	apiDiff, err := c.DiffWithRemote(*apiConfig.JSON200)
	if err != nil {
		return err
	} else if len(apiDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Local API config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Diff found between local API config with remote values:", string(apiDiff))
	c = newConfig
	return nil
}
