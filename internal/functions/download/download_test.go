package download

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path"
	"path/filepath"
	"testing"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
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

type multipartPart struct {
	filename     string
	supabasePath string
	contents     string
}

func mockMultipartBody(t *testing.T, projectRef, slug string, metadata bundleMetadata, parts []multipartPart) {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	// Write metadata
	headers := textproto.MIMEHeader{}
	headers.Set("Content-Disposition", `form-data; name="metadata"`)
	headers.Set("Content-Type", "application/json")
	pw, err := writer.CreatePart(headers)
	require.NoError(t, err)
	enc := json.NewEncoder(pw)
	require.NoError(t, enc.Encode(metadata))
	// Write files
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

func TestRunLegacyUnbundle(t *testing.T) {
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

func TestRunDockerUnbundle(t *testing.T) {
	t.Run("downloads bundle with docker when available", func(t *testing.T) {
		const slugDocker = "demo"
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		project := apitest.RandomProjectRef()
		require.NoError(t, flags.LoadConfig(fsys))

		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		require.NoError(t, apitest.MockDocker(utils.Docker))
		dockerHost := utils.Docker.DaemonHost()

		// Setup mock api
		defer gock.OffAll()

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
		require.NoError(t, utils.WriteConfig(fsys, false))
		project := apitest.RandomProjectRef()
		require.NoError(t, flags.LoadConfig(fsys))

		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

		require.NoError(t, apitest.MockDocker(utils.Docker))
		dockerHost := utils.Docker.DaemonHost()

		// Setup mock api
		defer gock.OffAll()

		gock.New(dockerHost).
			Head("/_ping").
			ReplyError(errors.New("docker unavailable"))

		mockMultipartBody(t, project, slugDocker, bundleMetadata{"/source/index.ts"}, []multipartPart{
			{filename: "/source/index.ts", contents: "console.log('hello')"},
		})

		err := Run(context.Background(), slugDocker, project, false, true, fsys)
		require.NoError(t, err)

		data, err := afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, slugDocker, "index.ts"))
		require.NoError(t, err)
		assert.Equal(t, "console.log('hello')", string(data))

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestRunServerSideUnbundle(t *testing.T) {
	const slug = "test-func"
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
	project := apitest.RandomProjectRef()

	t.Run("writes files using inferred base directory", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))

		defer gock.OffAll()
		mockMultipartBody(t, project, slug, bundleMetadata{EntrypointPath: "source/index.ts"}, []multipartPart{
			{filename: "source/index.ts", contents: "console.log('hello')"},
			{filename: "source/utils.ts", contents: "export const value = 1;"},
		})

		err := Run(context.Background(), slug, project, false, false, fsys)
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
		require.NoError(t, utils.WriteConfig(fsys, false))

		defer gock.OffAll()
		indexPath := "/tmp/functions-download-abs/source/index.ts"
		utilsPath := path.Join(path.Dir(indexPath), "lib", "utils.ts")
		mockMultipartBody(t, project, slug, bundleMetadata{}, []multipartPart{
			{filename: indexPath, contents: "console.log('abs')"},
			{filename: utilsPath, contents: "export const util = 2;"},
		})

		gock.New(utils.DefaultApiHost).
			Get(fmt.Sprintf("/v1/projects/%s/functions/%s", project, slug)).
			Reply(http.StatusOK).
			JSON(api.FunctionSlugResponse{
				Id:             "1",
				Name:           slug,
				Slug:           slug,
				Status:         api.FunctionSlugResponseStatus("ACTIVE"),
				Version:        1,
				CreatedAt:      0,
				UpdatedAt:      0,
				EntrypointPath: cast.Ptr("file://" + indexPath),
			})

		err := Run(context.Background(), slug, project, false, false, fsys)
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
		require.NoError(t, utils.WriteConfig(fsys, false))

		defer gock.OffAll()
		gock.New(utils.DefaultApiHost).
			Get(fmt.Sprintf("/v1/projects/%s/functions/%s", project, slug)).
			Reply(http.StatusOK).
			JSON(api.FunctionSlugResponse{
				Id:             "1",
				Name:           slug,
				Slug:           slug,
				Status:         api.FunctionSlugResponseStatus("ACTIVE"),
				Version:        1,
				CreatedAt:      0,
				UpdatedAt:      0,
				EntrypointPath: cast.Ptr(legacyEntrypointPath),
			})

		gock.New(utils.DefaultApiHost).
			Get(fmt.Sprintf("/v1/projects/%s/functions/%s/body", project, slug)).
			Reply(http.StatusOK).
			SetHeader("Content-Type", "application/json").
			BodyString(`{"error":"no multipart"}`)

		err := Run(context.Background(), slug, project, false, false, fsys)
		assert.ErrorContains(t, err, "expected multipart response")
	})

	t.Run("ignores unresolvable entrypoint path", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))

		defer gock.OffAll()
		mockMultipartBody(t, project, slug, bundleMetadata{}, []multipartPart{
			{filename: "source/index.ts", contents: "console.log('hello')"},
			{filename: "source/secret.env", supabasePath: "../secret.env", contents: "SECRET=1"},
		})

		gock.New(utils.DefaultApiHost).
			Get(fmt.Sprintf("/v1/projects/%s/functions/%s", project, slug)).
			Reply(http.StatusOK).
			JSON(api.FunctionSlugResponse{
				Id:             "1",
				Name:           slug,
				Slug:           slug,
				Status:         api.FunctionSlugResponseStatus("ACTIVE"),
				Version:        1,
				CreatedAt:      0,
				UpdatedAt:      0,
				EntrypointPath: cast.Ptr("file:///source/index.ts"),
			})

		err := Run(context.Background(), slug, project, false, false, fsys)
		assert.NoError(t, err)

		root := filepath.Join(utils.FunctionsDir, slug)
		data, err := afero.ReadFile(fsys, filepath.Join(root, "source", "index.ts"))
		require.NoError(t, err)
		assert.Equal(t, "console.log('hello')", string(data))

		data, err = afero.ReadFile(fsys, filepath.Join(utils.FunctionsDir, "secret.env"))
		require.NoError(t, err)
		assert.Equal(t, "SECRET=1", string(data))

		assert.Empty(t, apitest.ListUnmatchedRequests())
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

