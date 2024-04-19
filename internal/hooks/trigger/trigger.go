package create

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"time"


	"github.com/spf13/afero"
	faker "github.com/go-faker/faker/v4"

)

var Fs = afero.NewOsFs()

type RunParams struct {
	ProjectRef string
	ExtensionPoint string
}

type SendSMSInput struct {
	UserID string `faker:"uuid_hyphenated" json:"user_id"`    // Generates UUIDs with hyphens
	Phone  string `faker:"e_164_phone_number" json:"phone"`  // Generates phone numbers in E.164 format
	OTP    string `faker:"len=6,numerify=######" json:"otp"` // Generates a 6-digit numeric OTP
}



func Run(ctx context.Context, params RunParams) error {
	var input SendSMSInput
	if err := faker.FakeData(&input); err != nil {
		fmt.Println("Error generating fake data:", err)
		return err
	}

	// Generate a 6-digit OTP
	rand.Seed(time.Now().UnixNano())
	input.OTP = fmt.Sprintf("%06d", rand.Intn(1000000))

	// Serialize the input data to JSON
	data, err := json.Marshal(input)
	if err != nil {
		fmt.Println("Error marshalling JSON:", err)
		return err
	}
	name := "sms_sender"

	// Prepare the POST request
	url := fmt.Sprintf("http://127.0.0.1:54321/functions/v1/%s", name)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(data))
	if err != nil {
		fmt.Println("Error creating request:", err)
		return err
	}
	req.Header.Set("Content-Type", "application/json")

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

	fmt.Printf("Payload sent successfully: %+v\n", input)
	return nil

}
