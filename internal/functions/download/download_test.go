package download

import (
	"context"
	"errors"
	"fmt"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
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
		err = Run(context.Background(), slug, project, true, false, false, fsys)
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
		err := Run(context.Background(), "@", project, true, false, false, fsys)
		// Check error
		assert.ErrorContains(t, err, "Invalid Function name.")
	})

	t.Run("throws error on failure to install deno", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Run test
		err := Run(context.Background(), slug, project, true, false, false, fsys)
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
		err = Run(context.Background(), slug, project, true, false, false, afero.NewReadOnlyFs(fsys))
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
		err = Run(context.Background(), slug, project, true, false, false, fsys)
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

func TestNormalizeRelativePath(t *testing.T) {
	t.Parallel()

	t.Run("returns cleaned relative path", func(t *testing.T) {
		got := normalizeRelativePath("test-func", "src/index.ts")
		assert.Equal(t, filepath.Join("src", "index.ts"), got)
	})

	t.Run("strips slug prefix", func(t *testing.T) {
		got := normalizeRelativePath("test-func", "test-func/index.ts")
		assert.Equal(t, "index.ts", got)
	})

	t.Run("strips source prefix", func(t *testing.T) {
		got := normalizeRelativePath("test-func", "source/index.ts")
		assert.Equal(t, "index.ts", got)
	})

	t.Run("skips slug directory itself", func(t *testing.T) {
		got := normalizeRelativePath("test-func", "test-func")
		assert.Equal(t, "", got)
	})
}

func TestResolvedPartPath(t *testing.T) {
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
		got, err := resolvedPartPath("test-func", part)
		require.NoError(t, err)
		assert.Equal(t, filepath.Join("dir", "file.ts"), got)
	})

	t.Run("returns filename from content disposition", func(t *testing.T) {
		part := newPart(map[string]string{
			"Content-Disposition": `form-data; name="file"; filename="test-func/index.ts"`,
		})
		got, err := resolvedPartPath("test-func", part)
		require.NoError(t, err)
		assert.Equal(t, "index.ts", got)
	})

	t.Run("returns filename from editor-originated content disposition", func(t *testing.T) {
		part := newPart(map[string]string{
			"Content-Disposition": `form-data; name="file"; filename="source/index.ts"`,
		})
		got, err := resolvedPartPath("test-func", part)
		require.NoError(t, err)
		assert.Equal(t, "index.ts", got)
	})

	t.Run("writes file of arbitrary depth to slug directory", func(t *testing.T) {
		part := newPart(map[string]string{
			"Content-Disposition": `form-data; name="file"; filename="test-func/dir/subdir/file.ts"`,
		})
		got, err := resolvedPartPath("test-func", part)
		require.NoError(t, err)
		assert.Equal(t, filepath.Join("dir", "subdir", "file.ts"), got)
	})

	t.Run("returns empty when no filename provided", func(t *testing.T) {
		part := newPart(map[string]string{
			"Content-Disposition": `form-data; name="file"`,
		})
		got, err := resolvedPartPath("test-func", part)
		require.NoError(t, err)
		assert.Equal(t, "", got)
	})

	t.Run("returns error on invalid content disposition", func(t *testing.T) {
		part := newPart(map[string]string{
			"Content-Disposition": `form-data; filename="unterminated`,
		})
		got, err := resolvedPartPath("test-func", part)
		require.ErrorContains(t, err, "failed to parse content disposition")
		assert.Equal(t, "", got)
	})
}

func TestJoinWithinDir(t *testing.T) {
	t.Parallel()

	base := filepath.Join(os.TempDir(), "base-dir")

	t.Run("joins path within base directory", func(t *testing.T) {
		got, err := joinWithinDir(base, filepath.Join("sub", "file.ts"))
		require.NoError(t, err)
		assert.True(t, strings.HasPrefix(filepath.Clean(got), filepath.Clean(base)+"/") || filepath.Clean(got) == filepath.Clean(base))
	})

	t.Run("treats leading slash as relative to base", func(t *testing.T) {
		got, err := joinWithinDir(base, "/foo/bar.ts")
		require.NoError(t, err)
		assert.True(t, strings.HasPrefix(filepath.Clean(got), filepath.Clean(base)+"/"))
		assert.Equal(t, filepath.Join(filepath.Clean(base), "foo", "bar.ts"), filepath.Clean(got))
	})

	t.Run("rejects absolute path", func(t *testing.T) {
		abs := "/" + filepath.Join("etc", "passwd")
		got, err := joinWithinDir(base, abs)
		require.NoError(t, err)
		assert.True(t, strings.HasPrefix(filepath.Clean(got), filepath.Clean(base)+"/"))
	})

	t.Run("rejects parent directory traversal", func(t *testing.T) {
		got, err := joinWithinDir(base, filepath.Join("..", "escape"))
		require.Error(t, err)
		assert.Equal(t, "", got)
	})

	t.Run("accepts traversal within base directory", func(t *testing.T) {
		base = os.TempDir()
		got, err := joinWithinDir(base, filepath.Join("some", "..", "file.ts"))
		require.NoError(t, err)
		assert.Equal(t, filepath.Join(base, "file.ts"), got)
	})
}
