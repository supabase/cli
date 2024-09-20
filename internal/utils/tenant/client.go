package tenant

import (
	"context"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/fetcher"
	"github.com/supabase/cli/pkg/version"
)

var (
	ErrAuthToken  = errors.New("Authorization failed for the access token and project ref pair")
	errMissingKey = errors.New("Anon key not found.")
)

type ApiKey struct {
	Anon        string
	ServiceRole string
}

func (a ApiKey) IsEmpty() bool {
	return len(a.Anon) == 0 && len(a.ServiceRole) == 0
}

func NewApiKey(resp []api.ApiKeyResponse) ApiKey {
	var result ApiKey
	for _, key := range resp {
		if key.Name == "anon" {
			result.Anon = key.ApiKey
		}
		if key.Name == "service_role" {
			result.ServiceRole = key.ApiKey
		}
	}
	return result
}

func GetApiKeys(ctx context.Context, projectRef string) (ApiKey, error) {
	resp, err := utils.GetSupabase().V1GetProjectApiKeysWithResponse(ctx, projectRef)
	if err != nil {
		return ApiKey{}, errors.Errorf("failed to get api keys: %w", err)
	}
	if resp.JSON200 == nil {
		return ApiKey{}, errors.Errorf("%w: %s", ErrAuthToken, string(resp.Body))
	}
	keys := NewApiKey(*resp.JSON200)
	if keys.IsEmpty() {
		return ApiKey{}, errors.New(errMissingKey)
	}
	return keys, nil
}

func NewTenantAPI(projectRef, anonKey string) version.ServiceGateway {
	server := "https://" + utils.GetSupabaseHost(projectRef)
	return version.NewServiceGateway(
		server,
		anonKey,
		fetcher.WithUserAgent("SupabaseCLI/"+utils.Version),
	)
}
