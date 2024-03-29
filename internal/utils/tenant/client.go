package tenant

import (
	"context"
	"net/http"
	"sync"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

var (
	apiKey  ApiKey
	keyOnce sync.Once

	ErrAuthToken  = errors.New("Authorization failed for the access token and project ref pair")
	errMissingKey = errors.New("Anon key not found.")
)

type ApiKey struct {
	Anon        string
	ServiceRole string
}

func (a ApiKey) IsEmpty() bool {
	return len(apiKey.Anon) == 0 && len(apiKey.ServiceRole) == 0
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

func SetApiKeys(keys ApiKey) {
	keyOnce.Do(func() {
		apiKey = keys
	})
}

func GetApiKeys(ctx context.Context, projectRef string) (ApiKey, error) {
	var errKey error
	keyOnce.Do(func() {
		resp, err := utils.GetSupabase().GetProjectApiKeysWithResponse(ctx, projectRef)
		if err != nil {
			errKey = errors.Errorf("failed to get api keys: %w", err)
			return
		}
		if resp.JSON200 == nil {
			errKey = errors.Errorf("%w: %s", ErrAuthToken, string(resp.Body))
			return
		}
		apiKey = NewApiKey(*resp.JSON200)
		if apiKey.IsEmpty() {
			errKey = errors.New(errMissingKey)
		}
	})
	return apiKey, errKey
}

func GetJsonResponse[T any](ctx context.Context, url, apiKey string) (*T, error) {
	return utils.JsonResponse[T](ctx, http.MethodGet, url, nil, func(ctx context.Context, req *http.Request) error {
		req.Header.Add("apikey", apiKey)
		return nil
	})
}

func JsonResponseWithBearer[T any](ctx context.Context, method, url, token string, reqBody any) (*T, error) {
	return utils.JsonResponse[T](ctx, method, url, reqBody, func(ctx context.Context, req *http.Request) error {
		req.Header.Add("Authorization", "Bearer "+token)
		return nil
	})
}

func GetTextResponse(ctx context.Context, url, apiKey string) (string, error) {
	return utils.TextResponse(ctx, http.MethodGet, url, nil, func(ctx context.Context, req *http.Request) error {
		req.Header.Add("apikey", apiKey)
		return nil
	})
}
