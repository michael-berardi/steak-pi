# Google AI Ultra plan provider (`google-ai-plan`)

Steak Pi ships the Google AI Ultra plan provider from [earendil-works/pi PR 12614](https://github.com/earendil-works/pi/pull/12614) as its own extension (`extensions/google-ai-plan`) until the pinned Pi includes it. The request code, error handling and sign-in are the PR's code; the port only swaps the imports and four helpers the pinned Pi does not export yet (`SseDecoder`, `ToolCallArgumentsStream`, the `xhigh` thinking level, the `User-Agent`).

## Sign in

Run `/login` and choose **Sign in with Google (AI Ultra)**. Google opens in the browser; on a remote machine, paste the final URL from the address bar. The sign-in uses Google OAuth with PKCE and DPoP: the refresh token is bound to a P-256 key created on this machine and stored in `~/.pi/agent/auth.json` with the credential. Google's grant lasts 7 days; after that `/login` again.

Google approves each app's OAuth client separately and does not allow apps to share one, so Steak Pi ships none (the PR's own rule for forks and apps built on pi). Register a `Desktop app` client in your own Google Cloud project, have Google approve it for the AI Ultra plan, then add it as `~/.pi/agent/google-ai-plan-client.json` (under `PI_CODING_AGENT_DIR` when set):

```json
{ "clientId": "<client id>", "clientSecret": "<client secret>" }
```

or set both `STEAK_PI_GOOGLE_AI_PLAN_CLIENT_ID` and `STEAK_PI_GOOGLE_AI_PLAN_CLIENT_SECRET`. Without a client, `/login` stops with a named error that points here; the models still show and nothing else is affected.

## Models

| Model | Thinking levels |
| --- | --- |
| `google-ai-plan/gemini-4-hydrogen` | low, medium, high, xhigh |
| `google-ai-plan/gemini-4-neon` | low, medium, high, xhigh |
| `google-ai-plan/gemini-4-carbon` | low, medium, high |
| `google-ai-plan/gemini-3.5-flash-lite` | minimal to high |

The plan has no model-list endpoint, so this fixed list follows Google's partner docs. Requests go to `https://generativelanguage.googleapis.com/v1beta/interactions:createPerUserQuota` and spend the account's plan quota. Cost shows as 0.

## Errors

Every error keeps Google's own text and adds what to do: sign in again (401, missing scope), upgrade (no eligible plan), or switch model. A per-minute 429 is retried. A daily limit, or a model the plan does not include, fails at once and is not retried.
