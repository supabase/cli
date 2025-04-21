package function

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

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
		return errors.Errorf("unexpected list functions status %d: %s", resp.StatusCode(), string(resp.Body))
	} else {
		result = *resp.JSON200
	}
	exists := make(map[string]struct{}, len(result))
	for _, f := range result {
		exists[f.Slug] = struct{}{}
	}
	policy := backoff.WithContext(backoff.WithMaxRetries(backoff.NewExponentialBackOff(), maxRetries), ctx)
	var toUpdate []api.BulkUpdateFunctionBody
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
		meta, err := s.eszip.Bundle(ctx, slug, function.Entrypoint, function.ImportMap, function.StaticFiles, &body)
		if err != nil {
			return err
		}
		meta.VerifyJwt = &function.VerifyJWT
		// Update if function already exists
		upsert := func() (api.BulkUpdateFunctionBody, error) {
			if _, ok := exists[slug]; ok {
				return s.updateFunction(ctx, slug, meta, bytes.NewReader(body.Bytes()))
			}
			return s.createFunction(ctx, slug, meta, bytes.NewReader(body.Bytes()))
		}
		functionSize := units.HumanSize(float64(body.Len()))
		fmt.Fprintf(os.Stderr, "Deploying Function: %s (script size: %s)\n", slug, functionSize)
		result, err := backoff.RetryNotifyWithData(upsert, policy, func(err error, d time.Duration) {
			if strings.Contains(err.Error(), "Duplicated function slug") {
				exists[slug] = struct{}{}
			}
		})
		if err != nil {
			return err
		}
		toUpdate = append(toUpdate, result)
		policy.Reset()
	}
	if len(toUpdate) > 1 {
		if resp, err := s.client.V1BulkUpdateFunctionsWithResponse(ctx, s.project, toUpdate); err != nil {
			return errors.Errorf("failed to bulk update: %w", err)
		} else if resp.JSON200 == nil {
			return errors.Errorf("unexpected bulk update status %d: %s", resp.StatusCode(), string(resp.Body))
		}
	}
	return nil
}

func (s *EdgeRuntimeAPI) updateFunction(ctx context.Context, slug string, meta api.FunctionDeployMetadata, body io.Reader) (api.BulkUpdateFunctionBody, error) {
	resp, err := s.client.V1UpdateAFunctionWithBodyWithResponse(ctx, s.project, slug, &api.V1UpdateAFunctionParams{
		VerifyJwt:      meta.VerifyJwt,
		ImportMapPath:  meta.ImportMapPath,
		EntrypointPath: &meta.EntrypointPath,
	}, eszipContentType, body)
	if err != nil {
		return api.BulkUpdateFunctionBody{}, errors.Errorf("failed to update function: %w", err)
	} else if resp.JSON200 == nil {
		return api.BulkUpdateFunctionBody{}, errors.Errorf("unexpected update function status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return api.BulkUpdateFunctionBody{
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
	}, nil
}

func (s *EdgeRuntimeAPI) createFunction(ctx context.Context, slug string, meta api.FunctionDeployMetadata, body io.Reader) (api.BulkUpdateFunctionBody, error) {
	resp, err := s.client.V1CreateAFunctionWithBodyWithResponse(ctx, s.project, &api.V1CreateAFunctionParams{
		Slug:           &slug,
		Name:           &slug,
		VerifyJwt:      meta.VerifyJwt,
		ImportMapPath:  meta.ImportMapPath,
		EntrypointPath: &meta.EntrypointPath,
	}, eszipContentType, body)
	if err != nil {
		return api.BulkUpdateFunctionBody{}, errors.Errorf("failed to create function: %w", err)
	} else if resp.JSON201 == nil {
		return api.BulkUpdateFunctionBody{}, errors.Errorf("unexpected create function status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return api.BulkUpdateFunctionBody{
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
	}, nil
}
