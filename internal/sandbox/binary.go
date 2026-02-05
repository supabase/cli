package sandbox

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/ulikunitz/xz"
)

const (
	// Binary versions
	GotrueVersion    = "2.186.0" // Local build for darwin-arm64
	PostgrestVersion = "14.4"
)

// GetGotruePath returns the path to the gotrue binary.
// Binaries are cached with versioning: ~/.supabase/bin/gotrue/<version>/gotrue
func GetGotruePath(binDir string) string {
	name := "gotrue"
	if runtime.GOOS == "windows" {
		name = "gotrue.exe"
	}
	return filepath.Join(binDir, "gotrue", GotrueVersion, name)
}

// GetPostgrestPath returns the path to the postgrest binary.
// Binaries are cached with versioning: ~/.supabase/bin/postgrest/<version>/postgrest
func GetPostgrestPath(binDir string) string {
	name := "postgrest"
	if runtime.GOOS == "windows" {
		name = "postgrest.exe"
	}
	return filepath.Join(binDir, "postgrest", PostgrestVersion, name)
}

// GetPostgresDir returns the postgres installation directory.
// Unlike single-binary tools, PostgreSQL is a full directory with bin/, lib/, share/.
// Cached at: ~/.supabase/bin/postgres/<version>/
func GetPostgresDir(binDir, version string) string {
	return filepath.Join(binDir, "postgres", version)
}

// GetPostgresBinPath returns the path to a specific postgres binary.
func GetPostgresBinPath(binDir, version, binary string) string {
	name := binary
	if runtime.GOOS == "windows" {
		name = binary + ".exe"
	}
	return filepath.Join(GetPostgresDir(binDir, version), "bin", name)
}

// GetPostgresLibDir returns the path to postgres shared libraries.
func GetPostgresLibDir(binDir, version string) string {
	return filepath.Join(GetPostgresDir(binDir, version), "lib")
}

// BinaryStatus represents the installation status of a binary.
type BinaryStatus struct {
	Name            string
	InitiallyCached bool // Was already in cache before this run
	Cached          bool // Is now cached (either initially or after download)
	Downloading     bool
	Error           error
	mu              sync.Mutex
}

