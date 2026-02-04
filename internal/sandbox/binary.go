package sandbox

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"

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

// InstallBinaries downloads and installs all required binaries if not already present.
func InstallBinaries(ctx context.Context, fsys afero.Fs, binDir string) error {
	// Ensure bin directory exists
	if err := fsys.MkdirAll(binDir, 0755); err != nil {
		return fmt.Errorf("failed to create bin directory: %w", err)
	}

	// Install gotrue
	gotruePath := GetGotruePath(binDir)
	if err := installGotrueFromLocalOrDownload(ctx, fsys, gotruePath); err != nil {
		return fmt.Errorf("failed to install gotrue: %w", err)
	}

	// Install postgrest
	postgrestPath := GetPostgrestPath(binDir)
	postgrestURL, err := getPostgrestDownloadURL()
	if err != nil {
		return fmt.Errorf("postgrest: %w", err)
	}
	// PostgREST uses .tar.xz format
	if err := installBinaryIfMissingXZ(ctx, fsys, postgrestPath, postgrestURL); err != nil {
		return fmt.Errorf("failed to install postgrest: %w", err)
	}

	return nil
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
