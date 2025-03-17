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
	toUpdate := map[string]api.BulkUpdateFunctionBody{}
OUTER:
	for slug, function := range functionConfig {
		if !function.Enabled {
			fmt.Fprintln(os.Stderr, "Skipped deploying Function:", slug)
			continue
		}
		for _, keep := range filter {
			if !keep(slug) {
				continue OUTER
			}
		}
		var body bytes.Buffer
		if err := s.eszip.Bundle(ctx, slug, function.Entrypoint, function.ImportMap, function.StaticFiles, &body); err != nil {
			return err
		}
		// Update if function already exists
		upsert := func() error {
			if _, ok := exists[slug]; ok {
				resp, err := s.client.V1UpdateAFunctionWithBodyWithResponse(ctx, s.project, slug, &api.V1UpdateAFunctionParams{
					VerifyJwt:      &function.VerifyJWT,
					ImportMapPath:  toFileURL(function.ImportMap),
					EntrypointPath: toFileURL(function.Entrypoint),
				}, eszipContentType, bytes.NewReader(body.Bytes()))
				if err != nil {
					return errors.Errorf("failed to update function: %w", err)
				} else if resp.JSON200 == nil {
					return errors.Errorf("unexpected status %d: %s", resp.StatusCode(), string(resp.Body))
				}
				toUpdate[slug] = api.BulkUpdateFunctionBody{
					Id:             resp.JSON200.Id,
					Name:           resp.JSON200.Name,
					Slug:           resp.JSON200.Slug,
					Version:        resp.JSON200.Version,
					EntrypointPath: resp.JSON200.EntrypointPath,
					ImportMap:      resp.JSON200.ImportMap,
					ImportMapPath:  resp.JSON200.ImportMapPath,
					VerifyJwt:      resp.JSON200.VerifyJwt,
					Status:         api.BulkUpdateFunctionBodyStatus(resp.JSON200.Status),
					CreatedAt:      &resp.JSON200.CreatedAt,
				}
			} else {
				resp, err := s.client.V1CreateAFunctionWithBodyWithResponse(ctx, s.project, &api.V1CreateAFunctionParams{
					Slug:           &slug,
					Name:           &slug,
					VerifyJwt:      &function.VerifyJWT,
					ImportMapPath:  toFileURL(function.ImportMap),
					EntrypointPath: toFileURL(function.Entrypoint),
				}, eszipContentType, bytes.NewReader(body.Bytes()))
				if err != nil {
					return errors.Errorf("failed to create function: %w", err)
				} else if resp.JSON201 == nil {
					return errors.Errorf("unexpected status %d: %s", resp.StatusCode(), string(resp.Body))
				}
				toUpdate[slug] = api.BulkUpdateFunctionBody{
					Id:             resp.JSON201.Id,
					Name:           resp.JSON201.Name,
					Slug:           resp.JSON201.Slug,
					Version:        resp.JSON201.Version,
					EntrypointPath: resp.JSON201.EntrypointPath,
					ImportMap:      resp.JSON201.ImportMap,
					ImportMapPath:  resp.JSON201.ImportMapPath,
					VerifyJwt:      resp.JSON201.VerifyJwt,
					Status:         api.BulkUpdateFunctionBodyStatus(resp.JSON201.Status),
					CreatedAt:      &resp.JSON201.CreatedAt,
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
	if len(toUpdate) > 1 {
		var body []api.BulkUpdateFunctionBody
		for _, b := range toUpdate {
			body = append(body, b)
		}
		if resp, err := s.client.V1BulkUpdateFunctionsWithResponse(ctx, s.project, body); err != nil {
			return errors.Errorf("failed to bulk update: %w", err)
		} else if resp.JSON200 == nil {
			return errors.Errorf("unexpected bulk update status %d: %s", resp.StatusCode(), string(resp.Body))
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
