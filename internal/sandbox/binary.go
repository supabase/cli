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

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
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

// InstallBinaries downloads and installs all required binaries if not already present.
// Returns the postgres version that was installed/found.
func InstallBinaries(ctx context.Context, fsys afero.Fs, binDir string) (postgresVersion string, err error) {
	// Ensure bin directory exists
	if err := fsys.MkdirAll(binDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create bin directory: %w", err)
	}

	// Install gotrue
	gotruePath := GetGotruePath(binDir)
	if err := installGotrueFromLocalOrDownload(ctx, fsys, gotruePath); err != nil {
		return "", fmt.Errorf("failed to install gotrue: %w", err)
	}

	// Install postgrest
	postgrestPath := GetPostgrestPath(binDir)
	postgrestURL, err := getPostgrestDownloadURL()
	if err != nil {
		return "", fmt.Errorf("postgrest: %w", err)
	}
	// PostgREST uses .tar.xz format
	if err := installBinaryIfMissingXZ(ctx, fsys, postgrestPath, postgrestURL); err != nil {
		return "", fmt.Errorf("failed to install postgrest: %w", err)
	}

	// Install postgres
	postgresVersion, err = installPostgresFromLocalOrDownload(ctx, fsys, binDir)
	if err != nil {
		return "", fmt.Errorf("failed to install postgres: %w", err)
	}

	return postgresVersion, nil
}

// installGotrueFromLocalOrDownload installs the gotrue binary, checking local sources first.
// For darwin/arm64, there's no official release yet, so we check for a locally built binary.
func installGotrueFromLocalOrDownload(ctx context.Context, fsys afero.Fs, binPath string) error {
	// Check if already installed
	if _, err := fsys.Stat(binPath); err == nil {
		return nil // Already installed
	}

	// Ensure parent directory exists (for versioned paths)
	if err := fsys.MkdirAll(filepath.Dir(binPath), 0755); err != nil {
		return fmt.Errorf("failed to create binary directory: %w", err)
	}

	// For darwin/arm64, check for a locally built binary first (no official release yet)
	if runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" {
		localBinaryName := fmt.Sprintf("auth-v%s-darwin-arm64", GotrueVersion)
		// Check next to the CLI binary (for development)
		if cliPath, err := os.Executable(); err == nil {
			localPath := filepath.Join(filepath.Dir(cliPath), localBinaryName)
			if data, err := os.ReadFile(localPath); err == nil {
				fmt.Printf("Installing %s from local binary...\n", filepath.Base(binPath))
				if err := afero.WriteFile(fsys, binPath, data, 0755); err != nil {
					return fmt.Errorf("failed to copy local gotrue: %w", err)
				}
				return nil
			}
		}
	}

	// Fall back to download from GitHub releases
	gotrueURL, err := getGotrueDownloadURL()
	if err != nil {
		return err
	}
	return installBinaryFromArchive(ctx, fsys, binPath, gotrueURL, "auth")
}

// installBinaryIfMissing downloads a binary if not already cached.
// If isArchive is true, it expects a .tar.gz archive containing the binary.
func installBinaryIfMissing(ctx context.Context, fsys afero.Fs, binPath, downloadURL string, isArchive bool) error {
	// Check if already installed
	if _, err := fsys.Stat(binPath); err == nil {
		return nil // Already installed
	} else if !os.IsNotExist(err) {
		return err
	}

	// Ensure parent directory exists (for versioned paths like bin/gotrue/2.186.0/)
	if err := fsys.MkdirAll(filepath.Dir(binPath), 0755); err != nil {
		return fmt.Errorf("failed to create binary directory: %w", err)
	}

	fmt.Printf("Downloading %s...\n", filepath.Base(binPath))

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

	if isArchive {
		// Extract from .tar.gz
		return extractTarGz(resp.Body, binPath, fsys)
	}

	// Direct binary download
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	if err := afero.WriteFile(fsys, binPath, data, 0755); err != nil {
		return err
	}

	return nil
}

