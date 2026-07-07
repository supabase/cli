package download

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-units"
	"github.com/go-errors/errors"
	"github.com/google/uuid"
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

// ErrUnsafeDownloadPath is returned when a downloaded Function file's path,
// as reported by the server via the Supabase-Path header or the
// Content-Disposition filename, would resolve outside utils.FunctionsDir
// once joined and cleaned, or would require following an existing symlink
// to get there. The server response is not trusted input, so any path that
// looks like it's trying to escape the functions directory is rejected
// rather than sanitized.
var ErrUnsafeDownloadPath = errors.New("invalid path in server response")

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

	fmt.Fprintf(os.Stderr, "Downloaded Function %s from project %s.\n", utils.Aqua(slug), utils.Aqua(projectRef))
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
	fmt.Fprintln(os.Stderr, "Downloading function:", utils.Bold(slug))
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

	// Defaults to server-side unbundling with multipart/form-data
	downloader := downloadWithServerSideUnbundle
	if useLegacyBundle {
		downloader = RunLegacy
	} else if useDocker {
		if utils.IsDockerRunning(ctx) {
			// Download eszip file for client-side unbundling with edge-runtime
			downloader = downloadWithDockerUnbundle
		} else {
			fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "Docker is not running")
		}
	}

	if len(slug) > 0 {
		return downloader(ctx, slug, projectRef, fsys)
	}
	return downloadAll(ctx, projectRef, fsys, downloader)
}

func downloadAll(ctx context.Context, projectRef string, fsys afero.Fs, downloader func(context.Context, string, string, afero.Fs) error) error {
	resp, err := utils.GetSupabase().V1ListAllFunctionsWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to list functions: %w", err)
	}
	if resp.JSON200 == nil {
		return errors.Errorf("unexpected list functions status %d: %s", resp.StatusCode(), string(resp.Body))
	}

	functions := *resp.JSON200
	if len(functions) == 0 {
		fmt.Fprintln(os.Stderr, "No functions found in project ", utils.Aqua(projectRef))
		return nil
	}

	fmt.Fprintf(os.Stderr, "Found %d function(s) to download\n", len(functions))
	for _, f := range functions {
		if err := downloader(ctx, f.Slug, projectRef, fsys); err != nil {
			return err
		}
	}

	fmt.Fprintln(os.Stderr, "Successfully downloaded all functions from project", utils.Aqua(projectRef))
	return nil
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
	fmt.Fprintln(os.Stderr, "Downloading function:", utils.Bold(slug))
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
	hostFuncDirPath, err := filepath.Abs(utils.FunctionsDir)
	if err != nil {
		return errors.Errorf("failed to resolve functions path: %w", err)
	}

	hostEszipPath, err := filepath.Abs(eszipPath)
	if err != nil {
		return errors.Errorf("failed to resolve eszip path: %w", err)
	}
	dockerEszipPath := path.Join(utils.DockerEszipDir, filepath.Base(hostEszipPath))
	dockerOutputPath := path.Join(utils.DockerDenoDir, slug)

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
			Cmd:   []string{"unbundle", "--eszip", dockerEszipPath, "--output", dockerOutputPath},
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

type bundleMetadata struct {
	EntrypointPath string `json:"deno2_entrypoint_path,omitempty"`
}

