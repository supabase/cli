package deploy

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"gopkg.in/h2non/gock.v1"
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

func TestDeployCommand(t *testing.T) {
	t.Run("deploys new function (legacy bundle)", func(t *testing.T) {
		const slug = "test-func"
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
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound)
		gock.New("https://api.supabase.io").
			Post("/v1/projects/" + project + "/functions").
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})
		// Run test
		noVerifyJWT := true
		assert.NoError(t, Run(context.Background(), slug, project, &noVerifyJWT, true, "", fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("deploys new function (ESZIP)", func(t *testing.T) {
		const slug = "test-func"
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
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound)
		gock.New("https://api.supabase.io").
			Post("/v1/projects/" + project + "/functions").
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})
		// Run test
		noVerifyJWT := true
		assert.NoError(t, Run(context.Background(), slug, project, &noVerifyJWT, false, "", fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("updates deployed function (legacy bundle)", func(t *testing.T) {
		const slug = "test-func"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644))
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err := fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New("https://api.supabase.io").
			Patch("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		// Run test
		assert.NoError(t, Run(context.Background(), slug, "", nil, true, "", fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("updates deployed function (ESZIP)", func(t *testing.T) {
		const slug = "test-func"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte(project), 0644))
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err := fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New("https://api.supabase.io").
			Patch("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		// Run test
		assert.NoError(t, Run(context.Background(), slug, "", nil, false, "", fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on malformed ref", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup invalid project ref
		require.NoError(t, afero.WriteFile(fsys, utils.ProjectRefPath, []byte("test-project"), 0644))
		// Run test
		noVerifyJWT := true
		err := Run(context.Background(), "test-func", "", &noVerifyJWT, true, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "Invalid project ref format.")
	})

	t.Run("throws error on malformed ref arg", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		noVerifyJWT := true
		err := Run(context.Background(), "test-func", "test-project", &noVerifyJWT, true, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "Invalid project ref format.")
	})

	t.Run("throws error on malformed slug", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Run test
		noVerifyJWT := true
		err := Run(context.Background(), "@", project, &noVerifyJWT, true, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "Invalid Function name.")
	})

	t.Run("throws error on failure to install deno", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Run test
		noVerifyJWT := true
		err := Run(context.Background(), "test-func", project, &noVerifyJWT, true, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "operation not permitted")
	})

	t.Run("throws error on bundle failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup deno error
		t.Setenv("TEST_DENO_ERROR", "bundle failed")
		var body bytes.Buffer
		archive := zip.NewWriter(&body)
		w, err := archive.Create("deno")
		require.NoError(t, err)
		_, err = w.Write([]byte("binary"))
		require.NoError(t, err)
		require.NoError(t, archive.Close())
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://github.com").
			Get("/denoland/deno/releases/download/v" + utils.DenoVersion).
			Reply(http.StatusOK).
			Body(&body)
		// Run test
		noVerifyJWT := true
		err = Run(context.Background(), "test-func", project, &noVerifyJWT, true, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "Error bundling function: exit status 1\nbundle failed\n")
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("throws error on ESZIP failure", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup deno error
		t.Setenv("TEST_DENO_ERROR", "eszip failed")
		var body bytes.Buffer
		archive := zip.NewWriter(&body)
		w, err := archive.Create("deno")
		require.NoError(t, err)
		_, err = w.Write([]byte("binary"))
		require.NoError(t, err)
		require.NoError(t, archive.Close())
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://github.com").
			Get("/denoland/deno/releases/download/v" + utils.DenoVersion).
			Reply(http.StatusOK).
			Body(&body)

		noVerifyJWT := true
		err = Run(context.Background(), "test-func", project, &noVerifyJWT, false, "", fsys)
		// Check error
		assert.ErrorContains(t, err, "Error bundling function: exit status 1\neszip failed\n")
	})

	t.Run("verify_jwt param falls back to config", func(t *testing.T) {
		const slug = "test-func"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		f, err := fsys.OpenFile("supabase/config.toml", os.O_APPEND|os.O_WRONLY, 0600)
		require.NoError(t, err)
		_, err = f.WriteString(`
[functions.` + slug + `]
verify_jwt = false
`)
		require.NoError(t, err)
		require.NoError(t, f.Close())
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err = fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound)
		gock.New("https://api.supabase.io").
			Post("/v1/projects/" + project + "/functions").
			AddMatcher(func(req *http.Request, ereq *gock.Request) (bool, error) {
				body, err := io.ReadAll(req.Body)
				if err != nil {
					return false, err
				}

				var bodyJson map[string]interface{}
				err = json.Unmarshal(body, &bodyJson)
				if err != nil {
					return false, err
				}

				return bodyJson["verify_jwt"] == false, nil
			}).
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})
		// Run test
		assert.NoError(t, Run(context.Background(), slug, project, nil, true, "", fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("verify_jwt flag overrides config", func(t *testing.T) {
		const slug = "test-func"
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))
		f, err := fsys.OpenFile("supabase/config.toml", os.O_APPEND|os.O_WRONLY, 0600)
		require.NoError(t, err)
		_, err = f.WriteString(`
[functions.` + slug + `]
verify_jwt = false
`)
		require.NoError(t, err)
		require.NoError(t, f.Close())
		// Setup valid project ref
		project := apitest.RandomProjectRef()
		// Setup valid access token
		token := apitest.RandomAccessToken(t)
		t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))
		// Setup valid deno path
		_, err = fsys.Create(utils.DenoPathOverride)
		require.NoError(t, err)
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound)
		gock.New("https://api.supabase.io").
			Post("/v1/projects/" + project + "/functions").
			AddMatcher(func(req *http.Request, ereq *gock.Request) (bool, error) {
				body, err := io.ReadAll(req.Body)
				if err != nil {
					return false, err
				}

				var bodyJson map[string]interface{}
				err = json.Unmarshal(body, &bodyJson)
				if err != nil {
					return false, err
				}

				return bodyJson["verify_jwt"] == true, nil
			}).
			Reply(http.StatusCreated).
			JSON(api.FunctionResponse{Id: "1"})
		// Run test
		noVerifyJwt := false
		assert.NoError(t, Run(context.Background(), slug, project, &noVerifyJwt, true, "", fsys))
		// Validate api
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestDeployFunction(t *testing.T) {
	const slug = "test-func"
	// Setup valid project ref
	project := apitest.RandomProjectRef()
	// Setup valid access token
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	t.Run("throws error on network failure", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/" + slug).
			ReplyError(errors.New("network error"))
		// Run test
		err := deployFunction(context.Background(), project, slug, strings.NewReader("body"), true, true)
		// Check error
		assert.ErrorContains(t, err, "network error")
	})

	t.Run("throws error on service unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := deployFunction(context.Background(), project, slug, strings.NewReader("body"), true, true)
		// Check error
		assert.ErrorContains(t, err, "Unexpected error deploying Function:")
	})

	t.Run("throws error on create failure", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound)
		gock.New("https://api.supabase.io").
			Post("/v1/projects/" + project + "/functions").
			ReplyError(errors.New("network error"))
		// Run test
		err := deployFunction(context.Background(), project, slug, strings.NewReader("body"), true, true)
		// Check error
		assert.ErrorContains(t, err, "network error")
	})

	t.Run("throws error on create unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusNotFound)
		gock.New("https://api.supabase.io").
			Post("/v1/projects/" + project + "/functions").
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := deployFunction(context.Background(), project, slug, strings.NewReader("body"), true, true)
		// Check error
		assert.ErrorContains(t, err, "Failed to create a new Function on the Supabase project:")
	})

	t.Run("throws error on update failure", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New("https://api.supabase.io").
			Patch("/v1/projects/" + project + "/functions/" + slug).
			ReplyError(errors.New("network error"))
		// Run test
		err := deployFunction(context.Background(), project, slug, strings.NewReader("body"), true, true)
		// Check error
		assert.ErrorContains(t, err, "network error")
	})

	t.Run("throws error on update unavailable", func(t *testing.T) {
		// Setup mock api
		defer gock.OffAll()
		gock.New("https://api.supabase.io").
			Get("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusOK).
			JSON(api.FunctionResponse{Id: "1"})
		gock.New("https://api.supabase.io").
			Patch("/v1/projects/" + project + "/functions/" + slug).
			Reply(http.StatusServiceUnavailable)
		// Run test
		err := deployFunction(context.Background(), project, slug, strings.NewReader("body"), true, true)
		// Check error
		assert.ErrorContains(t, err, "Failed to update an existing Function's body on the Supabase project:")
	})
}