// installBinaryIfMissingXZ handles .tar.xz archives (used by PostgREST).
func installBinaryIfMissingXZ(ctx context.Context, fsys afero.Fs, binPath, downloadURL string) error {
	// Check if already installed
	if _, err := fsys.Stat(binPath); err == nil {
		return nil // Already installed
	} else if !os.IsNotExist(err) {
		return err
	}

	// Ensure parent directory exists (for versioned paths like bin/postgrest/14.4/)
	if err := fsys.MkdirAll(filepath.Dir(binPath), 0755); err != nil {
		return fmt.Errorf("failed to create binary directory: %w", err)
	}

	fmt.Printf("Downloading %s...\n", filepath.Base(binPath))

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

	// Extract from .tar.xz
	return extractTarXz(resp.Body, binPath, fsys)
}

// installBinaryFromArchive downloads and extracts a binary from a .tar.gz archive.
// srcBinName is the name of the binary inside the archive (e.g., "auth" for gotrue).
func installBinaryFromArchive(ctx context.Context, fsys afero.Fs, binPath, downloadURL, srcBinName string) error {
	// Check if already installed
	if _, err := fsys.Stat(binPath); err == nil {
		return nil // Already installed
	} else if !os.IsNotExist(err) {
		return err
	}

	// Ensure parent directory exists
	if err := fsys.MkdirAll(filepath.Dir(binPath), 0755); err != nil {
		return fmt.Errorf("failed to create binary directory: %w", err)
	}

	fmt.Printf("Downloading %s...\n", filepath.Base(binPath))

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

// findLocalPostgresArchive finds a local postgres archive and extracts the version from its filename.
// Pattern: supabase-postgres-<version>-<os>-<arch>.zip
// Example: supabase-postgres-17.6-darwin-arm64.zip → version "17.6"
func findLocalPostgresArchive() (path string, version string, err error) {
	cliPath, err := os.Executable()
	if err != nil {
		return "", "", fmt.Errorf("failed to get executable path: %w", err)
	}

	pattern := filepath.Join(filepath.Dir(cliPath), fmt.Sprintf("supabase-postgres-*-%s-%s.zip", runtime.GOOS, runtime.GOARCH))
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

// installPostgresFromLocalOrDownload installs PostgreSQL from a local zip archive.
// Returns the version that was installed.
func installPostgresFromLocalOrDownload(ctx context.Context, fsys afero.Fs, binDir string) (version string, err error) {
	// Find local postgres archive and extract version
	archivePath, version, err := findLocalPostgresArchive()
	if err != nil {
		return "", err
	}

	postgresDir := GetPostgresDir(binDir, version)

	// Check if already installed (check for postgres binary)
	postgresBin := GetPostgresBinPath(binDir, version, "postgres")
	if _, err := fsys.Stat(postgresBin); err == nil {
		return version, nil // Already installed
	}

	// Ensure parent directory exists
	if err := fsys.MkdirAll(postgresDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create postgres directory: %w", err)
	}

	fmt.Printf("Installing PostgreSQL %s from local archive...\n", version)

	// Read and extract the zip archive
	if err := extractZipToDir(archivePath, postgresDir, fsys); err != nil {
		return "", fmt.Errorf("failed to extract postgres archive: %w", err)
	}

	// On macOS, re-sign all binaries and libraries to fix code signature issues
	if runtime.GOOS == "darwin" {
		if err := codesignPostgresDir(postgresDir); err != nil {
			return "", fmt.Errorf("failed to codesign postgres binaries: %w", err)
		}
	}

	return version, nil
}

// codesignPostgresDir re-signs all binaries and libraries in the postgres directory.
// This is necessary on macOS because extracted binaries may have invalid code signatures.
func codesignPostgresDir(postgresDir string) error {
	// Find all executable files and dylibs that need signing
	return filepath.Walk(postgresDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}

		// Sign executables and dylibs
		needsSign := false
		if info.Mode()&0111 != 0 { // executable
			needsSign = true
		}
		if strings.HasSuffix(path, ".dylib") {
			needsSign = true
		}

		if needsSign {
			cmd := exec.Command("codesign", "-f", "-s", "-", path)
			if err := cmd.Run(); err != nil {
				// Log but don't fail - some files might not need signing
				fmt.Fprintf(os.Stderr, "Warning: failed to codesign %s: %v\n", filepath.Base(path), err)
			}
		}
		return nil
	})
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
