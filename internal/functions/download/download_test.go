package download

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func TestMain(m *testing.M) {
	// Setup fake deno binary
	if len(os.Args) > 1 && (os.Args[1] == "bundle" || os.Args[1] == "upgrade" || os.Args[1] == "run") {
		msg := os.Getenv("TEST_DENO_ERROR")
		if msg != "" {
			fmt.Fprintln(os.Stderr, msg)
			os.Exit(1)
		}
		os.Exit(0)
	}
	denoPath, err := os.Executable()
	if err != nil {
		log.Fatalln(err)
	}
	utils.DenoPathOverride = denoPath
	// Run test suite
	os.Exit(m.Run())
}

func writeConfig(t *testing.T, fsys afero.Fs) {
	t.Helper()
	require.NoError(t, utils.WriteConfig(fsys, false))
}

func newFunctionMetadata(slug string) api.FunctionSlugResponse {
	entrypoint := "file:///src/index.ts"
	status := api.FunctionSlugResponseStatus("ACTIVE")
	return api.FunctionSlugResponse{
		Id:             "1",
		Name:           slug,
		Slug:           slug,
		Status:         status,
		Version:        1,
		CreatedAt:      0,
		UpdatedAt:      0,
		EntrypointPath: &entrypoint,
	}
}

func mockFunctionMetadata(projectRef, slug string, meta api.FunctionSlugResponse) {
	gock.New(utils.DefaultApiHost).
		Get(fmt.Sprintf("/v1/projects/%s/functions/%s", projectRef, slug)).
		Reply(http.StatusOK).
		JSON(meta)
}

type multipartPart struct {
	filename     string
	supabasePath string
	contents     string
}

func mockMultipartBody(t *testing.T, projectRef, slug string, parts []multipartPart) {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	for _, part := range parts {
		headers := textproto.MIMEHeader{}
		headers.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, part.filename))
		if part.supabasePath != "" {
			headers.Set("Supabase-Path", part.supabasePath)
		}
		pw, err := writer.CreatePart(headers)
		require.NoError(t, err)
		_, err = pw.Write([]byte(part.contents))
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())

	gock.New(utils.DefaultApiHost).
		Get(fmt.Sprintf("/v1/projects/%s/functions/%s/body", projectRef, slug)).
		Reply(http.StatusOK).
		SetHeader("Content-Type", writer.FormDataContentType()).
		Body(&buf)
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	require.NoError(t, err)
	return u
}

func TestDownloadCommand(t *testing.T) {
	const slug = "test-func"

	t.Run("downloads eszip bundle", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err := fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug + "/body").
			Reply(http.StatusOK)
		// Run test
		err = Run(context.Background(), slug, project, true, false, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed slug", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Run test
		err := Run(context.Background(), "@", project, true, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "Invalid Function name.")
	})

	t.Run("throws error on failure to install deno", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Run test
		err := Run(context.Background(), slug, project, true, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on copy failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid deno path
		_, err := fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Run test
		err = Run(context.Background(), slug, project, true, false, afero.NewReadOnlyFs(fsys))
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on missing function", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err := fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound).
			JSON(map[string]string{"message": "Function not found"})
		// Run test
		err = Run(context.Background(), slug, project, true, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "Function test-func does not exist on the Supabase project.")
	})
}

func TestDownloadFunction(t *testing.T) {
	const slug = "test-func"
	// Setup valid project ref
	project := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug + "/body").
			ReplyError(errors.New("network error"))
		// Run test
		err := downloadFunction(context.Background(), project, slug, "")
		// Check error
		assert.ErrorContains(t, err, "network error")
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug + "/body").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := downloadFunction(context.Background(), project, slug, "")
		// Check error
		assert.ErrorContains(t, err, "Unexpected error downloading Function:")
	})

	t.Run("throws error on extract failure", func(t *testing.T) {
		// Setup deno error
		t.Setenv("TEST_DENO_ERROR", "extract failed")
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug + "/body").
			Reply(http.StatusOK)
		// Run test
		err := downloadFunction(context.Background(), project, slug, "")
		// Check error
		assert.ErrorContains(t, err, "Error downloading function: exit status 1\nextract failed\n")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestGetMetadata(t *testing.T) {
	const slug = "test-func"
	project := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("fallback to default paths", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		// Run test
		meta, err := getFunctionMetadata(context.Background(), project, slug)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, legacyEntrypointPath, *meta.EntrypointPath)
		assert.Equal(t, legacyImportMapPath, *meta.ImportMapPath)
	})

	t.Run("throws error on network error", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			ReplyError(errors.New("network error"))
		// Run test
		meta, err := getFunctionMetadata(context.Background(), project, slug)
		// Check error
		assert.ErrorContains(t, err, "network error")
		assert.Nil(t, meta)
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusServiceUnavailable)
		// Run test
		meta, err := getFunctionMetadata(context.Background(), project, slug)
		// Check error
		assert.ErrorContains(t, err, "Failed to download Function test-func on the Supabase project:")
		assert.Nil(t, meta)
	})
}

