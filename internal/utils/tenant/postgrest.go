package tenant

import (
	"context"
	"errors"
	"fmt"

	"github.com/supabase/cli/internal/utils"
)

var errPostgrestVersion = errors.New("PostgREST version not found.")

type SwaggerInfo struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Version     string `json:"version"`
}

type SwaggerResponse struct {
	Swagger string      `json:"swagger"`
	Info    SwaggerInfo `json:"info"`
}

func GetPostgrestVersion(ctx context.Context, projectRef string) (string, error) {
	apiKey, err := GetApiKeys(ctx, projectRef)
	if err != nil {
		return "", err
	}
	url := fmt.Sprintf("https://%s/rest/v1/", utils.GetSupabaseHost(projectRef))
	data, err := GetJsonResponse[SwaggerResponse](ctx, url, apiKey.Anon)
	if err != nil {
		return "", err
	}
	if len(data.Info.Version) == 0 {
		return "", errPostgrestVersion
	}
	return "v" + data.Info.Version, nil
}
