package login

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"strconv"
	"strings"
	"time"

	"github.com/cenkalti/backoff/v4"
	"github.com/go-errors/errors"
	"github.com/google/uuid"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/fetcher"
)

type RunParams struct {
	Token       string
	TokenName   string
	OpenBrowser bool
	SessionId   string
	Encryption  LoginEncryptor
	Fsys        afero.Fs
}

type AccessTokenResponse struct {
	SessionId   string `json:"id"`
	CreatedAt   string `json:"created_at"`
	AccessToken string `json:"access_token"`
	PublicKey   string `json:"public_key"`
	Nonce       string `json:"nonce"`
}

const defaultRetryAfterSeconds = 2
const defaultMaxRetries = 90
const decryptionErrorMsg = "cannot decrypt access token"

var loggedInMsg = "You are now logged in. " + utils.Aqua("Happy coding!")

type LoginEncryptor interface {
	encodedPublicKey() string
	decryptAccessToken(accessToken string, publicKey string, nonce string) (string, error)
}

type LoginEncryption struct {
	curve      ecdh.Curve
	privateKey *ecdh.PrivateKey
	publicKey  *ecdh.PublicKey
}

func NewLoginEncryption() (LoginEncryption, error) {
	enc := LoginEncryption{}
	err := enc.generateKeys()
	if err != nil {
		return enc, errors.Errorf("cannot generate crypto keys: %w", err)
	}
	return enc, nil
}

func (enc *LoginEncryption) generateKeys() error {
	enc.curve = ecdh.P256()
	privateKey, err := enc.curve.GenerateKey(rand.Reader)
	if err != nil {
		return errors.Errorf("cannot generate encryption key: %w", err)
	}
	enc.privateKey = privateKey
	enc.publicKey = privateKey.PublicKey()
	return nil
}

func (enc LoginEncryption) encodedPublicKey() string {
	return hex.EncodeToString(enc.publicKey.Bytes())
}

