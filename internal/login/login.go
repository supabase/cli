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

	"github.com/google/uuid"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
)

type RunParams struct {
	Token       string
	Name        string
	OpenBrowser bool
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

func decryptAccessToken(accessTokenResponse AccessTokenResponse, curve ecdh.Curve, privateKey *ecdh.PrivateKey) (string, error) {
	decodedAccessToken, err := hex.DecodeString(accessTokenResponse.AccessToken)
	if err != nil {
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	nonce, err := hex.DecodeString(accessTokenResponse.Nonce)
	if err != nil {
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	publicKey, err := hex.DecodeString(accessTokenResponse.PublicKey)
	if err != nil {
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	remotePublicKey, err := curve.NewPublicKey(publicKey)
	if err != nil {
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	secret, err := privateKey.ECDH(remotePublicKey)
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

	decryptedAccessToken, err := aesgcm.Open(nil, nonce, decodedAccessToken, nil)
	if err != nil {
		return "", fmt.Errorf("%s: %w", decryptionErrorMsg, err)
	}

	return string(decryptedAccessToken), nil
}

func pollForAccessToken(url string) (AccessTokenResponse, error) {
	var accessTokenResponse AccessTokenResponse

	// We fully control the url here, so it's safe to perform the request and ignore the G107 gosec rule.
	// TODO: Move to OpenAPI-generated http client once we reach v1 on API schema.
	resp, err := http.Get(url) //nolint:gosec
	if err != nil {
		return accessTokenResponse, fmt.Errorf("cannot fetch access token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		retryAfterSeconds, err := strconv.Atoi(resp.Header.Get("Retry-After"))
		if err != nil {
			retryAfterSeconds = defaultRetryAfterSeconds
		}
		time.Sleep(time.Duration(retryAfterSeconds) * time.Second)
		return pollForAccessToken(url)
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

func Run(ctx context.Context, stdin *os.File, params RunParams) error {
	if params.Token != "" {
		err := utils.SaveAccessToken(params.Token, params.Fsys)
		if err != nil {
			return fmt.Errorf("cannot save provided token: %w", err)
		}
		fmt.Println(loggedInMsg)
		return nil
	}

	if params.OpenBrowser {
		fmt.Print("Hello from ", utils.Aqua("Supabase"), "! Press ", utils.Aqua("Enter"), " to open browser and login automatically.\n")
		fmt.Scanln()
	}

	sessionId := uuid.New().String()
	tokenName := params.Name
	curve := ecdh.P256()
	privateKey, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("cannot generate encryption key: %w", err)
	}
	publicKey := privateKey.PublicKey()
	encodedPublicKey := hex.EncodeToString(publicKey.Bytes())

	createLoginSessionPath := "/cli/login"
	createLoginSessionQuery := "?session_id=" + sessionId + "&token_name=" + tokenName + "&public_key=" + encodedPublicKey
	createLoginSessionUrl := utils.GetSupabaseDashboardURL() + createLoginSessionPath + createLoginSessionQuery

	if params.OpenBrowser {
		fmt.Printf("Here is your login link in case browser did not open %s\n\n", utils.Bold(createLoginSessionUrl))

		openCmd := exec.CommandContext(ctx, "open", createLoginSessionUrl)
		if err := openCmd.Run(); err != nil {
			return fmt.Errorf("cannot open default browser: %w", err)
		}
	} else {
		fmt.Printf("Here is your login link, open it in the browser %s\n\n", utils.Bold(createLoginSessionUrl))
	}

	err = utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		p.Send(utils.StatusMsg("Your token is now being generated and securely encrypted. Waiting for it to arrive..."))

		sessionPollingUrl := utils.GetSupabaseAPIHost() + "/platform/cli/login/" + sessionId
		accessTokenResponse, err := pollForAccessToken(sessionPollingUrl)
		if err != nil {
			return err
		}

		decryptedAccessToken, err := decryptAccessToken(accessTokenResponse, curve, privateKey)
		if err != nil {
			return err
		}

		return utils.SaveAccessToken(decryptedAccessToken, params.Fsys)
	})
	if err != nil {
		return err
	}

	fmt.Printf("Token %s created successfully.\n\n", utils.Bold(tokenName))
	fmt.Println(loggedInMsg)

	return nil
}

func PromptAccessToken(stdin *os.File) string {
	fmt.Fprintf(os.Stderr, `You can generate an access token from %s/account/tokens
Enter your access token: `, utils.GetSupabaseDashboardURL())
	input := credentials.PromptMasked(stdin)
	return strings.TrimSpace(input)
}
