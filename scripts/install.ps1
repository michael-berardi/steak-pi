# Steak Pi installer for Windows:  irm https://github.com/michael-berardi/steak-pi/releases/latest/download/install.ps1 | iex
# Downloads the latest release archive, checks its SHA-256, installs it into the release-folder layout
# `steak-pi update` maintains, and points Pi at it. Uses the Node 22.19+ already on this machine, or fetches
# the official Node into Steak Pi's own folder (nothing global). Uses the `pi` already on PATH, or installs
# the Pi coding agent into Steak Pi's folder and adds a `pi` shim only when none existed.
# Also runs under PowerShell 7 on Linux for testing (STEAK_PI_HOME / STEAK_PI_BIN_DIR / STEAK_PI_RELEASE_BASE).
# Environment: STEAK_PI_HOME (Windows default %LOCALAPPDATA%\steak-pi), STEAK_PI_BIN_DIR, STEAK_PI_VERSION,
# STEAK_PI_PI_VERSION (Pi version when pi is absent; default: the pin in the release's package-lock.json),
# STEAK_PI_RELEASE_BASE (override the download base URL, used by tests).
$ErrorActionPreference = 'Stop'

function Main {
  $repo = 'github.com/michael-berardi/steak-pi'
  $onWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
  $base = if ($env:STEAK_PI_RELEASE_BASE) { $env:STEAK_PI_RELEASE_BASE }
          elseif ($env:STEAK_PI_VERSION) { "https://$repo/releases/download/v$($env:STEAK_PI_VERSION.TrimStart('v'))" }
          else { "https://$repo/releases/latest/download" }
  $archive = if ($env:STEAK_PI_VERSION) { "steak-pi-$($env:STEAK_PI_VERSION.TrimStart('v')).tgz" } else { 'steak-pi.tgz' }
  $homeDir = if ($env:STEAK_PI_HOME) { $env:STEAK_PI_HOME }
             elseif ($onWindows) { Join-Path $env:LOCALAPPDATA 'steak-pi' }
             else { Join-Path $HOME '.local/share/steak-pi' }
  $binDir = if ($env:STEAK_PI_BIN_DIR) { $env:STEAK_PI_BIN_DIR }
            elseif ($onWindows) { Join-Path $homeDir 'bin' }
            else { Join-Path $HOME '.local/bin' }
  $releases = Join-Path $homeDir 'releases'

  function Fail([string]$message) { throw "steak-pi install: $message" }
  # Progress lines for the person running the installer: the information stream prints them, and they stay out of the output pipeline.
  function Say([string]$message) { Write-Information -MessageData $message -InformationAction Continue }
  function Fetch([string]$url, [string]$dest) {
    try { Invoke-WebRequest $url -OutFile $dest -UseBasicParsing }
    catch { Fail "download failed: $url ($($_.Exception.Message))" }
  }
  function Assert-Sum([string]$file, [string]$name, [string]$sumsFile) {
    $line = Get-Content $sumsFile | Where-Object { $_ -match '\S' } | Where-Object { ($_ -split '\s+', 2)[1].TrimStart('*') -eq $name } | Select-Object -First 1
    if (-not $line) { Fail "no checksum for $name in $(Split-Path $sumsFile -Leaf)" }
    $want = ($line -split '\s+', 2)[0].ToLower()
    $got = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want) { Fail "checksum mismatch for $name; nothing was installed" }
  }
  function Test-NodeOk([string]$nodeBin) {
    try { $v = (& $nodeBin -p 'process.versions.node' 2>$null) } catch { return $false }
    if ($LASTEXITCODE -ne 0 -or -not $v) { return $false }
    $parts = $v.Split('.')
    return ([int]$parts[0] -gt 22) -or (([int]$parts[0] -eq 22) -and ([int]$parts[1] -ge 19))
  }

  # Prerequisites, named with how to get them.
  if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    Fail 'needs tar to unpack the release; Windows 10 1803+ ships tar.exe, or install Git for Windows (https://git-scm.com/download/win)'
  }
  $sh = Get-Command sh -ErrorAction SilentlyContinue
  if (-not $sh) { $sh = Get-Command bash -ErrorAction SilentlyContinue }
  if (-not $sh) {
    Fail "the steak-pi CLI is a POSIX shell script and needs sh; install Git for Windows (https://git-scm.com/download/win), which provides sh.exe, then run this again"
  }
  $shExe = $sh.Source

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('steak-pi-install-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $savedPath = $env:PATH
  $savedLibexec = $env:STEAK_PI_LIBEXEC
  $savedNpm = @{ notifier = $env:npm_config_update_notifier; fund = $env:npm_config_fund; audit = $env:npm_config_audit }
  $stage = $null
  try {
    Say 'Downloading Steak Pi...'
    Fetch "$base/$archive" (Join-Path $tmp $archive)
    Fetch "$base/SHA256SUMS" (Join-Path $tmp 'SHA256SUMS')
    Assert-Sum -file (Join-Path $tmp $archive) -name $archive -sumsFile (Join-Path $tmp 'SHA256SUMS')
    $src = Join-Path $tmp 'src'
    New-Item -ItemType Directory -Path $src | Out-Null
    & tar -xzf (Join-Path $tmp $archive) -C $src
    if ($LASTEXITCODE -ne 0) { Fail 'cannot unpack the download (tar failed)' }
    $pkgSrc = Join-Path $src 'package'
    if (-not (Test-Path (Join-Path $pkgSrc 'package.json')) -or -not (Test-Path (Join-Path $pkgSrc 'bin/steak-pi'))) {
      Fail 'the download is not a Steak Pi release (package/package.json or package/bin/steak-pi missing)'
    }
    $version = (Get-Content (Join-Path $pkgSrc 'package.json') -Raw | ConvertFrom-Json).version
    if (-not $version) { Fail 'cannot read the release version' }
    if ($env:STEAK_PI_VERSION -and $version -ne $env:STEAK_PI_VERSION.TrimStart('v')) {
      Fail "the archive reports version $version, not the pinned $($env:STEAK_PI_VERSION.TrimStart('v')); nothing was installed"
    }

    # Node: the one on PATH when it is new enough, else the official build, kept inside Steak Pi's own folder.
    $nodeDir = $null
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    $nodeBin = $null
    if ($nodeCmd -and (Test-NodeOk $nodeCmd.Source)) { $nodeBin = $nodeCmd.Source }
    else {
      $os = if ($onWindows) { 'win' } else { 'linux' }
      $arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
        'X64' { 'x64' } 'Arm64' { 'arm64' } default { Fail "unsupported CPU $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)" }
      }
      Say "Node 22.19 or newer not found; fetching the official Node 22 LTS for $os-$arch..."
      $nbase = 'https://nodejs.org/dist/latest-v22.x'
      $sums = Join-Path $tmp 'NODESUMS'
      Fetch "$nbase/SHASUMS256.txt" $sums
      $ext = if ($onWindows) { "-$os-$arch.zip" } else { "-$os-$arch.tar.gz" }
      $nname = (Get-Content $sums | Where-Object { $_ -match '\S' } | ForEach-Object { ($_ -split '\s+', 2)[1] } | Where-Object { $_.EndsWith($ext) } | Select-Object -First 1)
      if (-not $nname) { Fail "no official Node build for $os-$arch" }
      Fetch "$nbase/$nname" (Join-Path $tmp $nname)
      Assert-Sum -file (Join-Path $tmp $nname) -name $nname -sumsFile $sums
      $nver = ($nname -replace '^node-', '') -replace '-.*$', ''
      $runtime = Join-Path $homeDir 'runtime'
      New-Item -ItemType Directory -Force -Path $runtime | Out-Null
      $nodeDir = Join-Path $runtime "node-$nver-$os-$arch"
      if (-not (Test-Path (Join-Path $nodeDir $(if ($onWindows) { 'node.exe' } else { 'bin/node' })))) {
        $nodeTmp = "$nodeDir.tmp"
        if (Test-Path $nodeTmp) { Remove-Item -Recurse -Force $nodeTmp }
        New-Item -ItemType Directory -Path $nodeTmp | Out-Null
        if ($onWindows) {
          Expand-Archive (Join-Path $tmp $nname) -DestinationPath $nodeTmp
          $inner = Get-ChildItem $nodeTmp | Select-Object -First 1
          Move-Item $inner.FullName $nodeDir
          Remove-Item -Recurse -Force $nodeTmp
        } else {
          & tar -xzf (Join-Path $tmp $nname) -C $nodeTmp --strip-components=1
          if ($LASTEXITCODE -ne 0) { Fail 'cannot unpack Node (tar failed)' }
          if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
          Move-Item $nodeTmp $nodeDir
        }
      }
      $nodeBin = Join-Path $nodeDir $(if ($onWindows) { 'node.exe' } else { 'bin/node' })
      if (-not (Test-NodeOk $nodeBin)) { Fail 'the downloaded Node does not run on this machine' }
      $nodeBinDir = if ($onWindows) { $nodeDir } else { Join-Path $nodeDir 'bin' }
      $env:PATH = "$nodeBinDir$([IO.Path]::PathSeparator)$env:PATH"
    }
    $npmBin = Join-Path (Split-Path $nodeBin -Parent) $(if ($onWindows) { 'npm.cmd' } else { 'npm' })
    if (-not (Test-Path $npmBin)) {
      $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
      if (-not $npmCmd) { Fail "npm not found next to $nodeBin or on PATH; it ships with Node" }
      $npmBin = $npmCmd.Source
    }

    # Pi: the one on PATH when present, else the pinned release installed into Steak Pi's own folder.
    $piWasPresent = [bool](Get-Command pi -ErrorAction SilentlyContinue)
    $piVersionInstalled = $null
    $piHome = Join-Path $homeDir 'pi'
    if ($piWasPresent) {
      Say "Pi is already installed ($((Get-Command pi).Source)); using it."
    } else {
      $piVersionInstalled = $env:STEAK_PI_PI_VERSION
      if (-not $piVersionInstalled) {
        $lockPath = Join-Path $pkgSrc 'package-lock.json'
        if (-not (Test-Path $lockPath)) { Fail 'the release has no package-lock.json to read the Pi version pin from; set STEAK_PI_PI_VERSION' }
        # Read the pin with Node (always present here): ConvertFrom-Json rejects the lockfile's "" key,
        # and -AsHashTable does not exist in Windows PowerShell 5.1. Same expression as install.sh.
        $piVersionInstalled = (& $nodeBin -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).packages[""].devDependencies["@earendil-works/pi-coding-agent"] || ""' $lockPath | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0) { Fail 'cannot read the Pi version pin from package-lock.json (node failed to parse it)' }
        if ($piVersionInstalled) { $piVersionInstalled = "$piVersionInstalled".Trim() }
        if (-not $piVersionInstalled) { Fail "no Pi version pin in the release's package-lock.json; set STEAK_PI_PI_VERSION" }
      }
      Say "Pi not found; installing @earendil-works/pi-coding-agent@$piVersionInstalled into $piHome..."
      New-Item -ItemType Directory -Force -Path $piHome | Out-Null
      $env:npm_config_update_notifier = 'false'; $env:npm_config_fund = 'false'; $env:npm_config_audit = 'false'
      & $npmBin install --prefix $piHome --ignore-scripts --no-audit --no-fund --loglevel=error "@earendil-works/pi-coding-agent@$piVersionInstalled"
      if ($LASTEXITCODE -ne 0) { Fail "npm install of @earendil-works/pi-coding-agent@$piVersionInstalled failed; nothing was changed" }
      $piLauncher = Join-Path $piHome $(if ($onWindows) { 'node_modules\.bin\pi.cmd' } else { 'node_modules/.bin/pi' })
      if (-not (Test-Path $piLauncher)) { Fail "the Pi install did not produce $piLauncher" }
    }

    # Unpack into the release-folder layout the CLI maintains: <home>/releases/<version>/package.
    New-Item -ItemType Directory -Force -Path $releases, $binDir | Out-Null
    $rel = Join-Path $releases $version
    $pkg = Join-Path $rel 'package'
    $already = (Test-Path (Join-Path $pkg 'package.json')) -and
      ((Get-Content (Join-Path $pkg 'package.json') -Raw | ConvertFrom-Json).version -eq $version)
    if ($already) {
      Say "Steak Pi $version is already unpacked; re-pointing Pi."
    } else {
      if (Test-Path $rel) { Fail "release destination $rel already exists but is incomplete; preserved it (remove it and run this again)" }
      Say "Installing Steak Pi $version..."
      $stage = Join-Path $releases (".staging-$version-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
      New-Item -ItemType Directory -Path $stage | Out-Null
      Move-Item $pkgSrc (Join-Path $stage 'package')
      # The same dependency install `steak-pi update` runs: the extensions import Pi's own packages, so dev dependencies stay.
      Push-Location (Join-Path $stage 'package')
      try {
        & $npmBin ci --ignore-scripts --no-audit --no-fund --loglevel=error
        $ciCode = $LASTEXITCODE
      } finally { Pop-Location }
      if ($ciCode -ne 0) { Fail "npm ci failed for Steak Pi $version; nothing was changed" }
      New-Item -ItemType Directory -Path $rel | Out-Null
      Move-Item (Join-Path $stage 'package') $pkg
      Remove-Item -Recurse -Force $stage; $stage = $null
    }

    # Shims: .cmd on Windows; on Linux (PowerShell 7 testing) plain sh shims so the commands run there too.
    function Write-Shim([string]$name, [string]$target, [string]$interpreter) {
      if ($onWindows) {
        $lines = @('@echo off')
        if ($nodeDir) { $lines += "set `"PATH=$nodeDir;%PATH%`"" }
        if ($interpreter) { $lines += "@`"$interpreter`" `"$target`" %*" } else { $lines += "@`"$target`" %*" }
        $shim = Join-Path $binDir "$name.cmd"
        Set-Content -Path $shim -Value ($lines -join "`r`n") -Encoding Ascii
      } else {
        $lines = @('#!/bin/sh')
        if ($nodeDir) { $lines += "PATH=`"$(Join-Path $nodeDir 'bin'):`$PATH`"; export PATH" }
        if ($interpreter) { $lines += "exec `"$interpreter`" `"$target`" `"`$@`"" } else { $lines += "exec `"$target`" `"`$@`"" }
        $shim = Join-Path $binDir $name
        Set-Content -Path $shim -Value ($lines -join "`n") -Encoding Ascii
        & chmod 755 $shim
      }
    }
    if (-not $piWasPresent) {
      if ($onWindows) {
        $piPkgDir = Join-Path $piHome 'node_modules\@earendil-works\pi-coding-agent'
        $piBinRel = (Get-Content (Join-Path $piPkgDir 'package.json') -Raw | ConvertFrom-Json).bin.pi
        if (-not $piBinRel) { Fail 'the installed Pi package declares no pi bin entry' }
        Write-Shim -name 'pi' -target (Join-Path $piPkgDir $piBinRel) -interpreter $nodeBin
      } else {
        Write-Shim -name 'pi' -target (Join-Path $piHome 'node_modules/.bin/pi') -interpreter $null
      }
    }

    # Point Pi at the unpacked release. STEAK_PI_LIBEXEC is the CLI's supported way to pin a local folder
    # (the Homebrew wrapper uses it); without it `steak-pi install` would pin a git spec instead.
    Say "Adding Steak Pi $version to Pi..."
    $env:PATH = "$binDir$([IO.Path]::PathSeparator)$env:PATH"
    $env:STEAK_PI_LIBEXEC = $pkg
    & $shExe (Join-Path $pkg 'bin/steak-pi') install
    $installCode = $LASTEXITCODE
    $env:STEAK_PI_LIBEXEC = $savedLibexec
    if ($installCode -ne 0) { Fail "'steak-pi install' failed; Pi's settings were not changed" }

    Write-Shim -name 'steak-pi' -target (Join-Path $pkg 'bin/steak-pi') -interpreter $(if ($onWindows) { $shExe } else { $null })

    # Windows: add the bin folder to the USER Path only when absent. Never edits profiles.
    if ($onWindows) {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      if (-not $userPath) { $userPath = '' }
      if (($userPath -split ';') -notcontains $binDir) {
        [Environment]::SetEnvironmentVariable('Path', $(if ($userPath) { "$userPath;$binDir" } else { $binDir }), 'User')
        Say "Added $binDir to your user PATH; open a new terminal to use it."
      }
    }

    # Health check: the CLI's own status must run and report the release.
    $steakShim = Join-Path $binDir $(if ($onWindows) { 'steak-pi.cmd' } else { 'steak-pi' })
    $statusOut = & $steakShim status 2>&1
    $statusCode = $LASTEXITCODE
    $statusOut | ForEach-Object { Say $_ }
    if ($statusCode -ne 0) { Fail "'steak-pi status' failed after installing" }
    if (($statusOut -join "`n") -notmatch [regex]::Escape($version)) { Fail "'steak-pi status' does not report $version" }

    if ($piWasPresent) {
      Say "Steak Pi $version installed ($steakShim). Pi was already installed; Steak Pi was added to it."
    } else {
      Say "Steak Pi $version installed ($steakShim). Pi $piVersionInstalled was installed too ($(Join-Path $binDir $(if ($onWindows) { 'pi.cmd' } else { 'pi' })))."
    }
    if (-not $onWindows) {
      if (($env:PATH -split [IO.Path]::PathSeparator) -notcontains $binDir) {
        Say "Add $binDir to your PATH:  export PATH=`"$binDir`:`$PATH`""
      }
    }
    Say 'Next: steak-pi run'
  } finally {
    $env:PATH = $savedPath
    $env:STEAK_PI_LIBEXEC = $savedLibexec
    $env:npm_config_update_notifier = $savedNpm.notifier; $env:npm_config_fund = $savedNpm.fund; $env:npm_config_audit = $savedNpm.audit
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    if ($stage -and (Test-Path $stage)) { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
  }
}

Main