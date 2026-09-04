# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/michael-berardi/steak-pi/security/advisories/new).
Do not open a public issue for an unpatched vulnerability and do not include
credentials, private repository content, or personal data in a report.

Include the affected Steak Pi and Pi versions, reproduction steps, impact, and
any proposed mitigation. Maintainers will acknowledge a complete report and
coordinate disclosure after a fix is available.

## Trust boundary

Steak Pi extensions run with the permissions of the local Pi process. USAP
path ownership and tool filtering are coordination controls, not an operating
system sandbox. In particular, explicitly granting a child `allowBash` gives it
operator-level shell access that can bypass `ownedPaths`. Review third-party
companions separately and never place secrets in prompts or relay messages.