// New server-side unbundle implementation that mirrors Studio's entrypoint-based
// base-dir + relative path behaviour.
func downloadWithServerSideUnbundle(ctx context.Context, slug, projectRef string, fsys afero.Fs) error {
	fmt.Fprintln(os.Stderr, "Downloading Function:", utils.Bold(slug))

	form, err := readForm(ctx, projectRef, slug)
	if err != nil {
		return err
	}
	defer func() {
		if err := form.RemoveAll(); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()

	// Read entrypoint path from deno2 bundles
	metadata := bundleMetadata{}
	if data, ok := form.Value["metadata"]; ok {
		for _, part := range data {
			if err := json.Unmarshal([]byte(part), &metadata); err != nil {
				return errors.Errorf("failed to unmarshal metadata: %w", err)
			}
		}
	}

	// Fallback to function metadata from upstash
	if len(metadata.EntrypointPath) == 0 {
		upstash, err := getFunctionMetadata(ctx, projectRef, slug)
		if err != nil {
			return errors.Errorf("failed to get function metadata: %w", err)
		}
		entrypointUrl, err := url.Parse(*upstash.EntrypointPath)
		if err != nil {
			return errors.Errorf("failed to parse entrypoint URL: %w", err)
		}
		metadata.EntrypointPath = entrypointUrl.Path
	}
	fmt.Fprintln(utils.GetDebugLogger(), "Using entrypoint path:", metadata.EntrypointPath)

	// Root directory on disk: supabase/functions/<slug>
	funcDir := filepath.Join(utils.FunctionsDir, slug)
	for _, data := range form.File {
		for _, file := range data {
			if err := saveFile(file, metadata.EntrypointPath, funcDir, fsys); err != nil {
				return err
			}
		}
	}

	fmt.Fprintf(os.Stderr, "Downloaded Function %s from project %s.\n", utils.Aqua(slug), utils.Aqua(projectRef))
	return nil
}

func readForm(ctx context.Context, projectRef, slug string) (*multipart.Form, error) {
	// Request multipart/form-data response using RequestEditorFn
	resp, err := utils.GetSupabase().V1GetAFunctionBody(ctx, projectRef, slug, func(ctx context.Context, req *http.Request) error {
		req.Header.Set("Accept", "multipart/form-data")
		return nil
	})
	if err != nil {
		return nil, errors.Errorf("failed to download function: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, errors.Errorf("Error status %d: %w", resp.StatusCode, err)
		}
		return nil, errors.Errorf("Error status %d: %s", resp.StatusCode, string(body))
	}

	// Parse the multipart response
	mediaType, params, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil {
		return nil, errors.Errorf("failed to parse content type: %w", err)
	}
	if !strings.HasPrefix(mediaType, "multipart/") {
		return nil, errors.Errorf("expected multipart response, got %s", mediaType)
	}

	// Read entire response with caching to disk
	mr := multipart.NewReader(resp.Body, params["boundary"])
	form, err := mr.ReadForm(units.MiB)
	if err != nil {
		return nil, errors.Errorf("failed to read form: %w", err)
	}

	return form, nil
}

func saveFile(file *multipart.FileHeader, entrypointPath, funcDir string, fsys afero.Fs) error {
	part, err := file.Open()
	if err != nil {
		return errors.Errorf("failed to open file: %w", err)
	}
	defer part.Close()

	logger := utils.GetDebugLogger()
	partPath, err := getPartPath(file.Header)
	if len(partPath) == 0 {
		fmt.Fprintln(logger, "Skipping file with empty path:", file.Filename)
		return err
	}
	fmt.Fprintln(logger, "Resolving file path:", partPath)

	relPath, err := filepath.Rel(filepath.FromSlash(entrypointPath), filepath.FromSlash(partPath))
	if err != nil {
		// Continue extracting without entrypoint
		fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), err)
		relPath = filepath.FromSlash(path.Join("..", partPath))
	}

	// partPath (and therefore relPath and dstPath) is derived from
	// server-controlled multipart metadata (Supabase-Path header or
	// Content-Disposition filename), so it must be validated before it
	// touches the filesystem below.
	dstPath := filepath.Join(funcDir, path.Base(entrypointPath), relPath)

	// Containment is enforced against the shared functions directory
	// rather than funcDir: the entrypoint-mismatch fallback above can
	// legitimately resolve one level above funcDir (into a sibling
	// function's directory), but must never resolve outside
	// utils.FunctionsDir entirely, e.g. via a "../../../etc/passwd" style
	// payload.
	root := utils.FunctionsDir
	if err := validateDownloadPath(root, dstPath); err != nil {
		return err
	}

	// A previous part could have planted a symlink at an intermediate
	// directory component, which would otherwise let MkdirAll/OpenFile
	// silently follow it out of root even though dstPath itself looks
	// clean. Check before creating the directory, and again after the
	// write lands in case a symlink was swapped in between the two checks.
	dstDir := filepath.Dir(dstPath)
	if err := ensureNoSymlinkInPath(fsys, root, dstDir); err != nil {
		return err
	}
	if err := utils.MkdirIfNotExistFS(fsys, dstDir); err != nil {
		return err
	}

	fmt.Fprintln(os.Stderr, "Extracting file:", dstPath)
	if err := writeFileNoFollowSymlink(fsys, dstPath, part); err != nil {
		return err
	}

	return ensureNoSymlinkInPath(fsys, root, dstPath)
}

