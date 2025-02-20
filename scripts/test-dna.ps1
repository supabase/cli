# Run DNA assistant tests
Write-Host "Running DNA assistant tests..."
go test -v ./cmd -run "TestDNAAssistant" -count=1 