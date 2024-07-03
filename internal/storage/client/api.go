package client

import (
	"context"

	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/tenant"
	"github.com/supabase/cli/pkg/fetcher"
	"github.com/supabase/cli/pkg/storage"
)

func NewStorageAPI(ctx context.Context, projectRef string) (storage.StorageAPI, error) {
	server := utils.GetApiUrl("")
	token := utils.Config.Auth.ServiceRoleKey
	if len(projectRef) > 0 {
		server = "https://" + utils.GetSupabaseHost(projectRef)
		// Special case for calling storage API without personal access token
		if !viper.IsSet("AUTH_SERVICE_ROLE_KEY") {
			apiKey, err := tenant.GetApiKeys(ctx, projectRef)
			if err != nil {
				return storage.StorageAPI{}, err
			}
			token = apiKey.ServiceRole
		}
	}
	api := storage.StorageAPI{Fetcher: fetcher.NewFetcher(
		server,
		fetcher.WithBearerToken(token),
		fetcher.WithUserAgent("SupabaseCLI/"+utils.Version),
	)}
	return api, nil
}
