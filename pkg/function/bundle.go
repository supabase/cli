package function

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/andybalholm/brotli"
	"github.com/go-errors/errors"
)

type nativeBundler struct {
	tempDir string
	fsys    fs.FS
}

func NewNativeBundler(tempDir string, fsys fs.FS) EszipBundler {
	return &nativeBundler{
		tempDir: tempDir,
		fsys:    fsys,
	}
}

// Use a package private variable to allow testing without gosec complaining about G204
var edgeRuntimeBin = "edge-runtime"

func (b *nativeBundler) Bundle(ctx context.Context, entrypoint string, importMap string, output io.Writer) error {
	slug := filepath.Base(filepath.Dir(entrypoint))
	outputPath := filepath.Join(b.tempDir, slug+".eszip")
	// TODO: make edge runtime write to stdout
	args := []string{"bundle", "--entrypoint", entrypoint, "--output", outputPath}
	if len(importMap) > 0 {
		args = append(args, "--import-map", importMap)
	}
	cmd := exec.CommandContext(ctx, edgeRuntimeBin, args...)
	cmd.Stderr = os.Stderr
	cmd.Stdout = os.Stdout
	if err := cmd.Run(); err != nil {
		return errors.Errorf("failed to bundle function: %w", err)
	}
	defer os.Remove(outputPath)
	// Compress the output
	eszipBytes, err := b.fsys.Open(outputPath)
	if err != nil {
		return errors.Errorf("failed to open eszip: %w", err)
	}
	defer eszipBytes.Close()
	return Compress(eszipBytes, output)
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
