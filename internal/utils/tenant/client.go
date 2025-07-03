package tenant

import (
	"context"
	"net/http"
	"time"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
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
		switch key.Name {
		case "anon":
			result.Anon = value
		case "service_role":
			result.ServiceRole = value
		}
	}
	return result
}

func GetApiKeys(ctx context.Context, projectRef string) (ApiKey, error) {
	resp, err := utils.GetSupabase().V1GetProjectApiKeysWithResponse(ctx, projectRef, &api.V1GetProjectApiKeysParams{})
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

func NewTenantAPI(ctx context.Context, projectRef, anonKey string) TenantAPI {
	server := "https://" + utils.GetSupabaseHost(projectRef)
	client := &http.Client{
		Timeout: 10 * time.Second,
	}
	header := func(req *http.Request) {
		req.Header.Add("apikey", anonKey)
	}
	api := TenantAPI{Fetcher: fetcher.NewFetcher(
		server,
		fetcher.WithHTTPClient(client),
		fetcher.WithRequestEditor(header),
		fetcher.WithUserAgent("SupabaseCLI/"+utils.Version),
		fetcher.WithExpectedStatus(http.StatusOK),
	)}
	return api
}
