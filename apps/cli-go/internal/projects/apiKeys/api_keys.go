package apiKeys

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/oapi-codegen/nullable"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) error {
	keys, err := RunGetApiKeys(ctx, projectRef)
	if err != nil {
		return err
	}

	switch utils.OutputFormat.Value {
	case utils.OutputPretty:
		table := `|NAME|KEY VALUE|
|-|-|
`
		for _, entry := range keys {
			k := strings.ReplaceAll(entry.Name, "|", "\\|")
			v := toValue(entry.ApiKey)
			table += fmt.Sprintf("|`%s`|`%s`|\n", k, v)
		}

		return utils.RenderTable(table)
	case utils.OutputToml, utils.OutputEnv:
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, ToEnv(keys))
	}

	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, keys)
}

func RunGetApiKeys(ctx context.Context, projectRef string) ([]api.ApiKeyResponse, error) {
	resp, err := utils.GetSupabase().V1GetProjectApiKeysWithResponse(ctx, projectRef, &api.V1GetProjectApiKeysParams{})
	if err != nil {
		return nil, errors.Errorf("failed to get api keys: %w", err)
	} else if resp.JSON200 == nil {
		return nil, errors.Errorf("unexpected get api keys status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return *resp.JSON200, nil
}

func ToEnv(keys []api.ApiKeyResponse) map[string]string {
	envs := make(map[string]string, len(keys))
	for _, entry := range keys {
		key := fmt.Sprintf("SUPABASE_%s_KEY", envSuffix(entry))
		envs[key] = toValue(entry.ApiKey)
	}
	return envs
}

// envSuffix maps an API key to the middle part of SUPABASE_<SUFFIX>_KEY.
// Publishable keys named "default" become PUBLISHABLE (not DEFAULT) to avoid
// colliding with the default secret key.
func envSuffix(entry api.ApiKeyResponse) string {
	if t, err := entry.Type.Get(); err == nil && t == api.ApiKeyResponseTypePublishable && entry.Name == "default" {
		return "PUBLISHABLE"
	}
	return strings.ToUpper(entry.Name)
}

func toValue(v nullable.Nullable[string]) string {
	if value, err := v.Get(); err == nil {
		return value
	}
	return "******"
}
