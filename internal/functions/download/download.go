package download

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

var (
	legacyEntrypointPath = "file:///src/index.ts"
	legacyImportMapPath  = "file:///src/import_map.json"
)

func RunLegacy(ctx context.Context, slug string, projectRef string, fsys afero.Fs) error {
	// 1. Sanity checks.
	{
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
	}
	if err := utils.InstallOrUpgradeDeno(ctx, fsys); err != nil {
		return err
	}

	scriptDir, err := utils.CopyDenoScripts(ctx, fsys)
	if err != nil {
		return err
	}

	// 2. Download Function.
	if err := downloadFunction(ctx, projectRef, slug, scriptDir.ExtractPath); err != nil {
		return err
	}

	fmt.Println("Downloaded Function " + utils.Aqua(slug) + " from project " + utils.Aqua(projectRef) + ".")
	return nil
}

func getFunctionMetadata(ctx context.Context, projectRef, slug string) (*api.FunctionSlugResponse, error) {
	resp, err := utils.GetSupabase().V1GetAFunctionWithResponse(ctx, projectRef, slug)
	if err != nil {
		return nil, errors.Errorf("failed to get function metadata: %w", err)
	}

	switch resp.StatusCode() {
	case http.StatusNotFound:
		return nil, errors.Errorf("Function %s does not exist on the Supabase project.", utils.Aqua(slug))
	case http.StatusOK:
		break
	default:
		return nil, errors.Errorf("Failed to download Function %s on the Supabase project: %s", utils.Aqua(slug), string(resp.Body))
	}

	if resp.JSON200.EntrypointPath == nil {
		resp.JSON200.EntrypointPath = &legacyEntrypointPath
	}
	if resp.JSON200.ImportMapPath == nil {
		resp.JSON200.ImportMapPath = &legacyImportMapPath
	}
	return resp.JSON200, nil
}

func downloadFunction(ctx context.Context, projectRef, slug, extractScriptPath string) error {
	fmt.Println("Downloading " + utils.Bold(slug))
	denoPath, err := utils.GetDenoPath()
	if err != nil {
		return err
	}

	meta, err := getFunctionMetadata(ctx, projectRef, slug)
	if err != nil {
		return err
	}

	resp, err := utils.GetSupabase().V1GetAFunctionBodyWithResponse(ctx, projectRef, slug)
	if err != nil {
		return errors.Errorf("failed to get function body: %w", err)
	}
	if resp.StatusCode() != http.StatusOK {
		return errors.New("Unexpected error downloading Function: " + string(resp.Body))
	}

	resBuf := bytes.NewReader(resp.Body)
	funcDir := filepath.Join(utils.FunctionsDir, slug)
	args := []string{"run", "-A", extractScriptPath, funcDir, *meta.EntrypointPath}
	cmd := exec.CommandContext(ctx, denoPath, args...)
	var errBuf bytes.Buffer
	cmd.Stdin = resBuf
	cmd.Stdout = os.Stdout
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return errors.Errorf("Error downloading function: %w\n%v", err, errBuf.String())
	}
	return nil
}

func Run(ctx context.Context, slug, projectRef string, useLegacyBundle, useDocker bool, fsys afero.Fs) error {
	// Sanity check
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}

	if useLegacyBundle {
		return RunLegacy(ctx, slug, projectRef, fsys)
	}

	if useDocker {
		if utils.IsDockerRunning(ctx) {
			// download eszip file for client-side unbundling with edge-runtime
			return downloadWithDockerUnbundle(ctx, slug, projectRef, fsys)
		} else {
			fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "Docker is not running")
		}
	}

	// Use server-side unbundling with multipart/form-data
	return downloadWithServerSideUnbundle(ctx, slug, projectRef, fsys)
}

func downloadWithDockerUnbundle(ctx context.Context, slug string, projectRef string, fsys afero.Fs) error {
	eszipPath, err := downloadOne(ctx, slug, projectRef, fsys)
	if err != nil {
		return err
	}
	if !viper.GetBool("DEBUG") {
		defer func() {
			if err := fsys.Remove(eszipPath); err != nil {
				fmt.Fprintln(os.Stderr, err)
			}
		}()
	}
	// Extract eszip to functions directory
	err = extractOne(ctx, slug, eszipPath)
	if err != nil {
		utils.CmdSuggestion += suggestLegacyBundle(slug)
	}
	return err
}

