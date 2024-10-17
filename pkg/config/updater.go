package config

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	v1API "github.com/supabase/cli/pkg/api"
)

type ConfigUpdater struct {
	client v1API.ClientWithResponses
}

func NewConfigUpdater(client v1API.ClientWithResponses) ConfigUpdater {
	return ConfigUpdater{client: client}
}

func (u *ConfigUpdater) UpdateRemoteConfig(ctx context.Context, remote baseConfig) error {
	if err := u.UpdateApiConfig(ctx, remote.ProjectId, remote.Api); err != nil {
		return err
	}
	// TODO: implement other service configs, ie. auth
	return nil
}

func (u *ConfigUpdater) UpdateApiConfig(ctx context.Context, projectRef string, c api) error {
	apiConfig, err := u.client.V1GetPostgrestServiceConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read API config: %w", err)
	} else if apiConfig.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", apiConfig.StatusCode(), string(apiConfig.Body))
	}
	apiDiff, err := c.DiffWithRemote(*apiConfig.JSON200)
	if err != nil {
		return err
	} else if len(apiDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Remote API config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Updating API service with config:", string(apiDiff))
	if resp, err := u.client.V1UpdatePostgrestServiceConfigWithResponse(ctx, projectRef, c.ToUpdatePostgrestConfigBody()); err != nil {
		return errors.Errorf("failed to update API config: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return nil
}
