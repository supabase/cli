package tenant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"

	"github.com/supabase/cli/internal/utils"
)

var (
	apiKey  ApiKey
	keyOnce sync.Once

	errAuthToken  = errors.New("Authorization failed for the access token and project ref pair")
	errMissingKey = errors.New("Anon key not found.")
)

type ApiKey struct {
	Anon        string
	ServiceRole string
}

func (a ApiKey) IsEmpty() bool {
	return len(apiKey.Anon) == 0 && len(apiKey.ServiceRole) == 0
}

func GetApiKeys(ctx context.Context, projectRef string) (ApiKey, error) {
	var errKey error
	keyOnce.Do(func() {
		resp, err := utils.GetSupabase().GetProjectApiKeysWithResponse(ctx, projectRef)
		if err != nil {
			errKey = err
			return
		}
		if resp.JSON200 == nil {
			errKey = fmt.Errorf("%w: %s", errAuthToken, string(resp.Body))
			return
		}
		for _, key := range *resp.JSON200 {
			if key.Name == "anon" {
				apiKey.Anon = key.ApiKey
			}
			if key.Name == "service_role" {
				apiKey.ServiceRole = key.ApiKey
			}
		}
		if apiKey.IsEmpty() {
			errKey = errMissingKey
		}
	})
	return apiKey, errKey
}

func GetJsonResponse[T any](ctx context.Context, url, apiKey string) (*T, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	if len(apiKey) > 0 {
		req.Header.Add("apikey", apiKey)
	}
	// Sends request
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, err := io.ReadAll(resp.Body)
		if err != nil || len(body) == 0 {
			body = []byte(fmt.Sprintf("Error status %d", resp.StatusCode))
		}
		return nil, errors.New(string(body))
	}
	// Parses response
	var data T
	dec := json.NewDecoder(resp.Body)
	if err := dec.Decode(&data); err != nil {
		return nil, err
	}
	return &data, nil
}