func TestGetPartPath(t *testing.T) {
	t.Parallel()

	t.Run("returns path from Supabase header", func(t *testing.T) {
		header := textproto.MIMEHeader{}
		header.Set("Supabase-Path", "dir/file.ts")
		got, err := getPartPath(header)
		require.NoError(t, err)
		assert.Equal(t, "dir/file.ts", got)
	})

	t.Run("returns filename from content disposition", func(t *testing.T) {
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", `form-data; name="file"; filename="test-func/index.ts"`)
		got, err := getPartPath(header)
		require.NoError(t, err)
		assert.Equal(t, "test-func/index.ts", got)
	})

	t.Run("returns filename from editor-originated content disposition", func(t *testing.T) {
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", `form-data; name="file"; filename="source/index.ts"`)
		got, err := getPartPath(header)
		require.NoError(t, err)
		assert.Equal(t, "source/index.ts", got)
	})

	t.Run("writes file of arbitrary depth", func(t *testing.T) {
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", `form-data; name="file"; filename="test-func/dir/subdir/file.ts"`)
		got, err := getPartPath(header)
		require.NoError(t, err)
		assert.Equal(t, "test-func/dir/subdir/file.ts", got)
	})

	t.Run("returns empty when no filename provided", func(t *testing.T) {
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", `form-data; name="file"`)
		got, err := getPartPath(header)
		require.NoError(t, err)
		assert.Equal(t, "", got)
	})

	t.Run("returns error on invalid content disposition", func(t *testing.T) {
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", `form-data; filename="unterminated`)
		got, err := getPartPath(header)
		require.ErrorContains(t, err, "failed to parse content disposition")
		assert.Equal(t, "", got)
	})
}
