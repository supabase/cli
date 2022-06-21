package integration

// Basic imports
import (
	"io/ioutil"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
	gonanoid "github.com/matoous/go-nanoid/v2"
	"github.com/spf13/cobra"
	"github.com/stretchr/testify/require"
	"github.com/stretchr/testify/suite"
	clicmd "github.com/supabase/cli/cmd"
	"github.com/supabase/cli/integration/mocks/docker"
)

type DBTestSuite struct {
	suite.Suite
	cmd    *cobra.Command
	ids    []string
	bodies []string
	params []gin.Params
	mtx    sync.RWMutex
}

// test functions
func (suite *DBTestSuite) TestBranchCreate() {
	// create branch
	branch := "test-branch"
	create, args, err := suite.cmd.Traverse([]string{"db", "branch", "create", branch})
	if err != nil {
		suite.Fail("failed to find create command")
	}
	err = create.RunE(create, args)
	if err != nil {
		suite.Fail("failed to create branch", err)
	}

	// check if branch dir exists
	_, err = os.Stat("supabase/.branches/" + branch)
	require.NoError(suite.T(), err)

	// check if all exec calls were made to docker api
	ids := suite.constructParams()
	require.ElementsMatch(suite.T(), suite.params, ids)

	// check commands in exec calls
	require.ElementsMatch(suite.T(), suite.bodies, []string{
		"{\"User\":\"\",\"Privileged\":false,\"Tty\":false,\"AttachStdin\":false,\"AttachStderr\":true,\"AttachStdout\":true,\"Detach\":false,\"DetachKeys\":\"\",\"Env\":null,\"WorkingDir\":\"\",\"Cmd\":[\"pg_dump\",\"postgresql://postgres:postgres@localhost/postgres\"]}\n",
		"{\"Detach\":false,\"Tty\":false}\n",
		"{\"User\":\"\",\"Privileged\":false,\"Tty\":false,\"AttachStdin\":false,\"AttachStderr\":true,\"AttachStdout\":true,\"Detach\":false,\"DetachKeys\":\"\",\"Env\":null,\"WorkingDir\":\"\",\"Cmd\":[\"sh\",\"-c\",\"psql --set ON_ERROR_STOP=on postgresql://postgres:postgres@localhost/postgres \\u003c\\u003c'EOSQL'\\nCREATE DATABASE \\\"" + branch + "\\\";\\n\\\\connect " + branch + "\\nBEGIN;\\nexit code 0\\nCOMMIT;\\nEOSQL\\n\"]}\n",
		"{\"Detach\":false,\"Tty\":false}\n",
	})
}

// hooks
func (suite *DBTestSuite) SetupTest() {
	suite.mtx.Lock()
	suite.ids = []string{}
	suite.bodies = []string{}
	suite.params = []gin.Params{}
	suite.mtx.Unlock()

	// add docker mock handlers
	DockerMock.ExecCreateHandler = func(c *gin.Context) {
		suite.addParams(c.Copy())
		body, err := ioutil.ReadAll(c.Request.Body)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"message": "error reading body",
			})
			return
		}
		suite.addBody(c, body)

		id := gonanoid.MustGenerate(docker.IDAlphabet, docker.IDLength)
		c.JSON(http.StatusCreated, gin.H{
			"Id": id,
		})
		suite.addID(c, id)
	}

	DockerMock.ExecStartHandler = func(c *gin.Context) {
		suite.addParams(c.Copy())
		body, err := ioutil.ReadAll(c.Request.Body)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"message": "error reading body",
			})
			return
		}
		suite.addBody(c, body)

		docker.HijackedResponse(c, "0")
	}

	DockerMock.ContainerInspectHandler = func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{})
	}

	// create supabase dir
	suite.cmd = clicmd.NewRootCmd()
	init, _, err := suite.cmd.Find([]string{"init"})
	if err != nil {
		suite.Fail("failed to find init command")
	}
	err = init.RunE(init, []string{})
	if err != nil {
		suite.Fail("failed to init supabase cli")
	}

	err = os.Mkdir("supabase/.branches", os.FileMode(0755))
	if err != nil {
		suite.Fail("failed to create supabase/.branches directory")
	}
}

// In order for 'go test' to run this suite, we need to create
// a normal test function and pass our suite to suite.Run
func TestDbTestSuite(t *testing.T) {
	suite.Run(t, new(DBTestSuite))
}

// helper functions
func (suite *DBTestSuite) addParams(c *gin.Context) {
	suite.mtx.Lock()
	defer suite.mtx.Unlock()
	suite.params = append(suite.params, c.Params)
}

func (suite *DBTestSuite) addBody(c *gin.Context, body []byte) {
	suite.mtx.Lock()
	defer suite.mtx.Unlock()
	suite.bodies = append(suite.bodies, string(body))
}

func (suite *DBTestSuite) addID(c *gin.Context, id string) {
	suite.mtx.Lock()
	defer suite.mtx.Unlock()
	suite.ids = append(suite.ids, id)
}

func (suite *DBTestSuite) constructParams() []gin.Params {
	ids := []gin.Params{}
	// for each exec docker call we have to calls to docker api:
	// one to create exec, one to start exec
	for _, id := range suite.ids {
		// this one represents call to create exec
		ids = append(ids, gin.Params{
			gin.Param{
				Key:   "id",
				Value: "supabase_db_" + filepath.Base(TempDir),
			},
		})

		// this one represents call to start exec
		ids = append(ids, gin.Params{
			gin.Param{
				Key:   "id",
				Value: id,
			},
		})
	}
	return ids
}