// Spinner frames for animated progress display
var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// InstallBinaries downloads and installs all required binaries if not already present.
// Shows a Docker-like status display when binaries need to be downloaded.
// Returns the postgres version that was installed/found.
func InstallBinaries(ctx context.Context, fsys afero.Fs, binDir string) (postgresVersion string, err error) {
	// Ensure bin directory exists
	if err := fsys.MkdirAll(binDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create bin directory: %w", err)
	}

	// Get paths and check cache status
	gotruePath := GetGotruePath(binDir)
	postgrestPath := GetPostgrestPath(binDir)

	// Find postgres archive and version first
	archivePath, pgVersion, err := findLocalPostgresArchive()
	if err != nil {
		return "", fmt.Errorf("postgres: %w", err)
	}
	postgresVersion = pgVersion
	postgresBin := GetPostgresBinPath(binDir, postgresVersion, "postgres")

	// Check which binaries are already cached
	gotrueCached := fileExists(fsys, gotruePath)
	postgrestCached := fileExists(fsys, postgrestPath)
	postgresCached := fileExists(fsys, postgresBin)

	// If all cached, nothing to do
	if gotrueCached && postgrestCached && postgresCached {
		return postgresVersion, nil
	}

	// Show download status like Docker
	statuses := []*BinaryStatus{
		{Name: "auth", InitiallyCached: gotrueCached, Cached: gotrueCached, Downloading: !gotrueCached},
		{Name: "postgrest", InitiallyCached: postgrestCached, Cached: postgrestCached, Downloading: !postgrestCached},
		{Name: "postgres", InitiallyCached: postgresCached, Cached: postgresCached, Downloading: !postgresCached},
	}

	// Print initial status lines (without moving cursor up)
	for _, s := range statuses {
		var icon, status string
		if s.InitiallyCached {
			icon = utils.Green("✔")
			status = "Skipped - Image is already present locally"
		} else {
			icon = utils.Aqua(spinnerFrames[0])
			status = "Pulling"
		}
		fmt.Fprintf(os.Stderr, " %s %s %s\n", icon, s.Name, status)
	}

	// Start spinner animation in background
	done := make(chan struct{})
	spinnerDone := make(chan struct{})
	go func() {
		defer close(spinnerDone)
		frame := 0
		ticker := time.NewTicker(80 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				frame = (frame + 1) % len(spinnerFrames)
				printBinaryStatus(statuses, frame, false)
			}
		}
	}()

	// Install binaries in parallel
	var wg sync.WaitGroup
	errChan := make(chan error, 3)

	// GoTrue
	if !gotrueCached {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := installGotrueFromLocalOrDownloadQuiet(ctx, fsys, gotruePath); err != nil {
				statuses[0].mu.Lock()
				statuses[0].Error = err
				statuses[0].Downloading = false
				statuses[0].mu.Unlock()
				errChan <- fmt.Errorf("auth: %w", err)
				return
			}
			statuses[0].mu.Lock()
			statuses[0].Cached = true
			statuses[0].Downloading = false
			statuses[0].mu.Unlock()
		}()
	}

	// PostgREST
	if !postgrestCached {
		wg.Add(1)
		go func() {
			defer wg.Done()
			postgrestURL, err := getPostgrestDownloadURL()
			if err != nil {
				statuses[1].mu.Lock()
				statuses[1].Error = err
				statuses[1].Downloading = false
				statuses[1].mu.Unlock()
				errChan <- fmt.Errorf("postgrest: %w", err)
				return
			}
			if err := installBinaryIfMissingXZQuiet(ctx, fsys, postgrestPath, postgrestURL); err != nil {
				statuses[1].mu.Lock()
				statuses[1].Error = err
				statuses[1].Downloading = false
				statuses[1].mu.Unlock()
				errChan <- fmt.Errorf("postgrest: %w", err)
				return
			}
			statuses[1].mu.Lock()
			statuses[1].Cached = true
			statuses[1].Downloading = false
			statuses[1].mu.Unlock()
		}()
	}

	// PostgreSQL
	if !postgresCached {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := installPostgresQuiet(ctx, fsys, binDir, archivePath, postgresVersion); err != nil {
				statuses[2].mu.Lock()
				statuses[2].Error = err
				statuses[2].Downloading = false
				statuses[2].mu.Unlock()
				errChan <- fmt.Errorf("postgres: %w", err)
				return
			}
			statuses[2].mu.Lock()
			statuses[2].Cached = true
			statuses[2].Downloading = false
			statuses[2].mu.Unlock()
		}()
	}

	// Wait for all downloads to complete
	wg.Wait()
	close(errChan)

	// Stop spinner animation and wait for goroutine to exit
	close(done)
	<-spinnerDone

	// Print final status
	printBinaryStatus(statuses, 0, true)

	// Collect errors
	var errs []error
	for err := range errChan {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		return "", errors.Join(errs...)
	}

	return postgresVersion, nil
}

// fileExists checks if a file exists.
func fileExists(fsys afero.Fs, path string) bool {
	_, err := fsys.Stat(path)
	return err == nil
}

// printBinaryStatus prints the Docker-like status display with animated spinners.
// spinnerFrame is the current frame index for the spinner animation.
func printBinaryStatus(statuses []*BinaryStatus, spinnerFrame int, final bool) {
	// Move cursor up to overwrite previous status
	for range statuses {
		fmt.Fprint(os.Stderr, "\033[A\033[K") // Move up and clear line
	}

	for _, s := range statuses {
		s.mu.Lock()
		var icon, status string

		if s.Error != nil {
			icon = utils.Red("✗")
			status = fmt.Sprintf("Error - %v", s.Error)
		} else if s.Downloading {
			icon = utils.Aqua(spinnerFrames[spinnerFrame])
			status = "Pulling"
		} else if s.InitiallyCached {
			// Was already in cache before this run
			icon = utils.Green("✔")
			if final {
				status = "Pulled"
			} else {
				status = "Skipped - Image is already present locally"
			}
		} else {
			// Just finished installing or default state
			icon = utils.Green("✔")
			status = "Pulled"
		}

		fmt.Fprintf(os.Stderr, " %s %s %s\n", icon, s.Name, status)
		s.mu.Unlock()
	}
}