func TestRunNewUnbundleModes(t *testing.T) {
	const slug = "test-func"

	t.Run("downloads bundle with docker when available", func(t *testing.T) {
		const slugDocker = "demo"
		fsys := afero.NewMemMapFs()
		writeConfig(t, fsys)
		project := apitest.RandomProjectRef()
		flags.ProjectRef = project
		t.Cleanup(func() { flags.ProjectRef = "" })
		require.NoError(t, flags.LoadConfig(fsys))

		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		require.NoError(t, apitest.MockDocker(utils.Docker))
		dockerHost := utils.Docker.DaemonHost()

		defer func() {
			gock.OffAll()
			utils.CmdSuggestion = ""
		}()

		gock.New(dockerHost).
			Head("/_ping").
			Reply(http.StatusOK)

		imageURL := utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image)
		containerID := "docker-unbundle-test"
		apitest.MockDockerStart(utils.Docker, imageURL, containerID)
		require.NoError(t, apitest.MockDockerLogs(utils.Docker, containerID, "unbundle ok"))

		gock.New(utils.DefaultApiHost).
			Get(fmt.Sprintf("/v1/projects/%s/functions/%s/body", project, slugDocker)).
			Reply(http.StatusOK).
			BodyString("fake eszip payload")

		err := Run(context.Background(), slugDocker, project, false, true, fsys)
		require.NoError(t, err)

		eszipPath := filepath.Join(utils.TempDir, fmt.Sprintf("output_%s.eszip", slugDocker))
		exists, err := afero.Exists(fsys, eszipPath)
		require.NoError(t, err)
		assert.False(t, exists, "temporary eszip file should be removed after extraction")

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("falls back to server-side unbundle when docker unavailable", func(t *testing.T) {
		const slugDocker = "demo-fallback"
		fsys := afero.NewMemMapFs()
		writeConfig(t, fsys)
		project := apitest.RandomProjectRef()
		flags.ProjectRef = project
		t.Cleanup(func() { flags.ProjectRef = "" })
		require.NoError(t, flags.LoadConfig(fsys))

		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		require.NoError(t, apitest.MockDocker(utils.Docker))
		dockerHost := utils.Docker.DaemonHost()

		defer func() {
			gock.OffAll()
			utils.CmdSuggestion = ""
		}()

		gock.New(dockerHost).
			Head("/_ping").
			ReplyError(errors.New("docker unavailable"))

		meta := newFunctionMetadata(slugDocker)
		entrypoint := "file:///source/index.ts"
		meta.EntrypointPath = &entrypoint
		mockFunctionMetadata(project, slugDocker, meta)
		mockMultipartBody(t, project, slugDocker, []multipartPart{
			{filename: "source/index.ts", contents: "console.log('hello')"},
		})

		err := Run(context.Background(), slugDocker, project, false, true, fsys)
		require.NoError(t, err)

		data, err := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, slugDocker, "index.ts"))
		require.NoError(t, err)
		assert.Equal(t, "console.log('hello')", string(data))

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestDownloadWithServerSideUnbundle(t *testing.T) {
	const slug = "test-func"
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("writes files using inferred base directory", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		project := apitest.RandomProjectRef()
		t.Cleanup(func() {
			gock.OffAll()
			utils.CmdSuggestion = ""
		})

		meta := newFunctionMetadata(slug)
		entrypoint := "file:///source/index.ts"
		meta.EntrypointPath = &entrypoint
		mockFunctionMetadata(project, slug, meta)
		mockMultipartBody(t, project, slug, []multipartPart{
			{filename: "source/index.ts", contents: "console.log('hello')"},
			{filename: "source/utils.ts", contents: "export const value = 1;"},
		})

		err := downloadWithServerSideUnbundle(context.Background(), slug, project, fsys)
		require.NoError(t, err)

		data, err := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, slug, "index.ts"))
		require.NoError(t, err)
		assert.Equal(t, "console.log('hello')", string(data))

		data, err = afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, slug, "utils.ts"))
		require.NoError(t, err)
		assert.Equal(t, "export const value = 1;", string(data))

		entries, err := afero.ReadDir(fsys, utils.TempDir)
		if err == nil {
			assert.Len(t, entries, 0, "expected temporary directory to be cleaned up")
		} else {
			assert.ErrorIs(t, err, os.ErrNotExist)
		}

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("derives base directory from absolute filenames", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		project := apitest.RandomProjectRef()
		t.Cleanup(func() {
			gock.OffAll()
			utils.CmdSuggestion = ""
		})

		meta := newFunctionMetadata(slug)
		entrypoint := "file:///source/index.ts"
		meta.EntrypointPath = &entrypoint
		mockFunctionMetadata(project, slug, meta)

		// eg. /tmp/functions-download-abs/source/
		tempBase := filepath.Join(os.TempDir(), "functions-download-abs", "source")
		indexPath := filepath.Join(tempBase, "index.ts")
		utilsPath := filepath.Join(tempBase, "lib", "utils.ts")
		mockMultipartBody(t, project, slug, []multipartPart{
			{filename: indexPath, contents: "console.log('abs')"},
			{filename: utilsPath, contents: "export const util = 2;"},
		})

		err := downloadWithServerSideUnbundle(context.Background(), slug, project, fsys)
		require.NoError(t, err)

		root := filepath.Join(utils.FunctionsDir, slug)
		data, err := afero.ReadFile(fsys, filepath.Join(root, "index.ts"))
		require.NoError(t, err)
		assert.Equal(t, "console.log('abs')", string(data))

		data, err = afero.ReadFile(fsys, filepath.Join(root, "lib", "utils.ts"))
		require.NoError(t, err)
		assert.Equal(t, "export const util = 2;", string(data))

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("fails when response not multipart", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		project := apitest.RandomProjectRef()
		t.Cleanup(func() {
			gock.OffAll()
			utils.CmdSuggestion = ""
		})
		mockFunctionMetadata(project, slug, newFunctionMetadata(slug))
		gock.New(utils.DefaultApiHost).
			Get(fmt.Sprintf("/v1/projects/%s/functions/%s/body", project, slug)).
			Reply(http.StatusOK).
			SetHeader("Content-Type", "application/json").
			BodyString(`{"error":"no multipart"}`)

		err := downloadWithServerSideUnbundle(context.Background(), slug, project, fsys)
		assert.ErrorContains(t, err, "expected multipart response")
	})

	t.Run("fails when part escapes base dir", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		project := apitest.RandomProjectRef()
		t.Cleanup(func() {
			gock.OffAll()
			utils.CmdSuggestion = ""
		})

		meta := newFunctionMetadata(slug)
		entrypoint := "file:///source/index.ts"
		meta.EntrypointPath = &entrypoint
		mockFunctionMetadata(project, slug, meta)
		mockMultipartBody(t, project, slug, []multipartPart{
			{filename: "source/index.ts", contents: "console.log('hello')"},
			{filename: "source/secret.env", supabasePath: "../secret.env", contents: "SECRET=1"},
		})

		err := downloadWithServerSideUnbundle(context.Background(), slug, project, fsys)
		assert.ErrorContains(t, err, "invalid file path outside function directory")
	})
}

