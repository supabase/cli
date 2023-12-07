package utils

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/spf13/afero"
)

var (
	//go:embed denos/*
	denoEmbedDir embed.FS
	// Used by unit tests
	DenoPathOverride string
)

const (
	DockerDenoDir     = "/home/deno"
	DockerModsDir     = DockerDenoDir + "/modules"
	DockerFuncDirPath = DockerDenoDir + "/functions"
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

func NewImportMap(path string, fsys afero.Fs) (*ImportMap, error) {
	contents, err := fsys.Open(path)
	if err != nil {
		return nil, err
	}
	defer contents.Close()
	return NewFromReader(contents)
}

func NewFromReader(r io.Reader) (*ImportMap, error) {
	decoder := json.NewDecoder(r)
	importMap := &ImportMap{}
	if err := decoder.Decode(importMap); err != nil {
		return nil, err
	}
	return importMap, nil
}

func (m *ImportMap) Resolve(fsys afero.Fs) ImportMap {
	result := ImportMap{
		Imports: make(map[string]string, len(m.Imports)),
		Scopes:  make(map[string]map[string]string, len(m.Scopes)),
	}
	for k, v := range m.Imports {
		result.Imports[k] = resolveHostPath(v, fsys)
	}
	for module, mapping := range m.Scopes {
		result.Scopes[module] = map[string]string{}
		for k, v := range mapping {
			result.Scopes[module][k] = resolveHostPath(v, fsys)
		}
	}
	return result
}

func (m *ImportMap) BindModules(resolved ImportMap) []string {
	cwd, err := os.Getwd()
	if err != nil {
		return nil
	}
	var binds []string
	for k, dockerPath := range resolved.Imports {
		if strings.HasPrefix(dockerPath, DockerModsDir) {
			hostPath := filepath.Join(cwd, FunctionsDir, m.Imports[k])
			binds = append(binds, hostPath+":"+dockerPath+":ro,z")
		}
	}
	for module, mapping := range resolved.Scopes {
		for k, dockerPath := range mapping {
			if strings.HasPrefix(dockerPath, DockerModsDir) {
				hostPath := filepath.Join(cwd, FunctionsDir, m.Scopes[module][k])
				binds = append(binds, hostPath+":"+dockerPath+":ro,z")
			}
		}
	}
	return binds
}

func resolveHostPath(hostPath string, fsys afero.Fs) string {
	// All local fs imports will be mounted to /home/deno/modules
	if filepath.IsAbs(hostPath) {
		return getModulePath(hostPath)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return hostPath
	}
	rel := filepath.Join(FunctionsDir, hostPath)
	if strings.HasPrefix(rel, FunctionsDir) {
		return hostPath
	}
	rebased := filepath.Join(cwd, rel)
	if exists, _ := afero.Exists(fsys, rebased); !exists {
		return hostPath
	}
	// Directory imports need to be suffixed with /
	// Ref: https://deno.com/manual@v1.33.0/basics/import_maps
	if strings.HasSuffix(hostPath, "/") {
		rel += "/"
	}
	return getModulePath(rel)
}

func getModulePath(hostPath string) string {
	mod := path.Join(DockerModsDir, GetPathHash(hostPath))
	if strings.HasSuffix(hostPath, "/") {
		mod += "/"
	}
	return mod
}

func GetPathHash(path string) string {
	digest := sha256.Sum256([]byte(path))
	return hex.EncodeToString(digest[:])
}

func AbsImportMapPath(importMapPath, slug string, fsys afero.Fs) (string, error) {
	if importMapPath == "" {
		if functionConfig, ok := Config.Functions[slug]; ok && functionConfig.ImportMap != "" {
			importMapPath = functionConfig.ImportMap
			if !filepath.IsAbs(importMapPath) {
				importMapPath = filepath.Join(SupabaseDirPath, importMapPath)
			}
		} else if exists, _ := afero.Exists(fsys, FallbackImportMapPath); exists {
			importMapPath = FallbackImportMapPath
		} else {
			return importMapPath, nil
		}
	}
	resolved, err := filepath.Abs(importMapPath)
	if err != nil {
		return "", err
	}
	if f, err := fsys.Stat(resolved); err != nil {
		return "", fmt.Errorf("Failed to read import map: %w", err)
	} else if f.IsDir() {
		return "", errors.New("Importing directory is unsupported: " + resolved)
	}
	return resolved, nil
}

func AbsTempImportMapPath(cwd, hostPath string) string {
	name := GetPathHash(hostPath) + ".json"
	return filepath.Join(cwd, ImportMapsDir, name)
}

func BindImportMap(hostImportMapPath, dockerImportMapPath string, fsys afero.Fs) ([]string, error) {
	importMap, err := NewImportMap(hostImportMapPath, fsys)
	if err != nil {
		return nil, err
	}
	resolved := importMap.Resolve(fsys)
	binds := importMap.BindModules(resolved)
	if len(binds) > 0 {
		cwd, err := os.Getwd()
		if err != nil {
			return nil, err
		}
		contents, err := json.MarshalIndent(resolved, "", "    ")
		if err != nil {
			return nil, err
		}
		// Rewrite import map to temporary host path
		hostImportMapPath = AbsTempImportMapPath(cwd, hostImportMapPath)
		if err := WriteFile(hostImportMapPath, contents, fsys); err != nil {
			return nil, err
		}
	}
	binds = append(binds, hostImportMapPath+":"+dockerImportMapPath+":ro,z")
	return binds, nil
}
