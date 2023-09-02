# Supabase CLI (v1)

[![Coverage Status](https://coveralls.io/repos/github/supabase/cli/badge.svg?branch=main)](https://coveralls.io/github/supabase/cli?branch=main)

[Supabase](https://supabase.io) is an open source Firebase alternative. We're building the features of Firebase using enterprise-grade open source tools.

This repository contains all the functionality for Supabase CLI.

- [x] Running Supabase locally
- [x] Managing database migrations
- [x] Pushing your local changes to production
- [x] Create and Deploy Supabase Functions
- [ ] Manage your Supabase Account
- [x] Manage your Supabase Projects
- [x] Generating types directly from your database schema
- [ ] Generating API and validation schemas from your database

## Getting started

### Install the CLI

Available via [NPM](https://www.npmjs.com) as dev dependency. To install:

```bash
npm i supabase --save-dev
```

To install the beta release channel:

```bash
npm i supabase@beta --save-dev
```

<details>
  <summary><b>macOS</b></summary>

  Available via [Homebrew](https://brew.sh). To install:

  ```sh
  brew install supabase/tap/supabase
  ```

  To install the beta release channel:
  
  ```sh
  brew install supabase/tap/supabase-beta
  brew link --overwrite supabase-beta
  ```
  
  To upgrade:

  ```sh
  brew upgrade supabase
  ```
</details>

<details>
  <summary><b>Windows</b></summary>

  Available via [Scoop](https://scoop.sh). To install:

  ```powershell
  scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
  scoop install supabase
  ```

  To upgrade:

  ```powershell
  scoop update supabase
  ```
</details>

<details>
  <summary><b>Linux</b></summary>

  Available via [Homebrew](https://brew.sh) and Linux packages.

  #### via Homebrew

  To install:

<summary><b>First you need to have Homebrew on your Linux machine</b></summary>

# Open your terminal and run the following command to install Homebrew:

run: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install.sh)"

if you already had brew run:brew update // This will update brew

<b>Add Homebrew to Your Shell:</b>

run: nano ~/.bashrc

<!-- this will open up your environment variable path inside your terminal-->

<b>Add the following line at the end of the file to include Homebrew in your PATH:</b>

 copy and paste: export PATH="/home/linuxbrew/.linuxbrew/bin:$PATH" at the end of your environment file inside your terminal.

 <b>Reload Your Shell Configuration:</b>

 run: source ~/.bashrc


<b> Now run</b>

  ```sh
  brew tap supabase/tap
  ```
  <b>Next run</b>
   ```sh
 brew install supabase/tap/supabase

<!-- If you encounter an error you might need to install Clang using the apt package manager. Open your terminal and run:-->
  sudo apt update
  sudo apt install clang

<b>Retry the Supabase CLI Installation:</b>
run: 

```sh 
  brew install supabase/tap/supabase


  To upgrade:

  ```sh
  brew upgrade supabase
  ```
<b>Finally To check the version of your supabase<b>
run:
supabase --version

  #### via Linux packages

  Linux packages are provided in [Releases](https://github.com/supabase/cli/releases). To install, download the `.apk`/`.deb`/`.rpm`/`.pkg.tar.zst` file depending on your package manager and run the respective commands.

  ```sh
  sudo apk add --allow-untrusted <...>.apk
  ```

  ```sh
  sudo dpkg -i <...>.deb
  ```

  ```sh
  sudo rpm -i <...>.rpm
  ```

  ```sh
  sudo pacman -U <...>.pkg.tar.zst
  ```
</details>

<details>
  <summary><b>Other Platforms</b></summary>

  You can also install the CLI via [go modules](https://go.dev/ref/mod#go-install) without the help of package managers.

  ```sh
  go install github.com/supabase/cli@latest
  ```

  Add a symlink to the binary in `$PATH` for easier access:

  ```sh
  ln -s "$(go env GOPATH)/cli" /usr/bin/supabase
  ```

  This works on other non-standard Linux distros.
</details>

### Run the CLI

```bash
supabase help
```

Or using npx:

```bash
npx supabase help
```

## Docs

Command & config reference can be found [here](https://supabase.com/docs/reference/cli/about).

## Breaking changes

The CLI is a WIP and we're still exploring the design, so expect a lot of breaking changes. We try to document migration steps in [Releases](https://github.com/supabase/cli/releases). Please file an issue if these steps don't work!

## Developing

To run from source:

```sh
# Go >= 1.20
go run . help
```