func TestGetPartPath(t *testing.T) {
	t.Parallel()

	newPart := func(headers map[string]string) *multipart.Part {
		mh := make(textproto.MIMEHeader, len(headers))
		for k, v := range headers {
			mh.Set(k, v)
		}
		return &multipart.Part{Header: mh}
	}

	t.Run("returns path from Supabase header", func(t *testing.T) {
		part := newPart(map[string]string{
			"Supabase-Path": "dir/file.ts",
		})
		got, err := getPartPath(part)
		require.NoError(t, err)
		assert.Equal(t, "dir/file.ts", got)
	})

	t.Run("returns filename from content disposition", func(t *testing.T) {
		part := newPart(map[string]string{
			"Content-Disposition": `form-data; name="file"; filename="test-func/index.ts"`,
		})
		got, err := getPartPath(part)
		require.NoError(t, err)
		assert.Equal(t, "test-func/index.ts", got)
	})

	t.Run("returns filename from editor-originated content disposition", func(t *testing.T) {
		part := newPart(map[string]string{
			"Content-Disposition": `form-data; name="file"; filename="source/index.ts"`,
		})
		got, err := getPartPath(part)
		require.NoError(t, err)
		assert.Equal(t, "source/index.ts", got)
	})

	t.Run("writes file of arbitrary depth", func(t *testing.T) {
		part := newPart(map[string]string{
			"Content-Disposition": `form-data; name="file"; filename="test-func/dir/subdir/file.ts"`,
		})
		got, err := getPartPath(part)
		require.NoError(t, err)
		assert.Equal(t, "test-func/dir/subdir/file.ts", got)
	})

	t.Run("returns empty when no filename provided", func(t *testing.T) {
		part := newPart(map[string]string{
			"Content-Disposition": `form-data; name="file"`,
		})
		got, err := getPartPath(part)
		require.NoError(t, err)
		assert.Equal(t, "", got)
	})

	t.Run("returns error on invalid content disposition", func(t *testing.T) {
		part := newPart(map[string]string{
			"Content-Disposition": `form-data; filename="unterminated`,
		})
		got, err := getPartPath(part)
		require.ErrorContains(t, err, "failed to parse content disposition")
		assert.Equal(t, "", got)
	})
}

