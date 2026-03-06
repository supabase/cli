package add

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
)

const templatesAPIURLEnv = "SUPABASE_TEMPLATES_API_URL"

type templateSource struct {
	fsys     afero.Fs
	baseDir  string
	client   *http.Client
	ctx      context.Context
	isRemote bool
}

func newTemplateSource(ctx context.Context, source string, fsys afero.Fs) (*templateSource, []byte, error) {
	source = strings.TrimSpace(source)
	if len(source) == 0 {
		return nil, nil, errors.New("template path is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if isLocalTemplatePath(source, fsys) {
		return newLocalTemplateSource(ctx, source, fsys)
	}
	if parsed, err := url.Parse(source); err == nil && len(parsed.Scheme) > 0 && len(parsed.Host) > 0 {
		return nil, nil, errors.New("remote template URLs are unsupported; pass a template slug instead")
	}
	if err := utils.ValidateFunctionSlug(source); err != nil {
		return nil, nil, errors.Errorf("invalid template slug %q: %w", source, err)
	}
	return newRemoteTemplateSource(ctx, source, fsys, http.DefaultClient)
}

func isLocalTemplatePath(source string, fsys afero.Fs) bool {
	if filepath.IsAbs(source) {
		return true
	}
	if _, err := fsys.Stat(source); err == nil {
		return true
	}
	if _, err := fsys.Stat(filepath.Join(utils.CurrentDirAbs, source)); err == nil {
		return true
	}
	return false
}

func newLocalTemplateSource(ctx context.Context, source string, fsys afero.Fs) (*templateSource, []byte, error) {
	if !filepath.IsAbs(source) {
		if _, err := fsys.Stat(source); err != nil {
			source = filepath.Join(utils.CurrentDirAbs, source)
		}
	}
	body, err := afero.ReadFile(fsys, source)
	if err != nil {
		return nil, nil, errors.Errorf("failed to read template file: %w", err)
	}
	return &templateSource{
		fsys:     fsys,
		baseDir:  filepath.Dir(source),
		ctx:      ctx,
		isRemote: false,
	}, body, nil
}

func newRemoteTemplateSource(ctx context.Context, slug string, fsys afero.Fs, client *http.Client) (*templateSource, []byte, error) {
	manifestURL, err := resolveTemplateManifestURL(slug)
	if err != nil {
		return nil, nil, err
	}
	body, err := fetchURLWithContext(ctx, client, manifestURL.String(), true)
	if err != nil {
		return nil, nil, err
	}
	return &templateSource{
		fsys:     fsys,
		client:   client,
		ctx:      ctx,
		isRemote: true,
	}, body, nil
}

func resolveTemplateManifestURL(slug string) (*url.URL, error) {
	baseURL := strings.TrimSpace(viper.GetString("TEMPLATES_API_URL"))
	if len(baseURL) == 0 {
		baseURL = strings.TrimSpace(os.Getenv(templatesAPIURLEnv))
	}
	if len(baseURL) == 0 {
		return nil, errors.Errorf("missing %s environment variable", templatesAPIURLEnv)
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return nil, errors.Errorf("failed to parse %s: %w", templatesAPIURLEnv, err)
	}
	if len(parsed.Scheme) == 0 || len(parsed.Host) == 0 {
		return nil, errors.Errorf("%s must be an absolute URL", templatesAPIURLEnv)
	}
	manifestURL := *parsed
	manifestURL.Path = strings.TrimSuffix(parsed.Path, "/") + "/" + url.PathEscape(slug)
	return &manifestURL, nil
}

func (s *templateSource) readTemplatePath(ref string, required bool) ([]byte, error) {
	if len(strings.TrimSpace(ref)) == 0 {
		if required {
			return nil, errors.New("template component path is required")
		}
		return nil, os.ErrNotExist
	}
	if s.isRemote {
		u, err := s.resolveURL(ref)
		if err != nil {
			return nil, err
		}
		return fetchURLWithContext(s.ctx, s.client, u, required)
	}
	target := ref
	if !filepath.IsAbs(target) {
		target = filepath.Join(s.baseDir, ref)
	}
	data, err := afero.ReadFile(s.fsys, target)
	if errors.Is(err, os.ErrNotExist) && !required {
		return nil, os.ErrNotExist
	} else if err != nil {
		return nil, errors.Errorf("failed to read template file %s: %w", ref, err)
	}
	return data, nil
}

func (s *templateSource) resolveLocalPath(ref string) (string, error) {
	if s.isRemote {
		return "", errors.New("template source is remote")
	}
	target := ref
	if !filepath.IsAbs(target) {
		target = filepath.Join(s.baseDir, ref)
	}
	if _, err := s.fsys.Stat(target); err != nil {
		return "", errors.Errorf("failed to resolve local path %s: %w", ref, err)
	}
	return target, nil
}

func (s *templateSource) resolveURL(ref string) (string, error) {
	if !s.isRemote {
		return "", errors.New("template source is local")
	}
	parsed, err := url.Parse(ref)
	if err != nil {
		return "", errors.Errorf("failed to parse component path %s: %w", ref, err)
	}
	if len(parsed.Scheme) == 0 || len(parsed.Host) == 0 {
		return "", errors.Errorf("remote template component path must be an absolute URL: %s", ref)
	}
	return parsed.String(), nil
}

func fetchURLWithContext(ctx context.Context, client *http.Client, target string, required bool) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, errors.Errorf("failed to create request for %s: %w", target, err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.Errorf("failed to fetch %s: %w", target, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if !required && isNotFoundResponse(resp.StatusCode, data) {
		return nil, os.ErrNotExist
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, errors.Errorf("failed to fetch %s: status %d: %s", target, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	return data, nil
}

func isNotFoundResponse(statusCode int, body []byte) bool {
	if statusCode == http.StatusNotFound {
		return true
	}
	var parsed struct {
		StatusCode interface{} `json:"statusCode"`
		Error      string      `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return false
	}
	if strings.EqualFold(parsed.Error, "not_found") {
		return true
	}
	switch v := parsed.StatusCode.(type) {
	case float64:
		return int(v) == http.StatusNotFound
	case string:
		return strings.TrimSpace(v) == "404"
	default:
		return false
	}
}
