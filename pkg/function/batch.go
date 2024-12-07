package function

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/cenkalti/backoff/v4"
	"github.com/docker/go-units"
	"github.com/go-errors/errors"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/config"
)

const (
	eszipContentType = "application/vnd.denoland.eszip"
	maxRetries       = 3
)

func (s *EdgeRuntimeAPI) UpsertFunctions(ctx context.Context, functionConfig config.FunctionConfig, filter ...func(string) bool) error {
	var result []api.FunctionResponse
	if resp, err := s.client.V1ListAllFunctionsWithResponse(ctx, s.project); err != nil {
		return errors.Errorf("failed to list functions: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", resp.StatusCode(), string(resp.Body))
	} else {
		result = *resp.JSON200
	}
	exists := make(map[string]struct{}, len(result))
	for _, f := range result {
		exists[f.Slug] = struct{}{}
	}
	for slug, function := range functionConfig {
		if !function.IsEnabled() {
			fmt.Fprintln(os.Stderr, "Skipped deploying Function:", slug)
			continue
		}
		for _, keep := range filter {
			if !keep(slug) {
				continue
			}
		}
		var body bytes.Buffer
		if err := s.eszip.Bundle(ctx, function.Entrypoint, function.ImportMap, &body); err != nil {
			return err
		}
		// Update if function already exists
		upsert := func() error {
			if _, ok := exists[slug]; ok {
				if resp, err := s.client.V1UpdateAFunctionWithBodyWithResponse(ctx, s.project, slug, &api.V1UpdateAFunctionParams{
					VerifyJwt:      function.VerifyJWT,
					ImportMapPath:  toFileURL(function.ImportMap),
					EntrypointPath: toFileURL(function.Entrypoint),
				}, eszipContentType, bytes.NewReader(body.Bytes())); err != nil {
					return errors.Errorf("failed to update function: %w", err)
				} else if resp.JSON200 == nil {
					return errors.Errorf("unexpected status %d: %s", resp.StatusCode(), string(resp.Body))
				}
			} else {
				if resp, err := s.client.V1CreateAFunctionWithBodyWithResponse(ctx, s.project, &api.V1CreateAFunctionParams{
					Slug:           &slug,
					Name:           &slug,
					VerifyJwt:      function.VerifyJWT,
					ImportMapPath:  toFileURL(function.ImportMap),
					EntrypointPath: toFileURL(function.Entrypoint),
				}, eszipContentType, bytes.NewReader(body.Bytes())); err != nil {
					return errors.Errorf("failed to create function: %w", err)
				} else if resp.JSON201 == nil {
					return errors.Errorf("unexpected status %d: %s", resp.StatusCode(), string(resp.Body))
				}
			}
			return nil
		}
		functionSize := units.HumanSize(float64(body.Len()))
		fmt.Fprintf(os.Stderr, "Deploying Function: %s (script size: %s)\n", slug, functionSize)
		policy := backoff.WithContext(backoff.WithMaxRetries(backoff.NewExponentialBackOff(), maxRetries), ctx)
		if err := backoff.Retry(upsert, policy); err != nil {
			return err
		}
	}
	return nil
}

func toFileURL(hostPath string) *string {
	absHostPath, err := filepath.Abs(hostPath)
	if err != nil {
		return nil
	}
	// Convert to unix path because edge runtime only supports linux
	parsed := url.URL{Scheme: "file", Path: toUnixPath(absHostPath)}
	result := parsed.String()
	return &result
}

func toUnixPath(absHostPath string) string {
	prefix := filepath.VolumeName(absHostPath)
	unixPath := filepath.ToSlash(absHostPath)
	return strings.TrimPrefix(unixPath, prefix)
}