func downloadOne(ctx context.Context, slug, projectRef string, fsys afero.Fs) (string, error) {
	fmt.Println("Downloading " + utils.Bold(slug))
	resp, err := utils.GetSupabase().V1GetAFunctionBody(ctx, projectRef, slug)
	if err != nil {
		return "", errors.Errorf("failed to get function body: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return "", errors.Errorf("Error status %d: unexpected error downloading Function", resp.StatusCode)
		}
		return "", errors.Errorf("Error status %d: %s", resp.StatusCode, string(body))
	}
	r := io.Reader(resp.Body)
	if strings.EqualFold(resp.Header.Get("Content-Encoding"), "br") {
		r = brotli.NewReader(resp.Body)
	}
	// Create temp file to store downloaded eszip
	eszipPath := filepath.Join(utils.TempDir, fmt.Sprintf("output_%s.eszip", slug))
	if err := utils.MkdirIfNotExistFS(fsys, utils.TempDir); err != nil {
		return "", err
	}
	if err := afero.WriteReader(fsys, eszipPath, r); err != nil {
		return "", errors.Errorf("failed to download file: %w", err)
	}
	return eszipPath, nil
}

func extractOne(ctx context.Context, slug, eszipPath string) error {
	hostFuncDirPath, err := filepath.Abs(filepath.Join(utils.FunctionsDir, slug))
	if err != nil {
		return errors.Errorf("failed to resolve absolute path: %w", err)
	}

	hostEszipPath, err := filepath.Abs(eszipPath)
	if err != nil {
		return errors.Errorf("failed to resolve eszip path: %w", err)
	}
	dockerEszipPath := path.Join(utils.DockerEszipDir, filepath.Base(hostEszipPath))

	binds := []string{
		// Reuse deno cache directory, ie. DENO_DIR, between container restarts
		// https://denolib.gitbook.io/guide/advanced/deno_dir-code-fetch-and-cache
		utils.EdgeRuntimeId + ":/root/.cache/deno:rw",
		hostEszipPath + ":" + dockerEszipPath + ":ro",
		hostFuncDirPath + ":" + utils.DockerDenoDir + ":rw",
	}

	return utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: utils.Config.EdgeRuntime.Image,
			Cmd:   []string{"unbundle", "--eszip", dockerEszipPath, "--output", utils.DockerDenoDir},
		},
		container.HostConfig{
			Binds: binds,
		},
		network.NetworkingConfig{},
		"",
		os.Stdout,
		getErrorLogger(),
	)
}

func getErrorLogger() io.Writer {
	if utils.Config.EdgeRuntime.DenoVersion > 1 {
		return os.Stderr
	}
	// Additional error handling for deno v1
	r, w := io.Pipe()
	go func() {
		logs := bufio.NewScanner(r)
		for logs.Scan() {
			line := logs.Text()
			fmt.Fprintln(os.Stderr, line)
			if strings.EqualFold(line, "invalid eszip v2") {
				utils.CmdSuggestion = suggestDenoV2()
			}
		}
		if err := logs.Err(); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	return w
}

func suggestDenoV2() string {
	return fmt.Sprintf(`Please use deno v2 in %s to download this Function:

[edge_runtime]
deno_version = 2
`, utils.Bold(utils.ConfigPath))
}

func suggestLegacyBundle(slug string) string {
	return fmt.Sprintf("\nIf your function is deployed using CLI < 1.120.0, trying running %s instead.", utils.Aqua("supabase functions download --legacy-bundle "+slug))
}

// New server-side unbundle implementation that mirrors Studio's entrypoint-based
// base-dir + relative path behaviour.
func downloadWithServerSideUnbundle(ctx context.Context, slug, projectRef string, fsys afero.Fs) error {
	fmt.Fprintln(os.Stderr, "Downloading "+utils.Bold(slug))

	metadata, err := getFunctionMetadata(ctx, projectRef, slug)
	if err != nil {
		return errors.Errorf("failed to get function metadata: %w", err)
	}

	entrypointUrl, err := url.Parse(*metadata.EntrypointPath)
	if err != nil {
		return errors.Errorf("failed to parse entrypoint URL: %w", err)
	}

	// Request multipart/form-data response using RequestEditorFn
	resp, err := utils.GetSupabase().V1GetAFunctionBody(ctx, projectRef, slug, func(ctx context.Context, req *http.Request) error {
		req.Header.Set("Accept", "multipart/form-data")
		return nil
	})
	if err != nil {
		return errors.Errorf("failed to download function: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return errors.Errorf("Error status %d: %w", resp.StatusCode, err)
		}
		return errors.Errorf("Error status %d: %s", resp.StatusCode, string(body))
	}

	// Parse the multipart response
	mediaType, params, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil {
		return errors.Errorf("failed to parse content type: %w", err)
	}

	if !strings.HasPrefix(mediaType, "multipart/") {
		return errors.Errorf("expected multipart response, got %s", mediaType)
	}

	// Root directory on disk: supabase/functions/<slug>
	funcDir := filepath.Join(utils.FunctionsDir, slug)
	if err := utils.MkdirIfNotExistFS(fsys, funcDir); err != nil {
		return err
	}

	bufferedParts, cleanupTemp, err := bufferMultipartParts(resp.Body, params["boundary"], slug, fsys)
	if cleanupTemp != nil {
		defer cleanupTemp()
	}
	if err != nil {
		return err
	}

	// Collect file paths (excluding empty ones) to infer the base directory.
	var filepaths []string
	for _, p := range bufferedParts {
		if p.path != "" {
			filepaths = append(filepaths, p.path)
		}
	}

	// infer baseDir using a number of heuristics, in the simple case just Path.Dir(entrypoint)
	baseDir := getBaseDirFromEntrypoint(entrypointUrl, filepaths)

	// Place each file under funcDir using a path relative to baseDir,
	// mirroring Studio's getBasePath + relative() behavior.
	for _, p := range bufferedParts {
		if p.path == "" {
			continue
		}

		relPath := getRelativePathFromBase(baseDir, p.path)
		filePath, err := joinWithinDir(funcDir, relPath)
		if err != nil {
			return err
		}

		if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(filePath)); err != nil {
			return err
		}

		if err := copyFileFromTemp(fsys, p.tempPath, filePath); err != nil {
			return err
		}
	}

	fmt.Println("Downloaded Function " + utils.Aqua(slug) + " from project " + utils.Aqua(projectRef) + ".")
	return nil
}