// installGotrueFromLocalOrDownloadQuiet installs gotrue without printing progress.
func installGotrueFromLocalOrDownloadQuiet(ctx context.Context, fsys afero.Fs, binPath string) error {
	// Ensure parent directory exists
	if err := fsys.MkdirAll(filepath.Dir(binPath), 0755); err != nil {
		return fmt.Errorf("failed to create binary directory: %w", err)
	}

	// For darwin/arm64, check for a locally built binary first
	if runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" {
		localBinaryName := fmt.Sprintf("auth-v%s-darwin-arm64", GotrueVersion)
		if cliDir, err := getCliDir(); err == nil {
			localPath := filepath.Join(cliDir, localBinaryName)
			if data, err := os.ReadFile(localPath); err == nil {
				return afero.WriteFile(fsys, binPath, data, 0755)
			}
		}
	}

	// Fall back to download from GitHub releases
	gotrueURL, err := getGotrueDownloadURL()
	if err != nil {
		return err
	}
	return installBinaryFromArchiveQuiet(ctx, fsys, binPath, gotrueURL, "auth")
}

// installBinaryIfMissingXZQuiet handles .tar.xz archives without printing progress.
func installBinaryIfMissingXZQuiet(ctx context.Context, fsys afero.Fs, binPath, downloadURL string) error {
	// Ensure parent directory exists
	if err := fsys.MkdirAll(filepath.Dir(binPath), 0755); err != nil {
		return fmt.Errorf("failed to create binary directory: %w", err)
	}

	// Download the file
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return errors.Errorf("failed to download %s: HTTP %d", downloadURL, resp.StatusCode)
	}

	return extractTarXz(resp.Body, binPath, fsys)
}

// installBinaryFromArchiveQuiet downloads and extracts a binary without printing progress.
func installBinaryFromArchiveQuiet(ctx context.Context, fsys afero.Fs, binPath, downloadURL, srcBinName string) error {
	// Ensure parent directory exists
	if err := fsys.MkdirAll(filepath.Dir(binPath), 0755); err != nil {
		return fmt.Errorf("failed to create binary directory: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return errors.Errorf("failed to download %s: HTTP %d", downloadURL, resp.StatusCode)
	}

	return extractTarGzWithName(resp.Body, binPath, srcBinName, fsys)
}

// installPostgresQuiet installs PostgreSQL without printing progress (except codesign warnings).
func installPostgresQuiet(ctx context.Context, fsys afero.Fs, binDir, archivePath, version string) error {
	postgresDir := GetPostgresDir(binDir, version)

	// Ensure parent directory exists
	if err := fsys.MkdirAll(postgresDir, 0755); err != nil {
		return fmt.Errorf("failed to create postgres directory: %w", err)
	}

	// Extract the zip archive
	if err := extractZipToDir(archivePath, postgresDir, fsys); err != nil {
		return fmt.Errorf("failed to extract postgres archive: %w", err)
	}

	// On macOS, re-sign all binaries and libraries (suppress warnings)
	if runtime.GOOS == "darwin" {
		codesignPostgresDirQuiet(postgresDir)
	}

	return nil
}

// codesignPostgresDirQuiet re-signs binaries without printing warnings.
func codesignPostgresDirQuiet(postgresDir string) {
	filepath.Walk(postgresDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}

		needsSign := info.Mode()&0111 != 0 || strings.HasSuffix(path, ".dylib")
		if needsSign {
			exec.Command("codesign", "-f", "-s", "-", path).Run()
		}
		return nil
	})
}

