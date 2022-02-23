package utils

import (
	"os"
	"testing"
)

func TestConfigParsing(superTest *testing.T) {
	superTest.Cleanup(func() {
		if err := os.Remove("./supabase/config.toml"); err != nil {
			if !os.IsNotExist(err) {
				superTest.Error(err)
			}
		}
		if err := os.Remove("./supabase"); err != nil {
			if !os.IsNotExist(err) {
				superTest.Error(err)
			}
		}
	})

	if err := os.Mkdir("./supabase", 0777); err != nil {
		superTest.Error(err)
		superTest.FailNow()
	}

	superTest.Run("classic config file", func(t *testing.T) {
		if err := WriteConfig(false); err != nil {
			t.Error(err)
			t.FailNow()
		}
		if err := LoadConfig(); err != nil {
			t.Error(err)
			t.FailNow()
		}
	})

	superTest.Run("config file with environment variables", func(t *testing.T) {
		if err := WriteConfig(true); err != nil {
			t.Error(err)
			t.FailNow()
		}

		t.Setenv("AZURE_CLIENT_ID", "hello")
		t.Setenv("AZURE_SECRET", "this is cool")
		if err := LoadConfig(); err != nil {
			t.Error(err)
			t.FailNow()
		}

		if Config.Auth.External["azure"].ClientId != "hello" {
			t.Errorf("unexpected value for key [ClientId]: %+v", Config.Auth.External["azure"])
			t.FailNow()
		}

		if Config.Auth.External["azure"].Secret != "this is cool" {
			t.Errorf("unexpected value for key [Secret]: %+v", Config.Auth.External["azure"])
			t.FailNow()
		}
	})

	superTest.Run("config file with environment variables fails when unset", func(t *testing.T) {
		if err := WriteConfig(true); err != nil {
			t.Error(err)
			t.FailNow()
		}

		if err := LoadConfig(); err == nil {
			t.Error("expected to fail")
			t.FailNow()
		}
	})
}
