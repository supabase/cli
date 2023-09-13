package tenant

import (
	"context"
	"errors"
	"fmt"

	"github.com/supabase/cli/internal/utils"
)

var errGotrueVersion = errors.New("GoTrue version not found.")

type HealthResponse struct {
	Version     string `json:"version"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func GetGotrueVersion(ctx context.Context, projectRef string) (string, error) {
	apiKey, err := GetApiKeys(ctx, projectRef)
	if err != nil {
		return "", err
	}
	url := fmt.Sprintf("https://%s/auth/v1/health", utils.GetSupabaseHost(projectRef))
	data, err := GetJsonResponse[HealthResponse](ctx, url, apiKey.Anon)
	if err != nil {
		return "", err
	}
	if len(data.Version) == 0 {
		return "", errGotrueVersion
	}
	return data.Version, nil
}
