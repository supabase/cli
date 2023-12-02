package login

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/zalando/go-keyring"
	"gopkg.in/h2non/gock.v1"
)

type MockEncryption struct {
	token     string
	publicKey string
}

func (enc *MockEncryption) encodedPublicKey() string {
	return enc.publicKey
}

func (enc *MockEncryption) decryptAccessToken(accessToken string, publicKey string, nonce string) (string, error) {
	return enc.token, nil
}

func TestLoginCommand(t *testing.T) {
	keyring.MockInit()

	t.Run("accepts --token flag and validates provided value", func(t *testing.T) {
		token := string(apitest.RandomAccessToken(t))
		assert.NoError(t, Run(context.Background(), os.Stdout, RunParams{
			Token: token,
			Fsys:  afero.NewMemMapFs(),
		}))
		saved, err := credentials.Get(utils.AccessTokenKey)
		assert.NoError(t, err)
		assert.Equal(t, saved, token)
	})

	t.Run("goes through automated flow successfully", func(t *testing.T) {
		r, w, err := os.Pipe()
		require.NoError(t, err)

		sessionId := "random_session_id"
		token := string(apitest.RandomAccessToken(t))
		tokenName := "random_token_name"
		publicKey := "random_public_key"

		defer gock.OffAll()

		gock.New(utils.GetSupabaseAPIHost()).
			Get("/platform/cli/login/" + sessionId).
			Reply(200).
			JSON(map[string]any{
				"id":           "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
				"created_at":   "2023-03-28T13:50:14.464Z",
				"access_token": "picklerick",
				"public_key":   "iddqd",
				"nonce":        "idkfa",
			})

		enc := &MockEncryption{publicKey: publicKey, token: token}
		runParams := RunParams{
			TokenName:  tokenName,
			SessionId:  sessionId,
			Fsys:       afero.NewMemMapFs(),
			Encryption: enc,
		}
		assert.NoError(t, Run(context.Background(), w, runParams))
		w.Close()

		var out bytes.Buffer
		_, _ = io.Copy(&out, r)

		expectedBrowserUrl := fmt.Sprintf("%s/cli/login?session_id=%s&token_name=%s&public_key=%s", utils.GetSupabaseDashboardURL(), sessionId, tokenName, publicKey)
		assert.Contains(t, out.String(), expectedBrowserUrl)

		saved, err := credentials.Get(utils.AccessTokenKey)
		assert.NoError(t, err)
		assert.Equal(t, saved, token)
	})
}
