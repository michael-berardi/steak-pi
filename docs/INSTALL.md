# Installation and launcher

Start with the [one-command installers](../README.md#install).
They download the release archive and compare its SHA-256 with the release's
checksum list. This detects corruption; it is not an independent signature.

## Paths and prerequisites

The shell installer uses `~/.local/share/steak-pi/releases/<version>/package`
and puts the launcher in `~/.local/bin`. It does not edit shell profiles.
The PowerShell installer uses `%LOCALAPPDATA%\steak-pi` and adds its bin folder
to the user PATH. Open a new terminal if the command is not yet visible.

If Node.js 22.19+ is absent, the installer downloads an official build into its
own runtime folder. If Pi is absent, it installs the version pinned by the
release and creates a Pi shim. An existing Pi installation is kept.
The shell bootstrap supports macOS and Linux x64/arm64. On musl Linux, install
Node.js and npm through the system package manager before running the installer.

| Environment variable | Purpose |
| --- | --- |
| `STEAK_PI_HOME` | Installation root |
| `STEAK_PI_BIN_DIR` | Launcher directory |
| `STEAK_PI_VERSION` | Release version to install |
| `STEAK_PI_PI_VERSION` | Pi version to install when Pi is absent |
| `PI_CODING_AGENT_DIR` | Pi agent directory; default `~/.pi/agent` |

## Install a downloaded archive

Download `steak-pi-0.35.3.tgz` and its `.sha256` file from the
[release page](../README.md#install) into an empty directory. With Node.js, npm
and Pi already installed, run:

```sh
shasum -a 256 -c steak-pi-0.35.3.tgz.sha256
tar -xzf steak-pi-0.35.3.tgz
npm ci --ignore-scripts --prefix "$PWD/package"
pi install "$PWD/package"
```

On Linux, `sha256sum -c` can replace `shasum -a 256 -c`.
Keep the extracted folder: Pi's settings point to it. A direct Git or archive
install does not put `steak-pi` on PATH; use `pi`, or invoke `bin/steak-pi`
inside the installed package.

## Launcher

```sh
steak-pi run              # forwards arguments to Pi
steak-pi env              # Node memory and compile-cache defaults
steak-pi status           # version, settings file and integration
steak-pi update --check   # report available package update
steak-pi update           # install package update
steak-pi update --models  # refresh model catalogs only
```

The launcher sets Node defaults only when you have not set them.
`steak-pi <subcommand> --help` also works for nested verbs, such as
`steak-pi routing check --help`. `steak-pi run --help` goes to Pi.
`run --lean` remains supported; see [adaptive tools](REFERENCE.md#one-package-no-modes).

Catalog refresh loads the installed Pi packages and refreshes every registered
provider. It prints a result per provider and exits nonzero if any refresh fails.
It targets `PI_CODING_AGENT_DIR` and installs nothing.

Release-folder updates retain older releases because running sessions may use
them. Managed installations may have their own update policy; do not overwrite
a running session's runtime tree. Re-running the installer also upgrades.

## Remove

Run `steak-pi remove` to unregister the package from Pi. Then delete the
installation root and its launcher shim. Remove the Pi shim only if this
installer created it. For custom paths, use the values supplied at install time.
A direct Pi install can be removed with Pi's package manager.
