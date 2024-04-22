package create

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/gofrs/uuid"
	"github.com/spf13/afero"
	"math/rand"
	"net/http"
	"strings"
	"time"

	faker "github.com/go-faker/faker/v4"
	standardwebhooks "github.com/standard-webhooks/standard-webhooks/libraries/go"
	"github.com/supabase/cli/internal/utils"
)

var Fs = afero.NewOsFs()

type RunParams struct {
	ProjectRef     string
	ExtensionPoint string
}

type SendSMSInput struct {
	UserID string `faker:"uuid_hyphenated" json:"user_id"`   // Generates UUIDs with hyphens
	Phone  string `faker:"e_164_phone_number" json:"phone"`  // Generates phone numbers in E.164 format
	OTP    string `faker:"len=6,numerify=######" json:"otp"` // Generates a 6-digit numeric OTP
}

type MFAVerificationAttemptInput struct {
	UserID   uuid.UUID `json:"user_id" faker:"uuid_hyphenated"`
	FactorID uuid.UUID `json:"factor_id" faker:"uuid_hyphenated"`
	Valid    bool      `json:"valid"`
	// Valid might be set in tests to simulate success/failure scenarios
}

type PasswordVerificationAttemptInput struct {
	UserID uuid.UUID `json:"user_id" faker:"uuid_hyphenated"`
	Valid  bool      `json:"valid"`
	// Similar to MFAVerificationAttemptInput, Valid is likely scenario-dependent in tests
}

func Run(ctx context.Context, fsys afero.Fs, params RunParams) error {
	_ = utils.LoadConfigFS(fsys)
	var data []byte
	var err error
	name := ""

	switch params.ExtensionPoint {
	case "send-sms":
		var input SendSMSInput
		if err := faker.FakeData(&input); err != nil {
			fmt.Println("Error generating fake data:", err)
			return err
		}
		// Generate a 6-digit OTP
		rand.Seed(time.Now().UnixNano())
		input.OTP = fmt.Sprintf("%06d", rand.Intn(1000000))
		data, err = json.Marshal(input)
		name = "sms_sender"

	case "mfa-verification-attempt":
		var input MFAVerificationAttemptInput
		if err := faker.FakeData(&input); err != nil {
			fmt.Println("Error generating fake data:", err)
			return err
		}
		data, err = json.Marshal(input)
		name = "mfa_verification_attempt"

	case "password-verification-attempt":
		var input PasswordVerificationAttemptInput
		if err := faker.FakeData(&input); err != nil {
			fmt.Println("Error generating fake data:", err)
			return err
		}
		data, err = json.Marshal(input)
		name = "password_verification_attempt"
	}

	if err != nil {
		fmt.Println("Error marshalling JSON:", err)
		return err
	}

	msgID := uuid.Must(uuid.NewV4())
	currentTime := time.Now()
	SymmetricSignaturePrefix := "v1,"
	// Todo: fetch thsi secret from config
	trimmedSecret := strings.TrimPrefix(utils.Config.Auth.Hook.SendSMS.Secrets, SymmetricSignaturePrefix)
	wh, err := standardwebhooks.NewWebhook(trimmedSecret)
	signature, err := wh.Sign(msgID.String(), currentTime, data)

	// Prepare the POST request
	url := fmt.Sprintf("http://127.0.0.1:54321/functions/v1/%s", name)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(data))
	if err != nil {
		fmt.Println("Error creating request:", err)
		return err
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("webhook-id", msgID.String())
	req.Header.Set("webhook-timestamp", fmt.Sprintf("%d", currentTime.Unix()))
	req.Header.Set("webhook-signature", signature)

	// Send the request
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("Error sending request:", err)
		return err
	}
	defer resp.Body.Close()

	// Check response status
	if resp.StatusCode != http.StatusOK {
		fmt.Printf("Received non-OK status: %d\n", resp.StatusCode)
		return fmt.Errorf("received non-OK status %d", resp.StatusCode)
	}

	return nil

}
