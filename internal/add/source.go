package add

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

type templateSource struct {
	fsys        afero.Fs
	baseDir     string
	manifestURL *url.URL
	client      *http.Client
	ctx         context.Context
	isRemote    bool
}

func newTemplateSource(ctx context.Context, source string, fsys afero.Fs) (*templateSource, []byte, error) {
	source = strings.TrimSpace(source)
	if len(source) == 0 {
		return nil, nil, errors.New("template path is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if !strings.Contains(source, "://") && isLikelyRemotePath(source, fsys) {
		source = "https://" + source
	}
	if parsed, err := url.Parse(source); err == nil && len(parsed.Scheme) > 0 && len(parsed.Host) > 0 {
		body, err := fetchURLWithContext(ctx, http.DefaultClient, parsed.String(), true)
		if err != nil {
			return nil, nil, err
		}
		return &templateSource{
			fsys:        fsys,
			manifestURL: parsed,
			client:      http.DefaultClient,
			ctx:         ctx,
			isRemote:    true,
		}, body, nil
	}
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

func isLikelyRemotePath(source string, fsys afero.Fs) bool {
	if _, err := fsys.Stat(source); err == nil {
		return false
	}
	head := strings.Split(source, "/")[0]
	return strings.Contains(head, ".")
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
	if parsed, err := url.Parse(ref); err == nil && len(parsed.Scheme) > 0 && len(parsed.Host) > 0 {
		return parsed.String(), nil
	}
	base := s.manifestURL
	if base == nil {
		return "", errors.New("missing template base url")
	}
	root := *base
	root.Path = path.Dir(base.Path) + "/"
	rel, err := url.Parse(ref)
	if err != nil {
		return "", errors.Errorf("failed to parse component path %s: %w", ref, err)
	}
	return root.ResolveReference(rel).String(), nil
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
