package client

import (
	"context"
	"fmt"

	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/tenant"
	"github.com/supabase/cli/pkg/fetcher"
	"github.com/supabase/cli/pkg/storage"
)

func NewStorageAPI(ctx context.Context, projectRef string) (storage.StorageAPI, error) {
	server := fmt.Sprintf("http://%s:%d", utils.Config.Hostname, utils.Config.Api.Port)
	token := utils.Config.Auth.ServiceRoleKey
	if len(projectRef) > 0 {
		server = "https://" + utils.GetSupabaseHost(projectRef)
		apiKey, err := tenant.GetApiKeys(ctx, projectRef)
		if err != nil {
			return storage.StorageAPI{}, err
		}
		token = apiKey.ServiceRole
	}
	api := storage.StorageAPI{Fetcher: fetcher.NewFetcher(
		server,
		fetcher.WithBearerToken(token),
		fetcher.WithUserAgent("SupabaseCLI/"+utils.Version),
	)}
	return api, nil
}