// validateDownloadPath rejects dstPath if, once lexically cleaned, it does
// not resolve inside root. This is the primary defense against a hostile
// "../../etc/passwd" style Supabase-Path/filename escaping the functions
// directory: filepath.Join already cleans ".." segments away, so this
// check must run against the cleaned result rather than by scanning the
// raw, attacker-controlled path for "..".
func validateDownloadPath(root, dstPath string) error {
	rel, err := filepath.Rel(root, filepath.Clean(dstPath))
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return errors.Errorf("failed to save file: %w", ErrUnsafeDownloadPath)
	}
	return nil
}

// ensureNoSymlinkInPath rejects dir if it, or any existing ancestor of it
// down to (but excluding) root, is a symlink.
//
// This only has an effect on filesystems that expose real symlink
// semantics through afero.Lstater, i.e. afero.NewOsFs in production. The
// in-memory filesystem used in tests has no notion of symlinks, so
// LstatIfPossible never reports the symlink bit there and this check is
// effectively a no-op -- there is nothing to protect against on a
// filesystem that cannot contain symlinks in the first place.
func ensureNoSymlinkInPath(fsys afero.Fs, root, dir string) error {
	lstater, ok := fsys.(afero.Lstater)
	if !ok {
		return nil
	}

	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == "." || rel == "" {
		return nil
	}

	current := root
	for _, segment := range strings.Split(rel, string(filepath.Separator)) {
		current = filepath.Join(current, segment)
		info, _, err := lstater.LstatIfPossible(current)
		if err != nil {
			if os.IsNotExist(err) {
				// Nothing here yet, and therefore nothing further down
				// this branch either: MkdirAll will create plain
				// directories from this point on.
				break
			}
			return errors.Errorf("failed to inspect extraction path: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.Errorf("failed to save file: %w", ErrUnsafeDownloadPath)
		}
	}
	return nil
}

// writeFileNoFollowSymlink writes r to dstPath without following a symlink
// that might already occupy that path. It creates a randomly named
// temporary file next to dstPath with O_EXCL, refusing to write through
// anything already there, then atomically renames it onto dstPath.
// Rename replaces whatever directory entry currently exists at dstPath --
// including a symlink -- rather than dereferencing it, which is exactly
// what a plain fs.Create/afero.WriteReader would otherwise do.
func writeFileNoFollowSymlink(fsys afero.Fs, dstPath string, r io.Reader) error {
	tmpPath := filepath.Join(filepath.Dir(dstPath), fmt.Sprintf(".supabase-download-%s.tmp", uuid.NewString()))
	tmp, err := fsys.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return errors.Errorf("failed to save file: %w", err)
	}

	if _, err := io.Copy(tmp, r); err != nil {
		_ = tmp.Close()
		_ = fsys.Remove(tmpPath)
		return errors.Errorf("failed to save file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = fsys.Remove(tmpPath)
		return errors.Errorf("failed to save file: %w", err)
	}

	if err := fsys.Rename(tmpPath, dstPath); err != nil {
		_ = fsys.Remove(tmpPath)
		return errors.Errorf("failed to save file: %w", err)
	}
	return nil
}

// getPartPath extracts the filename for a multipart part, allowing for
// relative paths via the custom Supabase-Path header.
func getPartPath(header textproto.MIMEHeader) (string, error) {
	// dedicated header to specify relative path, not expected to be used
	if relPath := header.Get("Supabase-Path"); relPath != "" {
		return relPath, nil
	}

	// part.FileName() does not allow us to handle relative paths, so we parse Content-Disposition manually
	cd := header.Get("Content-Disposition")
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
