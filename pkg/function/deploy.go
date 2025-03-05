package function

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/queue"
	"github.com/tidwall/jsonc"
)

var ErrNoDeploy = errors.New("All Functions are up to date.")

func (s *EdgeRuntimeAPI) Deploy(ctx context.Context, functionConfig config.FunctionConfig, fsys fs.FS) error {
	if s.eszip != nil {
		return s.UpsertFunctions(ctx, functionConfig)
	}
	var toDeploy []api.FunctionDeployMetadata
	for slug, fc := range functionConfig {
		if !fc.Enabled {
			fmt.Fprintln(os.Stderr, "Skipped deploying Function:", slug)
			continue
		}
		meta := api.FunctionDeployMetadata{
			Name:           &slug,
			EntrypointPath: filepath.ToSlash(fc.Entrypoint),
			ImportMapPath:  cast.Ptr(filepath.ToSlash(fc.ImportMap)),
			VerifyJwt:      &fc.VerifyJWT,
		}
		files := make([]string, len(fc.StaticFiles))
		for i, sf := range fc.StaticFiles {
			files[i] = filepath.ToSlash(sf)
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

func (s *EdgeRuntimeAPI) bulkUpload(ctx context.Context, toDeploy []api.FunctionDeployMetadata, fsys fs.FS) error {
	jq := queue.NewJobQueue(s.maxJobs)
	toUpdate := make([]api.BulkUpdateFunctionBody, len(toDeploy))
	for i, meta := range toDeploy {
		fmt.Fprintln(os.Stderr, "Deploying Function:", *meta.Name)
		param := api.V1DeployAFunctionParams{
			Slug:       meta.Name,
			BundleOnly: cast.Ptr(true),
		}
		bundle := func() error {
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

func (s *EdgeRuntimeAPI) upload(ctx context.Context, param api.V1DeployAFunctionParams, meta api.FunctionDeployMetadata, fsys fs.FS) (*api.DeployFunctionResponse, error) {
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

func writeForm(form *multipart.Writer, meta api.FunctionDeployMetadata, fsys fs.FS) error {
	m, err := form.CreateFormField("metadata")
	if err != nil {
		return errors.Errorf("failed to create metadata: %w", err)
	}
	enc := json.NewEncoder(m)
	if err := enc.Encode(meta); err != nil {
		return errors.Errorf("failed to encode metadata: %w", err)
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
		fmt.Fprintf(os.Stderr, "Uploading asset (%s): %s\n", *meta.Name, srcPath)
		r := io.TeeReader(f, w)
		dst, err := form.CreateFormFile("file", srcPath)
		if err != nil {
			return errors.Errorf("failed to create form: %w", err)
		}
		if _, err := io.Copy(dst, r); err != nil {
			return errors.Errorf("failed to write form: %w", err)
		}
		return nil
	}
	// Add import map
	importMap := ImportMap{}
	if imPath := cast.Val(meta.ImportMapPath, ""); len(imPath) > 0 {
		data, err := fs.ReadFile(fsys, filepath.FromSlash(imPath))
		if err != nil {
			return errors.Errorf("failed to load import map: %w", err)
		}
		if err := importMap.Parse(data); err != nil {
			return err
		}
		// TODO: replace with addFile once edge runtime supports jsonc
		fmt.Fprintf(os.Stderr, "Uploading asset (%s): %s\n", *meta.Name, imPath)
		f, err := form.CreateFormFile("file", imPath)
		if err != nil {
			return errors.Errorf("failed to create import map: %w", err)
		}
		if _, err := f.Write(data); err != nil {
			return errors.Errorf("failed to write import map: %w", err)
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
	return walkImportPaths(meta.EntrypointPath, importMap, addFile)
}

type ImportMap struct {
	Imports map[string]string            `json:"imports"`
	Scopes  map[string]map[string]string `json:"scopes"`
}

func (m *ImportMap) Parse(data []byte) error {
	data = jsonc.ToJSONInPlace(data)
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&m); err != nil {
		return errors.Errorf("failed to parse import map: %w", err)
	}
	return nil
}

// Ref: https://regex101.com/r/DfBdJA/1
var importPathPattern = regexp.MustCompile(`(?i)(?:import|export)\s+(?:{[^{}]+}|.*?)\s*(?:from)?\s*['"](.*?)['"]|import\(\s*['"](.*?)['"]\)`)

func walkImportPaths(srcPath string, importMap ImportMap, readFile func(curr string, w io.Writer) error) error {
	seen := map[string]struct{}{}
	// DFS because it's more efficient to pop from end of array
	q := make([]string, 1)
	q[0] = srcPath
	for len(q) > 0 {
		curr := q[len(q)-1]
		q = q[:len(q)-1]
		// Assume no file is symlinked
		if _, ok := seen[curr]; ok {
			continue
		}
		seen[curr] = struct{}{}
		// Read into memory for regex match later
		var buf bytes.Buffer
		if err := readFile(curr, &buf); errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(os.Stderr, "WARN:", err)
			continue
		} else if err != nil {
			return err
		}
		// Traverse all modules imported by the current source file
		for _, matches := range importPathPattern.FindAllStringSubmatch(buf.String(), -1) {
			if len(matches) < 3 {
				continue
			}
			// Matches 'from' clause if present, else fallback to 'import'
			mod := matches[1]
			if len(mod) == 0 {
				mod = matches[2]
			}
			mod = strings.TrimSpace(mod)
			// Substitute kv from import map
			for k, v := range importMap.Imports {
				if strings.HasPrefix(mod, k) {
					mod = v + mod[len(k):]
				}
			}
			// Deno import path must begin with these prefixes
			if strings.HasPrefix(mod, "./") || strings.HasPrefix(mod, "../") {
				mod = path.Join(path.Dir(curr), mod)
			} else if !strings.HasPrefix(mod, "/") {
				continue
			}
			if len(path.Ext(mod)) > 0 {
				// Cleans import path to help detect duplicates
				q = append(q, path.Clean(mod))
			}
		}
	}
	return nil
}
