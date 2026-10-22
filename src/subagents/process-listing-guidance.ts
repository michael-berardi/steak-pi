/** Guidance for every child prompt, independent of parent-supplied task text.
 * This is not a shell filter, redactor, or operating-system sandbox. */
export const PROCESS_LISTING_GUIDANCE = 'Treat any full process command line as if it contained credentials: an agent launch command can carry exported API keys and tokens. List processes by PID and name only: `pgrep -f "pattern"` (PIDs only) or `ps -o pid,ppid,etime,comm -p <pid>`. Never print a full command line and never print an environment listing.';
