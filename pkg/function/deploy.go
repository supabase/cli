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
	// Convert all paths in functions config to relative when using api deploy
	var toDeploy []api.FunctionDeployMetadata
	for slug, fc := range functionConfig {
		if !fc.Enabled {
			fmt.Fprintln(os.Stderr, "Skipped deploying Function:", slug)
			continue
		}
		meta := api.FunctionDeployMetadata{
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

func (s *EdgeRuntimeAPI) bulkUpload(ctx context.Context, toDeploy []api.FunctionDeployMetadata, fsys fs.FS) error {
	jq := queue.NewJobQueue(s.maxJobs)
	toUpdate := make([]api.BulkUpdateFunctionBody, len(toDeploy))
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
	uploadAsset := func(srcPath string, r io.Reader) error {
		fmt.Fprintf(os.Stderr, "Uploading asset (%s): %s\n", *meta.Name, srcPath)
		f, err := form.CreateFormFile("file", srcPath)
		if err != nil {
			return errors.Errorf("failed to create map: %w", err)
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

type ImportMap struct {
	Imports map[string]string            `json:"imports"`
	Scopes  map[string]map[string]string `json:"scopes"`
	// Fallback reference for deno.json
	ImportMap string `json:"importMap"`
}

func (m *ImportMap) LoadAsDeno(imPath string, fsys fs.FS, opts ...func(string, io.Reader) error) error {
	if err := m.Load(imPath, fsys, opts...); err != nil {
		return err
	}
	if strings.EqualFold(path.Base(imPath), "deno.json") && m.IsReference() {
		imPath = path.Join(path.Dir(imPath), m.ImportMap)
		if err := m.Load(imPath, fsys, opts...); err != nil {
			return err
		}
	}
	return nil
}

func (m *ImportMap) IsReference() bool {
	// Ref: https://github.com/denoland/deno/blob/main/cli/schemas/config-file.v1.json#L273
	return len(m.Imports) == 0 && len(m.Scopes) == 0 && len(m.ImportMap) > 0
}

func (m *ImportMap) Load(imPath string, fsys fs.FS, opts ...func(string, io.Reader) error) error {
	data, err := fs.ReadFile(fsys, filepath.FromSlash(imPath))
	if err != nil {
		return errors.Errorf("failed to load import map: %w", err)
	}
	if err := m.Parse(data); err != nil {
		return err
	}
	if err := m.Resolve(imPath, fsys); err != nil {
		return err
	}
	for _, apply := range opts {
		if err := apply(imPath, bytes.NewReader(data)); err != nil {
			return err
		}
	}
	return nil
}

func (m *ImportMap) Parse(data []byte) error {
	data = jsonc.ToJSONInPlace(data)
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&m); err != nil {
		return errors.Errorf("failed to parse import map: %w", err)
	}
	return nil
}

func (m *ImportMap) Resolve(imPath string, fsys fs.FS) error {
	// Resolve all paths relative to current file
	for k, v := range m.Imports {
		m.Imports[k] = resolveHostPath(imPath, v, fsys)
	}
	for module, mapping := range m.Scopes {
		for k, v := range mapping {
			m.Scopes[module][k] = resolveHostPath(imPath, v, fsys)
		}
	}
	return nil
}

func resolveHostPath(jsonPath, hostPath string, fsys fs.FS) string {
	// Leave absolute paths unchanged
	if path.IsAbs(hostPath) {
		return hostPath
	}
	resolved := path.Join(path.Dir(jsonPath), hostPath)
	if _, err := fs.Stat(fsys, filepath.FromSlash(resolved)); err != nil {
		// Leave URLs unchanged
		return hostPath
	}
	// Directory imports need to be suffixed with /
	// Ref: https://deno.com/manual@v1.33.0/basics/import_maps
	if strings.HasSuffix(hostPath, "/") {
		resolved += "/"
	}
	// Relative imports must be prefixed with ./ or ../
	if !path.IsAbs(resolved) {
		resolved = "./" + resolved
	}
	return resolved
}

// Ref: https://regex101.com/r/DfBdJA/1
var importPathPattern = regexp.MustCompile(`(?i)(?:import|export)\s+(?:{[^{}]+}|.*?)\s*(?:from)?\s*['"](.*?)['"]|import\(\s*['"](.*?)['"]\)`)

func (importMap *ImportMap) WalkImportPaths(srcPath string, readFile func(curr string, w io.Writer) error) error {
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
			substituted := false
			for k, v := range importMap.Imports {
				if strings.HasPrefix(mod, k) {
					mod = v + mod[len(k):]
					substituted = true
				}
			}
			// Ignore URLs and directories, assuming no sloppy imports
			// https://github.com/denoland/deno/issues/2506#issuecomment-2727635545
			if len(path.Ext(mod)) == 0 {
				continue
			}
			// Deno import path must begin with one of these prefixes
			if !isRelPath(mod) && !isAbsPath(mod) {
				continue
			}
			if isRelPath(mod) && !substituted {
				mod = path.Join(path.Dir(curr), mod)
			}
			// Cleans import path to help detect duplicates
			q = append(q, path.Clean(mod))
		}
	}
	return nil
}

func isRelPath(mod string) bool {
	return strings.HasPrefix(mod, "./") || strings.HasPrefix(mod, "../")
}

func isAbsPath(mod string) bool {
	return strings.HasPrefix(mod, "/")
}