// extractTarGz extracts the first executable from a .tar.gz archive.
func extractTarGz(r io.Reader, binPath string, fsys afero.Fs) error {
	return extractTarGzWithName(r, binPath, filepath.Base(binPath), fsys)
}

// extractTarGzWithName extracts a named binary from a .tar.gz archive.
func extractTarGzWithName(r io.Reader, binPath, srcBinName string, fsys afero.Fs) error {
	gzr, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("failed to create gzip reader: %w", err)
	}
	defer gzr.Close()

	return extractTarWithName(gzr, binPath, srcBinName, fsys)
}

// extractTarXz extracts the first executable from a .tar.xz archive.
func extractTarXz(r io.Reader, binPath string, fsys afero.Fs) error {
	xzr, err := xz.NewReader(r)
	if err != nil {
		return fmt.Errorf("failed to create xz reader: %w", err)
	}

	return extractTarWithName(xzr, binPath, filepath.Base(binPath), fsys)
}

// extractTarWithName extracts a binary from a tar archive.
// srcBinName is the name to look for in the archive, binPath is the destination path.
func extractTarWithName(r io.Reader, binPath, srcBinName string, fsys afero.Fs) error {
	tr := tar.NewReader(r)

	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("failed to read tar: %w", err)
		}

		// Look for the binary file
		name := filepath.Base(header.Name)
		if name == srcBinName || name == srcBinName+".exe" {
			if header.Typeflag != tar.TypeReg {
				continue
			}

			data, err := io.ReadAll(tr)
			if err != nil {
				return fmt.Errorf("failed to read binary from archive: %w", err)
			}

			if err := afero.WriteFile(fsys, binPath, data, 0755); err != nil {
				return fmt.Errorf("failed to write binary: %w", err)
			}

			return nil
		}
	}

	return errors.Errorf("binary %s not found in archive", srcBinName)
}

// getGotrueDownloadURL returns the download URL for GoTrue based on the current platform.
// GoTrue releases are .tar.gz archives.
func getGotrueDownloadURL() (string, error) {
	base := fmt.Sprintf("https://github.com/supabase/auth/releases/download/v%s/", GotrueVersion)

	switch {
	case runtime.GOOS == "darwin" && runtime.GOARCH == "arm64":
		return base + "auth-v" + GotrueVersion + "-arm64.tar.gz", nil
	case runtime.GOOS == "darwin" && runtime.GOARCH == "amd64":
		return base + "auth-v" + GotrueVersion + "-x86_64.tar.gz", nil
	case runtime.GOOS == "linux" && runtime.GOARCH == "amd64":
		return base + "auth-v" + GotrueVersion + "-x86_64.tar.gz", nil
	case runtime.GOOS == "linux" && runtime.GOARCH == "arm64":
		return base + "auth-v" + GotrueVersion + "-arm64.tar.gz", nil
	default:
		return "", errors.Errorf("unsupported platform for gotrue: %s/%s", runtime.GOOS, runtime.GOARCH)
	}
}

// getPostgrestDownloadURL returns the download URL for PostgREST based on the current platform.
// PostgREST releases are .tar.xz archives.
func getPostgrestDownloadURL() (string, error) {
	base := fmt.Sprintf("https://github.com/PostgREST/postgrest/releases/download/v%s/", PostgrestVersion)

	switch {
	case runtime.GOOS == "darwin" && runtime.GOARCH == "arm64":
		return base + "postgrest-v" + PostgrestVersion + "-macos-aarch64.tar.xz", nil
	case runtime.GOOS == "darwin" && runtime.GOARCH == "amd64":
		return base + "postgrest-v" + PostgrestVersion + "-macos-x64.tar.xz", nil
	case runtime.GOOS == "linux" && runtime.GOARCH == "amd64":
		return base + "postgrest-v" + PostgrestVersion + "-linux-static-x64.tar.xz", nil
	case runtime.GOOS == "linux" && runtime.GOARCH == "arm64":
		return base + "postgrest-v" + PostgrestVersion + "-linux-static-aarch64.tar.xz", nil
	default:
		return "", errors.Errorf("unsupported platform for postgrest: %s/%s", runtime.GOOS, runtime.GOARCH)
	}
}

