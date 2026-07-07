package download

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
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
		var createRequest struct {
			Cmd        []string `json:"Cmd"`
			HostConfig struct {
				Binds []string `json:"Binds"`
			} `json:"HostConfig"`
		}
		gock.New(dockerHost).
			Get("/v" + utils.Docker.ClientVersion() + "/images/" + imageURL + "/json").
			Reply(http.StatusOK).
			JSON(image.InspectResponse{})
		gock.New(dockerHost).
			Post("/v" + utils.Docker.ClientVersion() + "/networks/create").
			Reply(http.StatusCreated).
			JSON(network.CreateResponse{})
		gock.New(dockerHost).
			Post("/v" + utils.Docker.ClientVersion() + "/volumes/create").
			Persist().
			Reply(http.StatusCreated).
			JSON(volume.Volume{})
		gock.New(dockerHost).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/create").
			AddMatcher(func(req *http.Request, ereq *gock.Request) (bool, error) {
				body, err := io.ReadAll(req.Body)
				if err != nil {
					return false, err
				}
				return true, json.Unmarshal(body, &createRequest)
			}).
			Reply(http.StatusOK).
			JSON(container.CreateResponse{ID: containerID})
		gock.New(dockerHost).
			Post("/v" + utils.Docker.ClientVersion() + "/containers/" + containerID + "/start").
			Reply(http.StatusAccepted)
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

		hostFunctionsDirPath, err := filepath.Abs(utils.FunctionsDir)
		require.NoError(t, err)
		hostEszipPath, err := filepath.Abs(eszipPath)
		require.NoError(t, err)
		assert.EqualValues(t, []string{
			"unbundle",
			"--eszip",
			path.Join(utils.DockerEszipDir, filepath.Base(hostEszipPath)),
			"--output",
			path.Join(utils.DockerDenoDir, slugDocker),
		}, createRequest.Cmd)
		assert.Contains(t, createRequest.HostConfig.Binds, utils.EdgeRuntimeId+":/root/.cache/deno:rw")
		assert.Contains(t, createRequest.HostConfig.Binds, hostEszipPath+":"+path.Join(utils.DockerEszipDir, filepath.Base(hostEszipPath))+":ro")
		assert.Contains(t, createRequest.HostConfig.Binds, hostFunctionsDirPath+":"+utils.DockerDenoDir+":rw")
		for _, bind := range createRequest.HostConfig.Binds {
			assert.False(t, strings.Contains(bind, filepath.Join(hostFunctionsDirPath, slugDocker)+":"+utils.DockerDenoDir),
				"docker output should mount supabase/functions, not the slug directory")
		}

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

