package login

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
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
		return enc, fmt.Errorf("cannot generate crypto keys: %w", err)
	}
	return enc, nil
}

func (enc *LoginEncryption) generateKeys() error {
	enc.curve = ecdh.P256()
	privateKey, err := enc.curve.GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("cannot generate encryption key: %w", err)
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
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	decodedNonce, err := hex.DecodeString(nonce)
	if err != nil {
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	decodedPublicKey, err := hex.DecodeString(publicKey)
	if err != nil {
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	remotePublicKey, err := enc.curve.NewPublicKey(decodedPublicKey)
	if err != nil {
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	secret, err := enc.privateKey.ECDH(remotePublicKey)
	if err != nil {
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	block, err := aes.NewCipher(secret)
	if err != nil {
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	decryptedAccessToken, err := aesgcm.Open(nil, decodedNonce, decodedAccessToken, nil)
	if err != nil {
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	return string(decryptedAccessToken), nil
}

func pollForAccessToken(ctx context.Context, url string) (AccessTokenResponse, error) {
	var accessTokenResponse AccessTokenResponse

	// TODO: Move to OpenAPI-generated http client once we reach v1 on API schema.
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return accessTokenResponse, fmt.Errorf("cannot fetch access token: %w", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return accessTokenResponse, fmt.Errorf("cannot fetch access token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		retryAfterSeconds, err := strconv.Atoi(resp.Header.Get("Retry-After"))
		if err != nil {
			retryAfterSeconds = defaultRetryAfterSeconds
		}
		t := time.NewTimer(time.Duration(retryAfterSeconds) * time.Second)
		select {
		case <-ctx.Done():
			t.Stop()
		case <-t.C:
		}
		return pollForAccessToken(ctx, url)
	}

	if resp.StatusCode == http.StatusOK {
		body, err := io.ReadAll(resp.Body)

		if err != nil {
			return accessTokenResponse, fmt.Errorf("cannot read access token response body: %w", err)
		}

		if err := json.Unmarshal(body, &accessTokenResponse); err != nil {
			return accessTokenResponse, fmt.Errorf("cannot unmarshal access token response: %w", err)
		}

		return accessTokenResponse, nil
	}

	return accessTokenResponse, fmt.Errorf("HTTP %s: cannot retrieve access token", resp.Status)
}

func Run(ctx context.Context, stdout *os.File, params RunParams) error {
	if params.Token != "" {
		err := utils.SaveAccessToken(params.Token, params.Fsys)
		if err != nil {
			return fmt.Errorf("cannot save provided token: %w", err)
		}
		fmt.Println(loggedInMsg)
		return nil
	}

	if params.OpenBrowser {
		fmt.Fprint(stdout, "Hello from ", utils.Aqua("Supabase"), "! Press ", utils.Aqua("Enter"), " to open browser and login automatically.\n")
		fmt.Scanln()
	}

	tokenName := params.TokenName
	encodedPublicKey := params.Encryption.encodedPublicKey()

	createLoginSessionPath := "/cli/login"
	createLoginSessionQuery := "?session_id=" + params.SessionId + "&token_name=" + tokenName + "&public_key=" + encodedPublicKey
	createLoginSessionUrl := utils.GetSupabaseDashboardURL() + createLoginSessionPath + createLoginSessionQuery

	if params.OpenBrowser {
		fmt.Fprintf(stdout, "Here is your login link in case browser did not open %s\n\n", utils.Bold(createLoginSessionUrl))

		openCmd := exec.CommandContext(ctx, "open", createLoginSessionUrl)
		if err := openCmd.Run(); err != nil {
			return fmt.Errorf("cannot open default browser: %w", err)
		}
	} else {
		fmt.Fprintf(stdout, "Here is your login link, open it in the browser %s\n\n", utils.Bold(createLoginSessionUrl))
	}

	err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		p.Send(utils.StatusMsg("Your token is now being generated and securely encrypted. Waiting for it to arrive..."))

		sessionPollingUrl := utils.GetSupabaseAPIHost() + "/platform/cli/login/" + params.SessionId
		accessTokenResponse, err := pollForAccessToken(ctx, sessionPollingUrl)
		if err != nil {
			return err
		}

		decryptedAccessToken, err := params.Encryption.decryptAccessToken(accessTokenResponse.AccessToken, accessTokenResponse.PublicKey, accessTokenResponse.Nonce)
		if err != nil {
			return err
		}

		return utils.SaveAccessToken(decryptedAccessToken, params.Fsys)
	})

	if err != nil {
		return err
	}

	fmt.Fprintf(stdout, "Token %s created successfully.\n\n", utils.Bold(tokenName))
	fmt.Fprintln(stdout, loggedInMsg)

	return nil
}

func PromptAccessToken(stdin *os.File) string {
	fmt.Fprintf(os.Stderr, `You can generate an access token from %s/account/tokens
Enter your access token: `, utils.GetSupabaseDashboardURL())
	input := credentials.PromptMasked(stdin)
	return strings.TrimSpace(input)
}
