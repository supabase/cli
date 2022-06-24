package integration

import (
	"os"

	"github.com/stretchr/testify/require"
)

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