// TestDownloadAllRejectsMaliciousSlug is a regression test for CLI-1891: the
// per-function loop in downloadAll must reject a path-traversal payload in
// a function's Slug -- as returned by V1ListAllFunctionsWithResponse, which
// this threat model treats as untrusted (a malicious/compromised Management
// API response, or a MITM) -- before handing it to any downloader that
// joins it into a filesystem path.
//
// This mirrors an exploit independently confirmed against downloadOne: with
// slug = "../../../../../poc-escaped-outside-project", downloadOne's
// eszipPath := filepath.Join(utils.TempDir, fmt.Sprintf("output_%s.eszip",
// slug)) resolves (after filepath.Clean) to "../poc-escaped-outside-project.eszip",
// i.e. one directory level above the project root, and
// afero.WriteReader happily MkdirAll's its way there and writes the
// server-controlled response body outside the sandbox.
func TestDownloadAllRejectsMaliciousSlug(t *testing.T) {
	const maliciousSlug = "../../../../../poc-escaped-outside-project"

	// Use a real OS filesystem rooted at an isolated temp directory so an
	// escape can actually be observed landing outside the project root,
	// exactly as in the reviewer's PoC.
	tmpDir := t.TempDir()
	t.Chdir(tmpDir)
	fsys := afero.NewOsFs()
	require.NoError(t, utils.WriteConfig(fsys, false))

	project := apitest.RandomProjectRef()
	token := apitest.RandomAccessToken(t)
	t.Setenv("SUPABASE_ACCESS_TOKEN", string(token))

	utils.CmdSuggestion = ""
	t.Cleanup(func() { utils.CmdSuggestion = "" })

	defer gock.OffAll()
	gock.New(utils.DefaultApiHost).
		Get("/v1/projects/" + project + "/functions").
		Reply(http.StatusOK).
		JSON([]api.FunctionResponse{{
			Id:   "poc-id",
			Name: "poc",
			Slug: maliciousSlug,
		}})
	// Mocked so that, if the fix is removed, the malicious slug's request
	// still succeeds and downloadOne proceeds all the way to writing the
	// escaped file -- proving the escape, rather than masking it behind an
	// unrelated network error. With the fix in place this mock is never hit.
	gock.New(utils.DefaultApiHost).
		Get("/v1/projects/" + project + "/functions/.*/body").
		Reply(http.StatusOK).
		BodyString("fake eszip payload")

	// downloadOne is the exact sink the reviewer's PoC targeted directly;
	// wrap it as a downloader so downloadAll's dispatch is exercised against
	// the real vulnerable code, without also pulling in downloadWithDockerUnbundle's
	// unrelated Docker extraction step (and its defer-cleanup of the eszip
	// file, which would otherwise remove the escaped file before this test
	// can observe it).
	downloaderCalled := false
	downloader := func(ctx context.Context, slug, projectRef string, fsys afero.Fs) error {
		downloaderCalled = true
		_, err := downloadOne(ctx, slug, projectRef, fsys)
		return err
	}

	err := downloadAll(context.Background(), project, fsys, downloader)

	// Check for the escape before any assertion below that could halt the
	// test on failure (e.g. require.Error), so this is verified regardless
	// of whether downloadAll happened to return an error for some other
	// reason. t.TempDir()'s own cleanup RemoveAll's tmpDir's parent, which
	// would otherwise sweep away the evidence once the test returns.
	//
	// The exploit resolves to "../poc-escaped-outside-project.eszip"
	// relative to utils.TempDir, i.e. one level above the project root.
	escapedPath := filepath.Join(tmpDir, "..", "poc-escaped-outside-project.eszip")
	t.Cleanup(func() { _ = os.Remove(escapedPath) })
	exists, existsErr := afero.Exists(fsys, escapedPath)
	require.NoError(t, existsErr)
	assert.False(t, exists, "malicious slug must not be able to write outside the project directory")

	require.Error(t, err)
	assert.ErrorIs(t, err, utils.ErrInvalidSlug)
	assert.Contains(t, utils.CmdSuggestion, "unexpected function slug")
	assert.False(t, downloaderCalled, "downloader must not be invoked with an unvalidated slug")

	assert.Empty(t, apitest.ListUnmatchedRequests())
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

	t.Run("rejects a path traversal payload in Supabase-Path", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))

		utils.CmdSuggestion = ""
		t.Cleanup(func() { utils.CmdSuggestion = "" })

		defer gock.OffAll()
		mockMultipartBody(t, project, slug, bundleMetadata{EntrypointPath: "source/index.ts"}, []multipartPart{
			{filename: "source/index.ts", contents: "console.log('hello')"},
			{filename: "leftover.ts", supabasePath: "../../../../../../etc/passwd", contents: "root:x:0:0::/root:/bin/bash"},
		})

		err := Run(context.Background(), slug, project, false, false, fsys)
		require.Error(t, err)
		assert.ErrorIs(t, err, ErrUnsafeDownloadPath)

		// The generic "invalid path in server response" message on its own
		// gives users nothing actionable, so this must carry a specific
		// suggestion (DX finding on CLI-1891) rather than falling through
		// to the generic --debug suggestion.
		assert.Contains(t, utils.CmdSuggestion, "malformed or unexpected API response")

		// Nothing should have escaped the functions directory.
		exists, err := afero.Exists(fsys, "/etc/passwd")
		require.NoError(t, err)
		assert.False(t, exists, "path traversal payload must not be written outside the functions directory")

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("writes deeply nested legitimate paths", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.WriteConfig(fsys, false))

		defer gock.OffAll()
		mockMultipartBody(t, project, slug, bundleMetadata{EntrypointPath: "source/index.ts"}, []multipartPart{
			{filename: "source/index.ts", contents: "console.log('hello')"},
			{filename: "source/a/b/c/d/deep.ts", contents: "export const deep = true;"},
		})

		err := Run(context.Background(), slug, project, false, false, fsys)
		require.NoError(t, err)

		root := filepath.Join(utils.FunctionsDir, slug)
		data, err := afero.ReadFile(fsys, filepath.Join(root, "index.ts"))
		require.NoError(t, err)
		assert.Equal(t, "console.log('hello')", string(data))

		data, err = afero.ReadFile(fsys, filepath.Join(root, "a", "b", "c", "d", "deep.ts"))
		require.NoError(t, err)
		assert.Equal(t, "export const deep = true;", string(data))

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	t.Run("does not write through a pre-existing symlink at the destination", func(t *testing.T) {
		// Symlink semantics only exist on a real filesystem, so this test
		// exercises afero.NewOsFs against an isolated temp directory rather
		// than the in-memory fs used elsewhere in this file.
		tmpDir := t.TempDir()
		t.Chdir(tmpDir)
		fsys := afero.NewOsFs()
		require.NoError(t, utils.WriteConfig(fsys, false))

		// A file living outside the sandboxed functions directory that must
		// never be touched by the download.
		outsideDir := filepath.Join(tmpDir, "outside")
		require.NoError(t, os.MkdirAll(outsideDir, 0o755))
		secretPath := filepath.Join(outsideDir, "secret.txt")
		require.NoError(t, os.WriteFile(secretPath, []byte("original"), 0o600))

		// Plant a symlink inside the function directory, before the
		// download runs, pointing at the file outside the sandbox. A
		// server response that resolves to this exact path must not be
		// allowed to write through it.
		funcDir := filepath.Join(utils.FunctionsDir, slug)
		require.NoError(t, os.MkdirAll(funcDir, 0o755))
		linkPath := filepath.Join(funcDir, "evil.ts")
		require.NoError(t, os.Symlink(secretPath, linkPath))

		defer gock.OffAll()
		mockMultipartBody(t, project, slug, bundleMetadata{EntrypointPath: "source/index.ts"}, []multipartPart{
			{filename: "source/index.ts", contents: "console.log('hello')"},
			{filename: "source/evil.ts", contents: "overwritten"},
		})

		err := Run(context.Background(), slug, project, false, false, fsys)
		require.NoError(t, err)

		// The symlink target outside the sandbox must be untouched.
		data, err := os.ReadFile(secretPath)
		require.NoError(t, err)
		assert.Equal(t, "original", string(data), "file outside the functions directory must not be modified")

		// The destination itself should now be a plain file with the
		// downloaded contents: the atomic rename replaces the symlink
		// directory entry rather than following it.
		info, err := os.Lstat(linkPath)
		require.NoError(t, err)
		assert.Zero(t, info.Mode()&os.ModeSymlink, "planted symlink should have been replaced, not written through")

		data, err = os.ReadFile(linkPath)
		require.NoError(t, err)
		assert.Equal(t, "overwritten", string(data))

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})

	// Regression test for the DX finding on CLI-1891: ensureNoSymlinkInPath
	// used to reject the mere presence of a symlink anywhere under
	// utils.FunctionsDir, which would also have broken a legitimate
	// monorepo pattern like this one, where a function directory
	// symlinks in a shared directory that itself lives inside the
	// functions tree. That symlink's target still resolves inside root,
	// so it must be allowed end-to-end.
	t.Run("writes through a symlink pointing to a legitimate location inside the functions directory", func(t *testing.T) {
		tmpDir := t.TempDir()
		t.Chdir(tmpDir)
		fsys := afero.NewOsFs()
		require.NoError(t, utils.WriteConfig(fsys, false))

		sharedDir := filepath.Join(utils.FunctionsDir, "_shared")
		require.NoError(t, os.MkdirAll(sharedDir, 0o755))
		// os.Symlink resolves a relative target against the symlink's own
		// containing directory, not the process cwd, so the target must be
		// made absolute here for the link to actually point at sharedDir.
		absSharedDir, err := filepath.Abs(sharedDir)
		require.NoError(t, err)

		funcDir := filepath.Join(utils.FunctionsDir, slug)
		require.NoError(t, os.MkdirAll(funcDir, 0o755))
		require.NoError(t, os.Symlink(absSharedDir, filepath.Join(funcDir, "_shared")))

		defer gock.OffAll()
		mockMultipartBody(t, project, slug, bundleMetadata{EntrypointPath: "source/index.ts"}, []multipartPart{
			{filename: "source/index.ts", contents: "console.log('hello')"},
			{filename: "source/_shared/util.ts", contents: "export const util = 2;"},
		})

		err = Run(context.Background(), slug, project, false, false, fsys)
		require.NoError(t, err)

		data, err := afero.ReadFile(fsys, filepath.Join(funcDir, "index.ts"))
		require.NoError(t, err)
		assert.Equal(t, "console.log('hello')", string(data))

		// The write landed through the symlink, in the real shared
		// directory rather than being rejected.
		data, err = os.ReadFile(filepath.Join(sharedDir, "util.ts"))
		require.NoError(t, err)
		assert.Equal(t, "export const util = 2;", string(data))

		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

// TestEnsureNoSymlinkInPath exercises ensureNoSymlinkInPath's resolve-then-check
// policy directly: it must still reject a symlink whose target escapes root,
// but must now allow one whose target resolves to a legitimate, even deeply
// nested, location that is still inside root.
func TestEnsureNoSymlinkInPath(t *testing.T) {
	t.Run("rejects a symlink whose target resolves outside root", func(t *testing.T) {
		tmpDir := t.TempDir()
		fsys := afero.NewOsFs()

		root := filepath.Join(tmpDir, "supabase", "functions")
		require.NoError(t, os.MkdirAll(root, 0o755))

		outsideDir := filepath.Join(tmpDir, "outside")
		require.NoError(t, os.MkdirAll(outsideDir, 0o755))

		// Plant a symlink inside root whose target lives outside it
		// entirely -- the actual attack this check defends against.
		linkDir := filepath.Join(root, "escape")
		require.NoError(t, os.Symlink(outsideDir, linkDir))

		dir := filepath.Join(linkDir, "nested")
		err := ensureNoSymlinkInPath(fsys, root, dir)
		require.Error(t, err)
		assert.ErrorIs(t, err, ErrUnsafeDownloadPath)
	})

	t.Run("allows a symlink whose target resolves to a nested location inside root", func(t *testing.T) {
		tmpDir := t.TempDir()
		fsys := afero.NewOsFs()

		root := filepath.Join(tmpDir, "supabase", "functions")
		require.NoError(t, os.MkdirAll(root, 0o755))

		// A legitimate monorepo-style symlink: a shared directory that
		// lives elsewhere inside the functions tree, symlinked into place
		// from a function's own directory.
		sharedDir := filepath.Join(root, "_shared")
		require.NoError(t, os.MkdirAll(sharedDir, 0o755))

		funcDir := filepath.Join(root, "my-func")
		require.NoError(t, os.MkdirAll(funcDir, 0o755))
		linkDir := filepath.Join(funcDir, "_shared")
		require.NoError(t, os.Symlink(sharedDir, linkDir))

		// dir itself does not exist yet -- ensureNoSymlinkInPath is called
		// before MkdirIfNotExistFS creates it -- so this also proves the
		// still-nonexistent remainder is correctly re-joined onto the
		// resolved ancestor.
		dir := filepath.Join(linkDir, "nested", "deeper")
		err := ensureNoSymlinkInPath(fsys, root, dir)
		assert.NoError(t, err, "a symlink resolving to a legitimate location inside root must be allowed")
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
