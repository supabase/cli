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
	NginxVersion     = "1.28.1"  // Latest available from nginx-binaries
	GotrueVersion    = "2.186.0" // Local build for darwin-arm64
	PostgrestVersion = "14.4"
)

// GetNginxPath returns the path to the nginx binary.
func GetNginxPath(binDir string) string {
	name := "nginx"
	if runtime.GOOS == "windows" {
		name = "nginx.exe"
	}
	return filepath.Join(binDir, name)
}

// GetGotruePath returns the path to the gotrue binary.
func GetGotruePath(binDir string) string {
	name := "gotrue"
	if runtime.GOOS == "windows" {
		name = "gotrue.exe"
	}
	return filepath.Join(binDir, name)
}

// GetPostgrestPath returns the path to the postgrest binary.
func GetPostgrestPath(binDir string) string {
	name := "postgrest"
	if runtime.GOOS == "windows" {
		name = "postgrest.exe"
	}
	return filepath.Join(binDir, name)
}

// InstallBinaries downloads and installs all required binaries if not already present.
func InstallBinaries(ctx context.Context, fsys afero.Fs, binDir string) error {
	// Ensure bin directory exists
	if err := fsys.MkdirAll(binDir, 0755); err != nil {
		return fmt.Errorf("failed to create bin directory: %w", err)
	}

	// Install nginx
	nginxPath := GetNginxPath(binDir)
	nginxURL, err := getNginxDownloadURL()
	if err != nil {
		return fmt.Errorf("nginx: %w", err)
	}
	if err := installBinaryIfMissing(ctx, fsys, nginxPath, nginxURL, false); err != nil {
		return fmt.Errorf("failed to install nginx: %w", err)
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

// installGotrueFromLocalOrDownload checks for a local gotrue binary first, then falls back to download.
// This is a workaround since gotrue doesn't publish darwin binaries yet.
func installGotrueFromLocalOrDownload(ctx context.Context, fsys afero.Fs, binPath string) error {
	// Check if already installed
	if _, err := fsys.Stat(binPath); err == nil {
		return nil // Already installed
	}

	// Check for local binary (for development/demo purposes)
	// Look in the CLI source directory where the binary was placed
	if runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" {
		localBinary := "/Users/jgoux/Code/supabase/cli/auth-v" + GotrueVersion + "-darwin-arm64"
		if data, err := os.ReadFile(localBinary); err == nil {
			fmt.Printf("Copying local %s to cache...\n", filepath.Base(localBinary))
			if err := afero.WriteFile(fsys, binPath, data, 0755); err != nil {
				return fmt.Errorf("failed to copy local gotrue: %w", err)
			}
			return nil
		}
	}

	// Fall back to download
	gotrueURL, err := getGotrueDownloadURL()
	if err != nil {
		return err
	}
	return installBinaryIfMissing(ctx, fsys, binPath, gotrueURL, true)
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

	// Direct binary download (nginx)
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

// extractTarGz extracts the first executable from a .tar.gz archive.
func extractTarGz(r io.Reader, binPath string, fsys afero.Fs) error {
	gzr, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("failed to create gzip reader: %w", err)
	}
	defer gzr.Close()

	return extractTar(gzr, binPath, fsys)
}

// extractTarXz extracts the first executable from a .tar.xz archive.
func extractTarXz(r io.Reader, binPath string, fsys afero.Fs) error {
	xzr, err := xz.NewReader(r)
	if err != nil {
		return fmt.Errorf("failed to create xz reader: %w", err)
	}

	return extractTar(xzr, binPath, fsys)
}

// extractTar extracts the binary from a tar archive.
func extractTar(r io.Reader, binPath string, fsys afero.Fs) error {
	tr := tar.NewReader(r)
	binName := filepath.Base(binPath)

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
		if name == binName || name == binName+".exe" {
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

	return errors.Errorf("binary %s not found in archive", binName)
}

// getNginxDownloadURL returns the download URL for nginx based on the current platform.
// nginx binaries are plain executables (not archives).
// Binaries are hosted on GitHub: https://github.com/jirutka/nginx-binaries
func getNginxDownloadURL() (string, error) {
	base := "https://raw.githubusercontent.com/jirutka/nginx-binaries/binaries/"

	switch {
	case runtime.GOOS == "darwin" && runtime.GOARCH == "arm64":
		return base + "nginx-" + NginxVersion + "-arm64-darwin", nil
	case runtime.GOOS == "darwin" && runtime.GOARCH == "amd64":
		return base + "nginx-" + NginxVersion + "-x86_64-darwin", nil
	case runtime.GOOS == "linux" && runtime.GOARCH == "amd64":
		return base + "nginx-" + NginxVersion + "-x86_64-linux", nil
	case runtime.GOOS == "linux" && runtime.GOARCH == "arm64":
		return base + "nginx-" + NginxVersion + "-aarch64-linux", nil
	case runtime.GOOS == "windows":
		return base + "nginx-" + NginxVersion + "-x86_64-win32.exe", nil
	default:
		return "", errors.Errorf("unsupported platform: %s/%s", runtime.GOOS, runtime.GOARCH)
	}
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
