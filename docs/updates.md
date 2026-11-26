<!-- update-contract: v1 -->
# Updates

Steak Pi tells you when a newer release exists, and updating takes one step.
Automatic updates are off until you turn them on.

## In Pi

In an interactive session, a newer release shows one footer line:

```
Steak Pi 0.45.0 available (you have 0.44.0) · /steak-update
```

When the session is idle and the editor is empty, Steak Pi also opens one dialog
with **Install update**, **Remind me later** and **Skip this version**. The
dialog closes itself after a minute, which counts as "Remind me later". The
footer line and dialog appear at most once every 24 hours per version. A skipped
version stays hidden; a newer release shows again.

After an install, Steak Pi asks once: **Install future updates automatically?**
The default is no, and Steak Pi remembers either answer.

- `/steak-update`: check now and open the dialog.
- `/steak-update check`: report only.
- `/steak-update status`: show the automatic-update setting, the skipped version and the last failure.

Print, JSON, RPC and worker sessions never check, show a notice or ask anything.

## Commands

```sh
steak-pi update                       # current -> new, release notes, then install
steak-pi update --check               # exit 0 current, 10 available, 1 check failed (cause on stderr)
steak-pi update --skip                # hide this version's notice until a newer release
steak-pi update --auto on|off|status  # automatic install (off by default)
steak-pi update --checks on|off|status
steak-pi update --rollback [version]  # release-folder installs: back to the previous release
steak-pi update --models              # refresh Pi's model catalogs; installs nothing
```

On a terminal, `steak-pi update` asks `Install <new> now? [Y/n]`, then once asks
`Install future updates automatically? [y/N]`. Without a terminal it installs
and asks nothing, because running the command is the consent. It installs only a
strictly newer stable `x.y.z` release, never an older or pre-release one.

## Automatic updates

Turn them on from the question after an install or with `steak-pi update --auto on`.
The setting is stored in `steak-pi.json` in the Pi agent directory
(`PI_CODING_AGENT_DIR`, default `~/.pi/agent`), so it survives updates:

```json
{ "updates": { "auto": true } }
```

When automatic updates are on, a session that finds a new release runs
`steak-pi update` in a detached, low-priority process. The footer then reads
`Steak Pi <new> installed · /reload to use it`. Your current session keeps its
loaded code until `/reload` or a restart. If the install fails, the current
release keeps working, the cause is recorded (`--auto status` shows it), and
the dialog opens instead.

## Install safety

- **Release folders** (the installer's default): Steak Pi downloads
  `steak-pi-<version>.tgz` and `SHA256SUMS` from the GitHub release and checks
  the archive's SHA-256 before anything changes. On a mismatch or a missing
  entry, it refuses and changes nothing. The release is unpacked into a new
  sibling folder and its locked dependencies are installed. Then every known Pi
  agent settings file that pins this releases folder is re-pointed atomically.
- **Homebrew**: `steak-pi update` runs `brew upgrade steak-pi`.
  **Git installs** (`pi install git:…`): it runs `pi install git:…@<tag>`.
  Steak Pi never overwrites files a package manager owns.
- Updates never change a running session's files. A session keeps the release
  it started with.

## No debris

- The check writes one cache file, `steak-pi/update-check.json`, under the
  platform cache directory. It holds the time, the latest version and any
  failure cause. Choices live in the `updates` section of `steak-pi.json`.
- Download staging folders are deleted on success and on failure.
- Release folders keep one rollback. It is deleted after the new release has
  started once, or seven days after it was replaced, whichever comes first.
  Older release folders are deleted too, but never while a known Pi agent
  directory pins them or a Pi session that started before the switch is still
  running.
- Automatic installs log to one file, `steak-pi/auto-update.log`, capped at 256 KB.
- `steak-pi update --auto off` deletes the cache, the log and the notice state.
  `steak-pi remove` also deletes the `updates` settings.

## Privacy and opt-out

The check is one anonymous GET to this repository's public GitHub
`releases/latest` record. It runs at most once every 24 hours per machine, in the
background, with a 4-second timeout and a fixed `steak-pi-update-check` user
agent. It sends no id, version, usage or machine data, and failures are never
retried in a loop. Details: [PRIVACY.md](../PRIVACY.md).

Checks are off in CI and in non-interactive sessions. To turn them off
yourself, set `STEAK_PI_NO_UPDATE_CHECK=1` or run `steak-pi update --checks off`.
`STEAK_PI_UPDATE_API` (endpoint) and `STEAK_PI_LATEST_TAG` (a fixed tag) are
local testing overrides.
