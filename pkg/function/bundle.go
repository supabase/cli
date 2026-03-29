package function

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/go-errors/errors"
	"github.com/supabase/cli/pkg/cast"
)

type nativeBundler struct {
	tempDir     string
	fsys        fs.FS
	timeout     time.Duration
	denoVersion uint
}

func NewNativeBundler(tempDir string, fsys fs.FS, opts ...func(*nativeBundler)) EszipBundler {
	b := &nativeBundler{
		tempDir:     tempDir,
		fsys:        fsys,
		denoVersion: 2,
	}
	for _, apply := range opts {
		apply(b)
	}
	return b
}

func WithTimeout(timeout time.Duration) func(*nativeBundler) {
	return func(b *nativeBundler) {
		b.timeout = timeout
	}
}

func WithDenoVersion(version uint) func(*nativeBundler) {
	return func(b *nativeBundler) {
		b.denoVersion = version
	}
}

var (
	// Use a package private variable to allow testing without gosec complaining about G204
	edgeRuntimeBin = "edge-runtime"
	BundleFlags    = []string{}
)

func (b *nativeBundler) Bundle(ctx context.Context, slug, entrypoint, importMap string, staticFiles []string, output io.Writer) (FunctionDeployMetadata, error) {
	meta := NewMetadata(slug, entrypoint, importMap, staticFiles)
	outputPath := filepath.Join(b.tempDir, slug+".eszip")
	// TODO: make edge runtime write to stdout
	args := []string{"bundle", "--entrypoint", entrypoint, "--output", outputPath}
	if len(importMap) > 0 && !ShouldUseDenoJsonDiscovery(entrypoint, importMap) {
		args = append(args, "--import-map", importMap)
	}
	for _, staticFile := range staticFiles {
		args = append(args, "--static", staticFile)
	}
	args = append(args, BundleFlags...)
	if b.timeout > 0 {
		timeoutCtx, cancel := context.WithTimeout(ctx, b.timeout)
		defer cancel() // release resources if command exits before timeout
		ctx = timeoutCtx
	}
	cmd := exec.CommandContext(ctx, edgeRuntimeBin, args...)
	cmd.Stderr = os.Stderr
	cmd.Stdout = os.Stdout
	if fsys, ok := b.fsys.(fs.StatFS); ok && !ShouldUsePackageJsonDiscovery(entrypoint, importMap, fsys) {
		cmd.Env = append(cmd.Environ(), "DENO_NO_PACKAGE_JSON=1")
	}
	if err := cmd.Run(); err != nil {
		return meta, errors.Errorf("failed to bundle function: %w", err)
	}
	defer os.Remove(outputPath)
	// Compress the output
	eszipBytes, err := b.fsys.Open(outputPath)
	if err != nil {
		return meta, errors.Errorf("failed to open eszip: %w", err)
	}
	defer eszipBytes.Close()
	return meta, Compress(eszipBytes, output)
}

func ShouldUseDenoJsonDiscovery(entrypoint, importMap string) bool {
	return isDeno(filepath.Base(importMap)) && filepath.Dir(importMap) == filepath.Dir(entrypoint)
}

func ShouldUsePackageJsonDiscovery(entrypoint, importMap string, fsys fs.StatFS) bool {
	if len(importMap) > 0 {
		return false
	}
	packageJsonPath := filepath.Join(filepath.Dir(entrypoint), "package.json")
	if _, err := fsys.Stat(packageJsonPath); errors.Is(err, os.ErrNotExist) {
		return false
	}
	return true
}

const compressedEszipMagicID = "EZBR"

func Compress(r io.Reader, w io.Writer) error {
	if _, err := fmt.Fprint(w, compressedEszipMagicID); err != nil {
		return errors.Errorf("failed to append magic id: %w", err)
	}
	brw := brotli.NewWriter(w)
	defer brw.Close()
	if _, err := io.Copy(brw, r); err != nil {
		return errors.Errorf("failed to compress eszip: %w", err)
	}
	return nil
}

func NewMetadata(slug, entrypoint, importMap string, staticFiles []string) FunctionDeployMetadata {
	meta := FunctionDeployMetadata{
		Name:           &slug,
		EntrypointPath: toFileURL(entrypoint),
	}
	if len(importMap) > 0 {
		meta.ImportMapPath = cast.Ptr(toFileURL(importMap))
	}
	files := make([]string, len(staticFiles))
	for i, sf := range staticFiles {
		files[i] = toFileURL(sf)
	}
	meta.StaticPatterns = &files
	return meta
}

func toFileURL(hostPath string) string {
	absHostPath, err := filepath.Abs(hostPath)
	if err != nil {
		return hostPath
	}
	// Convert to unix path because edge runtime only supports linux
	unixPath := toUnixPath(absHostPath)
	parsed := url.URL{Scheme: "file", Path: unixPath}
	return parsed.String()
}

func toUnixPath(absHostPath string) string {
	prefix := filepath.VolumeName(absHostPath)
	unixPath := filepath.ToSlash(absHostPath)
	return strings.TrimPrefix(unixPath, prefix)
}
