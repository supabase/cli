package tenant

import (
	"context"
	"strings"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/fetcher"
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
		value, err := key.ApiKey.Get()
		if err != nil {
			continue
		}
		if t, err := key.Type.Get(); err == nil {
			switch t {
			case api.ApiKeyResponseTypePublishable:
				result.Anon = value
				continue
			case api.ApiKeyResponseTypeSecret:
				if isServiceRole(key) {
					result.ServiceRole = value
				}
				continue
			}
		}
		switch key.Name {
		case "anon":
			if len(result.Anon) == 0 {
				result.Anon = value
			}
		case "service_role":
			if len(result.ServiceRole) == 0 {
				result.ServiceRole = value
			}
		}
	}
	return result
}

func isServiceRole(key api.ApiKeyResponse) bool {
	if tmpl, err := key.SecretJwtTemplate.Get(); err == nil {
		if role, ok := tmpl["role"].(string); ok {
			return strings.EqualFold(role, "service_role")
		}
	}
	return false
}

func GetApiKeys(ctx context.Context, projectRef string) (ApiKey, error) {
	resp, err := utils.GetSupabase().V1GetProjectApiKeysWithResponse(ctx, projectRef, &api.V1GetProjectApiKeysParams{
		Reveal: cast.Ptr(true),
	})
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

type TenantAPI struct {
	*fetcher.Fetcher
}

func NewTenantAPI(ctx context.Context, projectRef, serviceKey string) TenantAPI {
	return TenantAPI{Fetcher: fetcher.NewServiceGateway(
		"https://"+utils.GetSupabaseHost(projectRef),
		serviceKey,
		fetcher.WithUserAgent("SupabaseCLI/"+utils.Version),
	)}
}