func (enc LoginEncryption) decryptAccessToken(accessToken string, publicKey string, nonce string) (string, error) {
	decodedAccessToken, err := hex.DecodeString(accessToken)
	if err != nil {
		return "", errors.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	decodedNonce, err := hex.DecodeString(nonce)
	if err != nil {
		return "", errors.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	decodedPublicKey, err := hex.DecodeString(publicKey)
	if err != nil {
		return "", errors.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	remotePublicKey, err := enc.curve.NewPublicKey(decodedPublicKey)
	if err != nil {
		return "", errors.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	secret, err := enc.privateKey.ECDH(remotePublicKey)
	if err != nil {
		return "", errors.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	block, err := aes.NewCipher(secret)
	if err != nil {
		return "", errors.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", errors.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	decryptedAccessToken, err := aesgcm.Open(nil, decodedNonce, decodedAccessToken, nil)
	if err != nil {
		return "", errors.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	return string(decryptedAccessToken), nil
}

func pollForAccessToken(ctx context.Context, url string) (AccessTokenResponse, error) {
	// TODO: Move to OpenAPI-generated http client once we reach v1 on API schema.
	client := fetcher.NewFetcher(
		utils.GetSupabaseAPIHost(),
		fetcher.WithHTTPClient(&http.Client{
			Timeout: 10 * time.Second,
		}),
		fetcher.WithExpectedStatus(http.StatusOK),
	)
	timeout := backoff.NewConstantBackOff(defaultRetryAfterSeconds)
	probe := func() (AccessTokenResponse, error) {
		resp, err := client.Send(ctx, http.MethodGet, url, nil)
		if err == nil {
			return fetcher.ParseJSON[AccessTokenResponse](resp.Body)
		} else if resp != nil {
			if retryAfterSeconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil {
				timeout.Interval = time.Duration(retryAfterSeconds) * time.Second
			}
		}
		return AccessTokenResponse{}, err
	}
	policy := backoff.WithContext(backoff.WithMaxRetries(timeout, defaultMaxRetries), ctx)
	return backoff.RetryWithData(probe, policy)
}

func Run(ctx context.Context, stdout io.Writer, params RunParams) error {
	if params.Token != "" {
		if err := utils.SaveAccessToken(params.Token, params.Fsys); err != nil {
			return errors.Errorf("cannot save provided token: %w", err)
		}
		fmt.Println(loggedInMsg)
		return nil
	}

	// Initialise login encryption and Session ID for end-to-end communication.
	if params.Encryption == nil {
		var err error
		if params.Encryption, err = NewLoginEncryption(); err != nil {
			return err
		}
		params.SessionId = uuid.New().String()
	}

	// Initialise default token name
	if params.TokenName == "" {
		params.TokenName = generateTokenNameWithFallback()
	}

	encodedPublicKey := params.Encryption.encodedPublicKey()
	createLoginSessionPath := "/cli/login"
	createLoginSessionQuery := "?session_id=" + params.SessionId + "&token_name=" + params.TokenName + "&public_key=" + encodedPublicKey
	createLoginSessionUrl := utils.GetSupabaseDashboardURL() + createLoginSessionPath + createLoginSessionQuery

	if params.OpenBrowser {
		fmt.Fprintf(stdout, "Hello from %s! Press %s to open browser and login automatically.\n", utils.Aqua("Supabase"), utils.Aqua("Enter"))
		if _, err := fmt.Scanln(); err != nil {
			return errors.Errorf("failed to scan line: %w", err)
		}
		fmt.Fprintf(stdout, "Here is your login link in case browser did not open %s\n\n", utils.Bold(createLoginSessionUrl))
		if err := RunOpenCmd(ctx, createLoginSessionUrl); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	} else {
		fmt.Fprintf(stdout, "Here is your login link, open it in the browser %s\n\n", utils.Bold(createLoginSessionUrl))
	}

	if err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		p.Send(utils.StatusMsg("Your token is now being generated and securely encrypted. Waiting for it to arrive..."))

		sessionPollingUrl := "/platform/cli/login/" + params.SessionId
		accessTokenResponse, err := pollForAccessToken(ctx, sessionPollingUrl)
		if err != nil {
			return err
		}

		decryptedAccessToken, err := params.Encryption.decryptAccessToken(accessTokenResponse.AccessToken, accessTokenResponse.PublicKey, accessTokenResponse.Nonce)
		if err != nil {
			return err
		}

		return utils.SaveAccessToken(decryptedAccessToken, params.Fsys)
	}); err != nil {
		return err
	}

	fmt.Fprintf(stdout, "Token %s created successfully.\n\n", utils.Bold(params.TokenName))
	fmt.Fprintln(stdout, loggedInMsg)

	return nil
}

func ParseAccessToken(stdin afero.File) string {
	// Not using viper so we can reset env easily in tests
	token := os.Getenv("SUPABASE_ACCESS_TOKEN")
	if len(token) == 0 {
		var buf bytes.Buffer
		if err := new.CopyStdinIfExists(stdin, &buf); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
		token = strings.TrimSpace(buf.String())
	}
	return token
}

func generateTokenName() (string, error) {
	user, err := user.Current()
	if err != nil {
		return "", errors.Errorf("cannot retrieve username: %w", err)
	}

	hostname, err := os.Hostname()
	if err != nil {
		return "", errors.Errorf("cannot retrieve hostname: %w", err)
	}

	return fmt.Sprintf("cli_%s@%s_%d", user.Username, hostname, time.Now().Unix()), nil
}

func generateTokenNameWithFallback() string {
	name, err := generateTokenName()
	if err != nil {
		logger := utils.GetDebugLogger()
		fmt.Fprintln(logger, err)
		name = fmt.Sprintf("cli_%d", time.Now().Unix())
	}
	return name
}
