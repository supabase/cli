package config

import (
	"context"
	"fmt"
	"os"
	"sort"

	v1API "github.com/supabase/cli/pkg/api"
)

type ConfigUpdater struct {
	client v1API.ClientWithResponses
}

func NewConfigUpdater(client v1API.ClientWithResponses) ConfigUpdater {
	return ConfigUpdater{client: client}
}

func (u *ConfigUpdater) PrintConfigDiff(servicesDiff map[string][]byte) {
	// sort the services keys to have consistent diff print
	services := make([]string, 0, len(servicesDiff))
	for service := range servicesDiff {
		services = append(services, service)
	}
	sort.Strings(services)

	// print diff for each service
	for _, service := range services {
		if diff := servicesDiff[service]; len(diff) > 0 {
			fmt.Fprintf(os.Stderr, "%s\n", string(diff))
		}
	}
}

func (u *ConfigUpdater) UpdateLocalConfig(ctx context.Context, local baseConfig) (map[string][]byte, error) {
	diffs := make(map[string][]byte)

	if diff, err := u.UpdateLocalApiConfig(ctx, local.ProjectId, &local.Api); err != nil {
		return nil, err
	} else if diff != nil {
		diffs["api"] = diff
	}

	if diff, err := u.UpdateLocalDbConfig(ctx, local.ProjectId, &local.Db); err != nil {
		return nil, err
	} else if diff != nil {
		diffs["db"] = diff
	}

	if diff, err := u.UpdateLocalAuthConfig(ctx, local.ProjectId, &local.Auth); err != nil {
		return nil, err
	} else if diff != nil {
		diffs["auth"] = diff
	}

	if diff, err := u.UpdateLocalStorageConfig(ctx, local.ProjectId, &local.Storage); err != nil {
		return nil, err
	} else if diff != nil {
		diffs["storage"] = diff
	}

	return diffs, nil
}

func (u *ConfigUpdater) UpdateRemoteConfig(ctx context.Context, remote baseConfig, filter ...func(string) bool) error {
	if err := u.UpdateApiConfig(ctx, remote.ProjectId, remote.Api, filter...); err != nil {
		return err
	}
	if err := u.UpdateDbConfig(ctx, remote.ProjectId, remote.Db, filter...); err != nil {
		return err
	}
	if err := u.UpdateAuthConfig(ctx, remote.ProjectId, remote.Auth, filter...); err != nil {
		return err
	}
	if err := u.UpdateStorageConfig(ctx, remote.ProjectId, remote.Storage, filter...); err != nil {
		return err
	}
	if err := u.UpdateExperimentalConfig(ctx, remote.ProjectId, remote.Experimental, filter...); err != nil {
		return err
	}
	return nil
}