func TestGetBaseDirFromEntrypoint(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		entrypoint string
		filenames  []string
		want       string
	}{
		{
			name:       "prefers relative match",
			entrypoint: "file:///source/index.ts",
			filenames:  []string{"source/index.ts", "source/utils.ts"},
			want:       "source",
		},
		{
			name:       "falls back to absolute match",
			entrypoint: "file:///src/index.ts",
			filenames:  []string{filepath.FromSlash("/tmp/project/src/index.ts")},
			want:       "/tmp/project/src",
		},
		{
			name:       "falls back to entrypoint directory",
			entrypoint: "file:///dir/api/index.ts",
			filenames:  []string{"/tmp/project/api/index.ts"},
			want:       "/dir/api",
		},
		{
			name:       "empty entrypoint returns root",
			entrypoint: "file:///",
			filenames:  nil,
			want:       "/",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := getBaseDirFromEntrypoint(mustParseURL(t, tt.entrypoint), tt.filenames)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestGetRelativePathFromBase(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		base     string
		filename string
		want     string
	}{
		{
			name:     "strips relative base",
			base:     "source",
			filename: "source/index.ts",
			want:     "index.ts",
		},
		{
			name:     "trims leading slash when base empty",
			base:     "",
			filename: "/tmp/source/index.ts",
			want:     "tmp/source/index.ts",
		},
		{
			name:     "trims leading slash when base root",
			base:     "/",
			filename: "/index.ts",
			want:     "index.ts",
		},
		{
			name:     "handles absolute base prefix",
			base:     "/tmp/source",
			filename: "/tmp/source/dir/file.ts",
			want:     "dir/file.ts",
		},
		{
			name:     "strips embedded base segment",
			base:     "source",
			filename: "/Users/foo/project/source/utils.ts",
			want:     "utils.ts",
		},
		{
			name:     "preserves escaping path when outside base",
			base:     "source",
			filename: "../secret.ts",
			want:     "../secret.ts",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := getRelativePathFromBase(tt.base, tt.filename)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestJoinWithinDir(t *testing.T) {
	t.Parallel()

	base := filepath.Join(os.TempDir(), "base-dir")

	t.Run("joins path within base directory", func(t *testing.T) {
		got, err := joinWithinDir(base, filepath.Join("sub", "file.ts"))
		require.NoError(t, err)
		cleanBase := filepath.Clean(base)
		cleanGot := filepath.Clean(got)
		assert.True(t, cleanGot == cleanBase || strings.HasPrefix(cleanGot, cleanBase+string(os.PathSeparator)))
	})

	t.Run("normalizes leading slash", func(t *testing.T) {
		got, err := joinWithinDir(base, "/foo/bar.ts")
		require.NoError(t, err)
		assert.Equal(t, filepath.Join(filepath.Clean(base), "foo", "bar.ts"), filepath.Clean(got))
	})

	t.Run("rejects parent directory traversal", func(t *testing.T) {
		got, err := joinWithinDir(base, filepath.Join("..", "escape"))
		require.Error(t, err)
		assert.Equal(t, "", got)
	})

	t.Run("accepts internal traversal", func(t *testing.T) {
		got, err := joinWithinDir(base, filepath.Join("dir", "..", "file.ts"))
		require.NoError(t, err)
		assert.Equal(t, filepath.Join(filepath.Clean(base), "file.ts"), filepath.Clean(got))
	})

	t.Run("rejects traversal beginning with ../", func(t *testing.T) {
		got, err := joinWithinDir(base, filepath.Join("..", "..", "file.ts"))
		require.Error(t, err)
		assert.Equal(t, "", got)
	})

	t.Run("rejects traversal prefixed with os separator", func(t *testing.T) {
		escape := ".." + string(os.PathSeparator) + "escape"
		got, err := joinWithinDir(base, escape)
		require.Error(t, err)
		assert.Equal(t, "", got)
	})
}
