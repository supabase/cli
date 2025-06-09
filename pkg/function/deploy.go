package function

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/queue"
)

var ErrNoDeploy = errors.New("All Functions are up to date.")

func (s *EdgeRuntimeAPI) Deploy(ctx context.Context, functionConfig config.FunctionConfig, fsys fs.FS) error {
	if s.eszip != nil {
		return s.UpsertFunctions(ctx, functionConfig)
	}
	// Convert all paths in functions config to relative when using api deploy
	var toDeploy []FunctionDeployMetadata
	for slug, fc := range functionConfig {
		if !fc.Enabled {
			fmt.Fprintln(os.Stderr, "Skipped deploying Function:", slug)
			continue
		}
		meta := FunctionDeployMetadata{
			Name:           &slug,
			EntrypointPath: toRelPath(fc.Entrypoint),
			ImportMapPath:  cast.Ptr(toRelPath(fc.ImportMap)),
			VerifyJwt:      &fc.VerifyJWT,
		}
		files := make([]string, len(fc.StaticFiles))
		for i, sf := range fc.StaticFiles {
			files[i] = toRelPath(sf)
		}
		meta.StaticPatterns = &files
		toDeploy = append(toDeploy, meta)
	}
	if len(toDeploy) == 0 {
		return errors.New(ErrNoDeploy)
	} else if len(toDeploy) == 1 {
		param := api.V1DeployAFunctionParams{Slug: toDeploy[0].Name}
		_, err := s.upload(ctx, param, toDeploy[0], fsys)
		return err
	}
	return s.bulkUpload(ctx, toDeploy, fsys)
}

func toRelPath(fp string) string {
	if filepath.IsAbs(fp) {
		if cwd, err := os.Getwd(); err == nil {
			if relPath, err := filepath.Rel(cwd, fp); err == nil {
				fp = relPath
			}
		}
	}
	return filepath.ToSlash(fp)
}

func (s *EdgeRuntimeAPI) bulkUpload(ctx context.Context, toDeploy []FunctionDeployMetadata, fsys fs.FS) error {
	jq := queue.NewJobQueue(s.maxJobs)
	toUpdate := make(api.BulkUpdateFunctionBody, len(toDeploy))
	for i, meta := range toDeploy {
		param := api.V1DeployAFunctionParams{
			Slug:       meta.Name,
			BundleOnly: cast.Ptr(true),
		}
		bundle := func() error {
			fmt.Fprintln(os.Stderr, "Deploying Function:", *meta.Name)
			resp, err := s.upload(ctx, param, meta, fsys)
			if err != nil {
				return err
			}
			toUpdate[i].Id = resp.Id
			toUpdate[i].Name = resp.Name
			toUpdate[i].Slug = resp.Slug
			toUpdate[i].Version = resp.Version
			toUpdate[i].EntrypointPath = resp.EntrypointPath
			toUpdate[i].ImportMap = resp.ImportMap
			toUpdate[i].ImportMapPath = resp.ImportMapPath
			toUpdate[i].VerifyJwt = resp.VerifyJwt
			toUpdate[i].Status = api.BulkUpdateFunctionBodyStatus(resp.Status)
			toUpdate[i].CreatedAt = resp.CreatedAt
			return nil
		}
		if err := jq.Put(bundle); err != nil {
			return err
		}
	}
	if err := jq.Collect(); err != nil {
		return err
	}
	if resp, err := s.client.V1BulkUpdateFunctionsWithResponse(ctx, s.project, toUpdate); err != nil {
		return errors.Errorf("failed to bulk update: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected bulk update status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return nil
}

func (s *EdgeRuntimeAPI) upload(ctx context.Context, param api.V1DeployAFunctionParams, meta FunctionDeployMetadata, fsys fs.FS) (*api.DeployFunctionResponse, error) {
	body, w := io.Pipe()
	form := multipart.NewWriter(w)
	ctx, cancel := context.WithCancelCause(ctx)
	go func() {
		defer w.Close()
		defer form.Close()
		if err := writeForm(form, meta, fsys); err != nil {
			// Since we are streaming files to the POST request body, any errors
			// should be propagated to the request context to cancel the upload.
			cancel(err)
		}
	}()
	resp, err := s.client.V1DeployAFunctionWithBodyWithResponse(ctx, s.project, &param, form.FormDataContentType(), body)
	if cause := context.Cause(ctx); cause != ctx.Err() {
		return nil, cause
	} else if err != nil {
		return nil, errors.Errorf("failed to deploy function: %w", err)
	} else if resp.JSON201 == nil {
		return nil, errors.Errorf("unexpected deploy status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return resp.JSON201, nil
}

func writeForm(form *multipart.Writer, meta FunctionDeployMetadata, fsys fs.FS) error {
	m, err := form.CreateFormField("metadata")
	if err != nil {
		return errors.Errorf("failed to create metadata: %w", err)
	}
	enc := json.NewEncoder(m)
	if err := enc.Encode(meta); err != nil {
		return errors.Errorf("failed to encode metadata: %w", err)
	}
	uploadAsset := func(srcPath string, r io.Reader) error {
		fmt.Fprintf(os.Stderr, "Uploading asset (%s): %s\n", *meta.Name, srcPath)
		f, err := form.CreateFormFile("file", srcPath)
		if err != nil {
			return errors.Errorf("failed to create form: %w", err)
		}
		if _, err := io.Copy(f, r); err != nil {
			return errors.Errorf("failed to write form: %w", err)
		}
		return nil
	}
	addFile := func(srcPath string, w io.Writer) error {
		f, err := fsys.Open(filepath.FromSlash(srcPath))
		if err != nil {
			return errors.Errorf("failed to read file: %w", err)
		}
		defer f.Close()
		if fi, err := f.Stat(); err != nil {
			return errors.Errorf("failed to stat file: %w", err)
		} else if fi.IsDir() {
			return errors.New("file path is a directory: " + srcPath)
		}
		r := io.TeeReader(f, w)
		return uploadAsset(srcPath, r)
	}
	// Add import map
	importMap := ImportMap{}
	if imPath := cast.Val(meta.ImportMapPath, ""); len(imPath) > 0 {
		if err := importMap.LoadAsDeno(imPath, fsys, uploadAsset); err != nil {
			return err
		}
	}
	// Add static files
	patterns := config.Glob(cast.Val(meta.StaticPatterns, []string{}))
	files, err := patterns.Files(fsys)
	if err != nil {
		fmt.Fprintln(os.Stderr, "WARN:", err)
	}
	for _, sfPath := range files {
		if err := addFile(sfPath, io.Discard); err != nil {
			return err
		}
	}
	return importMap.WalkImportPaths(meta.EntrypointPath, addFile)
}