type bufferedPart struct {
	path     string
	tempPath string
}

// write multipart parts to temp files and return their corresponding path pairs
func bufferMultipartParts(body io.Reader, boundary, slug string, fsys afero.Fs) ([]bufferedPart, func(), error) {
	if boundary == "" {
		return nil, nil, errors.New("multipart boundary missing")
	}
	if err := utils.MkdirIfNotExistFS(fsys, utils.TempDir); err != nil {
		return nil, nil, err
	}
	tempDir, err := afero.TempDir(fsys, utils.TempDir, fmt.Sprintf("functions-download-%s-", slug))
	if err != nil {
		return nil, nil, errors.Errorf("failed to create temp directory: %w", err)
	}
	afs := afero.Afero{Fs: fsys}
	cleanup := func() {
		if err := afs.RemoveAll(tempDir); err != nil {
			fmt.Fprintln(utils.GetDebugLogger(), "failed to clean up temp dir:", err)
		}
	}

	mr := multipart.NewReader(body, boundary)
	var parts []bufferedPart
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			cleanup()
			return nil, nil, errors.Errorf("failed to read multipart: %w", err)
		}

		if err := func() error {
			defer part.Close()
			partPath, err := getPartPath(part)
			if err != nil {
				return err
			}

			if partPath == "" {
				fmt.Fprintln(utils.GetDebugLogger(), "Skipping part without filename")
				if _, err := io.Copy(io.Discard, part); err != nil {
					return errors.Errorf("failed to discard unnamed part: %w", err)
				}
				return nil
			}

			tmpFile, err := afero.TempFile(fsys, tempDir, "part-*")
			if err != nil {
				return errors.Errorf("failed to create temp file: %w", err)
			}

			if _, err := io.Copy(tmpFile, part); err != nil {
				tmpFile.Close()
				fsys.Remove(tmpFile.Name())
				return errors.Errorf("failed to buffer part data: %w", err)
			}
			if err := tmpFile.Close(); err != nil {
				fsys.Remove(tmpFile.Name())
				return errors.Errorf("failed to close temp file: %w", err)
			}

			parts = append(parts, bufferedPart{path: partPath, tempPath: tmpFile.Name()})
			return nil
		}(); err != nil {
			cleanup()
			return nil, nil, err
		}
	}

	return parts, cleanup, nil
}

// getPartPath extracts the filename for a multipart part, allowing for
// relative paths via the custom Supabase-Path header.
func getPartPath(part *multipart.Part) (string, error) {
	// dedicated header to specify relative path, not expected to be used
	if relPath := part.Header.Get("Supabase-Path"); relPath != "" {
		return relPath, nil
	}

	// part.FileName() does not allow us to handle relative paths, so we parse Content-Disposition manually
	cd := part.Header.Get("Content-Disposition")
	if cd == "" {
		return "", nil
	}

	_, params, err := mime.ParseMediaType(cd)
	if err != nil {
		return "", errors.Errorf("failed to parse content disposition: %w", err)
	}

	if filename := params["filename"]; filename != "" {
		return filename, nil
	}
	return "", nil
}

