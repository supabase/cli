package client

import (
	"context"
	"net/http"

	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/status"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/tenant"
	"github.com/supabase/cli/pkg/fetcher"
	"github.com/supabase/cli/pkg/storage"
)

func NewStorageAPI(ctx context.Context, projectRef string) (storage.StorageAPI, error) {
	client := storage.StorageAPI{}
	if len(projectRef) == 0 {
		client.Fetcher = newLocalClient()
	} else if viper.IsSet("AUTH_SERVICE_ROLE_KEY") {
		// Special case for calling storage API without personal access token
		client.Fetcher = newRemoteClient(projectRef, utils.Config.Auth.ServiceRoleKey.Value)
	} else if apiKey, err := tenant.GetApiKeys(ctx, projectRef); err == nil {
		client.Fetcher = newRemoteClient(projectRef, apiKey.ServiceRole)
	} else {
		return client, err
	}
	return client, nil
}

func newLocalClient() *fetcher.Fetcher {
	client := status.NewKongClient()
	return fetcher.NewFetcher(
		utils.Config.Api.ExternalUrl,
		fetcher.WithHTTPClient(client),
		fetcher.WithBearerToken(utils.Config.Auth.ServiceRoleKey.Value),
		fetcher.WithUserAgent("SupabaseCLI/"+utils.Version),
		fetcher.WithExpectedStatus(http.StatusOK),
	)
}

func newRemoteClient(projectRef, token string) *fetcher.Fetcher {
	return fetcher.NewFetcher(
		"https://"+utils.GetSupabaseHost(projectRef),
		fetcher.WithBearerToken(token),
		fetcher.WithUserAgent("SupabaseCLI/"+utils.Version),
		fetcher.WithExpectedStatus(http.StatusOK),
	)
}
