# Vendored persistent bash adaptation

`bash-session.ts` is derived from `pi-dsh-minimal@0.4.2`, npm admission archive
`pi-dsh-minimal-0.4.2.tgz`, extracted `src/tools/bash-session.ts`.
See LICENSE and NOTICE for upstream MIT terms and DeepSeek Harness provenance.

Retained actual runtime: lazy bash process, serialized command queue, UUID start/end
markers, bash ANSI-C argument quoting, eval in the same shell, status capture,
persistent exports/functions/cwd, abort and timeout reset.

Adapted: fixed worker cwd at construction; terminal disposal forbids respawn;
POSIX detached worker-local process group, SIGKILL and positive shell exit
confirmation (never `proc.killed` as evidence); two-second reap failure rejects.
Output is bounded during capture and excessive output resets the shell. Defaults
are 120 seconds and 20,000 characters; invalid/excessive timeouts are rejected.
Native exit-code callback supports Pi's own BashOperations interface. Native tool
wrapper owns rendering, hooks, cancellation/context and final result formatting;
output is delivered at command completion, not incrementally. Reset uses SIGKILL
rather than upstream best-effort SIGTERM. No ambient process search or pkill.

Not vendored: upstream editor, extension registration, settings UI, model/persona
router, DSML recovery parser, prompt replacement, or automatic primary tool swaps.