// getCliDir returns the directory containing the CLI binary, resolving symlinks.
// This allows finding local binaries when the CLI is symlinked (e.g., /usr/local/bin/supa -> /path/to/cli/supa).
func getCliDir() (string, error) {
	cliPath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("failed to get executable path: %w", err)
	}

	// Resolve symlinks to find the actual binary location
	realPath, err := filepath.EvalSymlinks(cliPath)
	if err != nil {
		// If we can't resolve symlinks, fall back to the original path
		realPath = cliPath
	}

	return filepath.Dir(realPath), nil
}

// findLocalPostgresArchive finds a local postgres archive and extracts the version from its filename.
// Pattern: supabase-postgres-<version>-<os>-<arch>.zip
// Example: supabase-postgres-17.6-darwin-arm64.zip → version "17.6"
func findLocalPostgresArchive() (path string, version string, err error) {
	cliDir, err := getCliDir()
	if err != nil {
		return "", "", err
	}

	pattern := filepath.Join(cliDir, fmt.Sprintf("supabase-postgres-*-%s-%s.zip", runtime.GOOS, runtime.GOARCH))
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return "", "", fmt.Errorf("failed to glob for postgres archive: %w", err)
	}
	if len(matches) == 0 {
		return "", "", errors.Errorf("no postgres archive found matching pattern: %s", pattern)
	}

	// Extract version from filename: supabase-postgres-17.6-darwin-arm64.zip
	filename := filepath.Base(matches[0])
	// Remove prefix "supabase-postgres-" and suffix "-<os>-<arch>.zip"
	suffix := fmt.Sprintf("-%s-%s.zip", runtime.GOOS, runtime.GOARCH)
	version = strings.TrimPrefix(filename, "supabase-postgres-")
	version = strings.TrimSuffix(version, suffix)

	if version == "" {
		return "", "", errors.Errorf("failed to extract version from filename: %s", filename)
	}

	return matches[0], version, nil
}

// extractZipToDir extracts a zip archive to a destination directory.
// Preserves the full directory structure from the archive.
func extractZipToDir(zipPath, destDir string, fsys afero.Fs) error {
	data, err := os.ReadFile(zipPath)
	if err != nil {
		return fmt.Errorf("failed to read zip file: %w", err)
	}

	r, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("failed to open zip: %w", err)
	}

	for _, f := range r.File {
		destPath := filepath.Join(destDir, f.Name)

		// Prevent zip slip vulnerability
		if !strings.HasPrefix(destPath, filepath.Clean(destDir)+string(os.PathSeparator)) {
			return fmt.Errorf("invalid file path in archive: %s", f.Name)
		}

		if f.FileInfo().IsDir() {
			if err := fsys.MkdirAll(destPath, 0755); err != nil {
				return fmt.Errorf("failed to create directory %s: %w", destPath, err)
			}
			continue
		}

		// Ensure parent directory exists
		if err := fsys.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
			return fmt.Errorf("failed to create parent directory for %s: %w", destPath, err)
		}

		// Extract file
		rc, err := f.Open()
		if err != nil {
			return fmt.Errorf("failed to open file in archive %s: %w", f.Name, err)
		}

		fileData, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return fmt.Errorf("failed to read file from archive %s: %w", f.Name, err)
		}

		// Preserve file mode (important for executables)
		mode := f.Mode()
		if err := afero.WriteFile(fsys, destPath, fileData, mode); err != nil {
			return fmt.Errorf("failed to write file %s: %w", destPath, err)
		}
	}

	return nil
}
