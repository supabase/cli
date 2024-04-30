package tenant

import (
	"context"
	"net/http"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/pkg/fetcher"
)

var errGotrueVersion = errors.New("GoTrue version not found.")

type HealthResponse struct {
	Version     string `json:"version"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func GetGotrueVersion(ctx context.Context, api *fetcher.Fetcher) (string, error) {
	resp, err := api.Send(ctx, http.MethodGet, "/auth/v1/health", nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := fetcher.ParseJSON[HealthResponse](resp.Body)
	if err != nil {
		return "", err
	}
	if len(data.Version) == 0 {
		return "", errors.New(errGotrueVersion)
	}
	return data.Version, nil
}
