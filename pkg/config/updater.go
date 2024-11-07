package config

import (
	"context"

	v1API "github.com/supabase/cli/pkg/api"
)

type ConfigUpdater struct {
	client v1API.ClientWithResponses
}

func NewConfigUpdater(client v1API.ClientWithResponses) ConfigUpdater {
	return ConfigUpdater{client: client}
}

func (u *ConfigUpdater) UpdateLocalConfig(ctx context.Context, local baseConfig) error {
	if err := u.UpdateLocalApiConfig(ctx, local.ProjectId, local.Api); err != nil {
		return err
	}
	return nil
}

func (u *ConfigUpdater) UpdateRemoteConfig(ctx context.Context, remote baseConfig) error {
	if err := u.UpdateApiConfig(ctx, remote.ProjectId, remote.Api); err != nil {
		return err
	}
	if err := u.UpdateDbConfig(ctx, remote.ProjectId, remote.Db); err != nil {
		return err
	}
	if err := u.UpdateAuthConfig(ctx, remote.ProjectId, remote.Auth); err != nil {
		return err
	}
	if err := u.UpdateStorageConfig(ctx, remote.ProjectId, remote.Storage); err != nil {
		return err
	}
	if err := u.UpdateExperimentalConfig(ctx, remote.ProjectId, remote.Experimental); err != nil {
		return err
	}
	return nil
}
