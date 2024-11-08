package utils

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
)

var (
	//go:embed denos/*
	denoEmbedDir embed.FS
	// Used by unit tests
	DenoPathOverride string
)

const (
	// Legacy bundle options
	DockerDenoDir  = "/home/deno"
	DockerEszipDir = "/root/eszips"
	DenoVersion    = "1.30.3"
)

func GetDenoPath() (string, error) {
	if len(DenoPathOverride) > 0 {
		return DenoPathOverride, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	denoBinName := "deno"
	if runtime.GOOS == "windows" {
		denoBinName = "deno.exe"
	}
	denoPath := filepath.Join(home, ".supabase", denoBinName)
	return denoPath, nil
}

func InstallOrUpgradeDeno(ctx context.Context, fsys afero.Fs) error {
	denoPath, err := GetDenoPath()
	if err != nil {
		return err
	}

	if _, err := fsys.Stat(denoPath); err == nil {
		// Upgrade Deno.
		cmd := exec.CommandContext(ctx, denoPath, "upgrade", "--version", DenoVersion)
		cmd.Stderr = os.Stderr
		cmd.Stdout = os.Stdout
		return cmd.Run()
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	// Install Deno.
	if err := MkdirIfNotExistFS(fsys, filepath.Dir(denoPath)); err != nil {
		return err
	}

	// 1. Determine OS triple
	assetFilename, err := getDenoAssetFileName()
	if err != nil {
		return err
	}
	assetRepo := "denoland/deno"
	if runtime.GOOS == "linux" && runtime.GOARCH == "arm64" {
		// TODO: version pin to official release once available https://github.com/denoland/deno/issues/1846
		assetRepo = "LukeChannings/deno-arm64"
	}

	// 2. Download & install Deno binary.
	{
		assetUrl := fmt.Sprintf("https://github.com/%s/releases/download/v%s/%s", assetRepo, DenoVersion, assetFilename)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, assetUrl, nil)
		if err != nil {
			return err
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		if resp.StatusCode != 200 {
			return errors.New("Failed installing Deno binary.")
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}

		r, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
		// There should be only 1 file: the deno binary
		if len(r.File) != 1 {
			return err
		}
		denoContents, err := r.File[0].Open()
		if err != nil {
			return err
		}
		defer denoContents.Close()

		denoBytes, err := io.ReadAll(denoContents)
		if err != nil {
			return err
		}

		if err := afero.WriteFile(fsys, denoPath, denoBytes, 0755); err != nil {
			return err
		}
	}

	return nil
}

func isScriptModified(fsys afero.Fs, destPath string, src []byte) (bool, error) {
	dest, err := afero.ReadFile(fsys, destPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return true, nil
		}
		return false, err
	}

	// compare the md5 checksum of src bytes with user's copy.
	// if the checksums doesn't match, script is modified.
	return sha256.Sum256(dest) != sha256.Sum256(src), nil
}

type DenoScriptDir struct {
	ExtractPath string
	BuildPath   string
}

// Copy Deno scripts needed for function deploy and downloads, returning a DenoScriptDir struct or an error.
func CopyDenoScripts(ctx context.Context, fsys afero.Fs) (*DenoScriptDir, error) {
	denoPath, err := GetDenoPath()
	if err != nil {
		return nil, err
	}

	denoDirPath := filepath.Dir(denoPath)
	scriptDirPath := filepath.Join(denoDirPath, "denos")

	// make the script directory if not exist
	if err := MkdirIfNotExistFS(fsys, scriptDirPath); err != nil {
		return nil, err
	}

	// copy embed files to script directory
	err = fs.WalkDir(denoEmbedDir, "denos", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		// skip copying the directory
		if d.IsDir() {
			return nil
		}

		destPath := filepath.Join(denoDirPath, path)

		contents, err := fs.ReadFile(denoEmbedDir, path)
		if err != nil {
			return err
		}

		// check if the script should be copied
		modified, err := isScriptModified(fsys, destPath, contents)
		if err != nil {
			return err
		}
		if !modified {
			return nil
		}

		if err := afero.WriteFile(fsys, filepath.Join(denoDirPath, path), contents, 0666); err != nil {
			return err
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	sd := DenoScriptDir{
		ExtractPath: filepath.Join(scriptDirPath, "extract.ts"),
		BuildPath:   filepath.Join(scriptDirPath, "build.ts"),
	}

	return &sd, nil
}

type ImportMap struct {
	Imports map[string]string            `json:"imports"`
	Scopes  map[string]map[string]string `json:"scopes"`
}

func NewImportMap(absJsonPath string, fsys afero.Fs) (*ImportMap, error) {
	contents, err := fsys.Open(absJsonPath)
	if err != nil {
		return nil, errors.Errorf("failed to load import map: %w", err)
	}
	defer contents.Close()
	result := ImportMap{}
	decoder := json.NewDecoder(contents)
	if err := decoder.Decode(&result); err != nil {
		return nil, errors.Errorf("failed to parse import map: %w", err)
	}
	// Resolve all paths relative to current file
	for k, v := range result.Imports {
		result.Imports[k] = resolveHostPath(absJsonPath, v, fsys)
	}
	for module, mapping := range result.Scopes {
		for k, v := range mapping {
			result.Scopes[module][k] = resolveHostPath(absJsonPath, v, fsys)
		}
	}
	return &result, nil
}

func resolveHostPath(jsonPath, hostPath string, fsys afero.Fs) string {
	// Leave absolute paths unchanged
	if filepath.IsAbs(hostPath) {
		return hostPath
	}
	resolved := filepath.Join(filepath.Dir(jsonPath), hostPath)
	if exists, err := afero.Exists(fsys, resolved); !exists {
		// Leave URLs unchanged
		if err != nil {
			logger := GetDebugLogger()
			fmt.Fprintln(logger, err)
		}
		return hostPath
	}
	// Directory imports need to be suffixed with /
	// Ref: https://deno.com/manual@v1.33.0/basics/import_maps
	if strings.HasSuffix(hostPath, string(filepath.Separator)) {
		resolved += string(filepath.Separator)
	}
	return resolved
}

func (m *ImportMap) BindHostModules() []string {
	hostFuncDir, err := filepath.Abs(FunctionsDir)
	if err != nil {
		logger := GetDebugLogger()
		fmt.Fprintln(logger, err)
	}
	binds := []string{}
	for _, hostPath := range m.Imports {
		if !filepath.IsAbs(hostPath) || strings.HasPrefix(hostPath, hostFuncDir) {
			continue
		}
		dockerPath := ToDockerPath(hostPath)
		binds = append(binds, hostPath+":"+dockerPath+":ro")
	}
	for _, mapping := range m.Scopes {
		for _, hostPath := range mapping {
			if !filepath.IsAbs(hostPath) || strings.HasPrefix(hostPath, hostFuncDir) {
				continue
			}
			dockerPath := ToDockerPath(hostPath)
			binds = append(binds, hostPath+":"+dockerPath+":ro")
		}
	}
	return binds
}

func ToDockerPath(absHostPath string) string {
	prefix := filepath.VolumeName(absHostPath)
	dockerPath := filepath.ToSlash(absHostPath)
	return strings.TrimPrefix(dockerPath, prefix)
}
