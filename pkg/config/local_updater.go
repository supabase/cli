package config

import (
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
)

func (u *ConfigUpdater) UpdateLocalApiConfig(ctx context.Context, projectRef string, c *api) error {
	apiConfig, err := u.client.V1GetPostgrestServiceConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read API config: %w", err)
	} else if apiConfig.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", apiConfig.StatusCode(), string(apiConfig.Body))
	}
	newConfig := *c
	newConfig.fromRemoteApiConfig(*apiConfig.JSON200)
	apiDiff, err := c.DiffWithRemote(*apiConfig.JSON200)
	if err != nil {
		return err
	} else if len(apiDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Local API config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Diff found between local API config with remote values:", string(apiDiff))
	*c = newConfig
	return nil
}

func (u *ConfigUpdater) UpdateLocalDbSettingsConfig(ctx context.Context, projectRef string, s *settings) error {
	dbConfig, err := u.client.V1GetPostgresConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read DB config: %w", err)
	} else if dbConfig.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", dbConfig.StatusCode(), string(dbConfig.Body))
	}
	dbDiff, err := s.DiffWithRemote(*dbConfig.JSON200)
	if err != nil {
		return err
	} else if len(dbDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Local DB config is up to date with remote.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Updating local DB config with remote values:", string(dbDiff))
	newSettings := *s
	newSettings.fromRemoteConfig(*dbConfig.JSON200)
	*s = newSettings
	return nil
}
func (u *ConfigUpdater) UpdateLocalDbConfig(ctx context.Context, projectRef string, c *db) error {
	if err := u.UpdateDbSettingsConfig(ctx, projectRef, c.Settings); err != nil {
		return err
	}
	return nil
}

func (u *ConfigUpdater) UpdateLocalAuthConfig(ctx context.Context, projectRef string, c *auth) error {
	if !c.Enabled {
		return nil
	}
	authConfig, err := u.client.V1GetAuthServiceConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read Auth config: %w", err)
	} else if authConfig.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", authConfig.StatusCode(), string(authConfig.Body))
	}
	authDiff, err := c.DiffWithRemote(projectRef, *authConfig.JSON200)
	if err != nil {
		return err
	} else if len(authDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Local Auth config is up to date with remote.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Updating local Auth config with remote values:", string(authDiff))
	newAuthConfig := *c
	newAuthConfig.fromRemoteAuthConfig(*authConfig.JSON200)
	*c = newAuthConfig
	return nil
}

func (u *ConfigUpdater) UpdateLocalStorageConfig(ctx context.Context, projectRef string, c *storage) error {
	if !c.Enabled {
		return nil
	}
	storageConfig, err := u.client.V1GetStorageConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read Storage config: %w", err)
	} else if storageConfig.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", storageConfig.StatusCode(), string(storageConfig.Body))
	}
	storageDiff, err := c.DiffWithRemote(*storageConfig.JSON200)
	if err != nil {
		return err
	} else if len(storageDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Local Storage config is up to date with remote.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Updating local Storage config with remote values:", string(storageDiff))
	newStorageConfig := *c
	newStorageConfig.fromRemoteStorageConfig(*storageConfig.JSON200)
	*c = newStorageConfig
	return nil
}