// joinWithinDir safely joins base and rel ensuring the result stays within base directory
func joinWithinDir(base, rel string) (string, error) {
	cleanBase := filepath.Clean(base)
	cleanRel := filepath.Clean(rel)
	// Treat absolute inputs as relative by stripping leading separators ("/foo" -> "foo").
	if filepath.IsAbs(cleanRel) {
		cleanRel = strings.TrimLeft(cleanRel, "/\\")
	}

	// Reject direct attempts to escape (e.g. "../secret.env" or "..\secret.env").
	if cleanRel == ".." || strings.HasPrefix(cleanRel, "..") {
		return "", errors.Errorf("invalid file path outside function directory: %s", rel)
	}

	// Join the sanitized components and normalize the result to remove any "." segments.
	joined := filepath.Join(cleanBase, cleanRel)
	cleanJoined := filepath.Clean(joined)

	// Compute the final relative path. If it still points outside the base (starts with ".."),
	// refuse to write the file.
	relPath, err := filepath.Rel(cleanBase, cleanJoined)
	if err != nil {
		return "", errors.Errorf("failed to resolve relative path: %w", err)
	}
	if relPath == ".." || strings.HasPrefix(relPath, "..") {
		return "", errors.Errorf("refusing to write outside function directory: %s", rel)
	}
	return joined, nil
}

// getBaseDirFromEntrypoint tries to infer the "base" directory for function
// files from the entrypoint URL and the list of filenames, similar to Studio's
// getBasePath logic.
func getBaseDirFromEntrypoint(entrypointUrl *url.URL, filenames []string) string {
	if entrypointUrl.Path == "" {
		return "/"
	}

	entryPath := filepath.ToSlash(entrypointUrl.Path)

	// First, prefer relative filenames (no leading slash) when matching the entrypoint.
	var baseDir string
	for _, filename := range filenames {
		if filename == "" {
			continue
		}
		clean := filepath.ToSlash(filename)
		if strings.HasPrefix(clean, "/") {
			// Skip absolute paths like /tmp/...
			continue
		}
		if strings.HasSuffix(entryPath, clean) {
			baseDir = filepath.Dir(clean)
			break
		}
	}

	// If nothing matched among relative paths, fall back to any filename.
	if baseDir == "" {
		for _, filename := range filenames {
			if filename == "" {
				continue
			}
			clean := filepath.ToSlash(filename)
			// entrypoint has the same suffix as the sanitized filename
			matchRelative := strings.HasSuffix(entryPath, clean)

			// prevents long absolute paths being used as subdirectories
			matchAbsolute := strings.HasSuffix(clean, entryPath)
			if matchRelative || matchAbsolute {
				baseDir = filepath.Dir(clean)
				break
			}
		}
	}

	if baseDir != "" {
		return baseDir
	}

	// Final fallback: derive from the entrypoint URL path itself.
	baseDir = filepath.Dir(entrypointUrl.Path)
	if baseDir != "" && baseDir != "." {
		return baseDir
	}
	return "/"
}

// getRelativePathFromBase mirrors the Studio behaviour of making file paths
// relative to the "base" directory inferred from the entrypoint.
func getRelativePathFromBase(baseDir, filename string) string {
	if filename == "" {
		return ""
	}

	cleanBase := filepath.ToSlash(filepath.Clean(baseDir))
	cleanFile := filepath.ToSlash(filepath.Clean(filename))

	// If we don't have a meaningful base, just normalize to a relative path.
	if cleanBase == "" || cleanBase == "/" || cleanBase == "." {
		return strings.TrimLeft(cleanFile, "/")
	}

	// Try a straightforward relative path first (e.g. source/index.ts -> index.ts).
	if rel, err := filepath.Rel(cleanBase, cleanFile); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
		return filepath.ToSlash(rel)
	}

	// If the file path contains "/<baseDir>/" somewhere (e.g. /tmp/.../source/index.ts),
	// strip everything up to and including that segment so we get a stable relative path
	// like "index.ts" or "dir/file.ts".
	segment := "/" + cleanBase + "/"
	if idx := strings.Index(cleanFile, segment); idx >= 0 {
		return cleanFile[idx+len(segment):]
	}

	// Last resort: return a normalized, slash-stripped path.
	return strings.TrimLeft(cleanFile, "/")
}

func copyFileFromTemp(fsys afero.Fs, src, dst string) error {
	tempFile, err := fsys.Open(src)
	if err != nil {
		return errors.Errorf("failed to open temp file: %w", err)
	}
	defer tempFile.Close()

	destFile, err := fsys.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return errors.Errorf("failed to create file: %w", err)
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, tempFile); err != nil {
		return errors.Errorf("failed to write file: %w", err)
	}
	return nil
}
