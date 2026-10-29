# Security policy

## Supported versions

PrismLCA is in beta. Security fixes go into the next release; we do not patch older ones. If you run an
older version, update through *About, licence and updates → Check for updates* or from the
[releases page](https://github.com/prismlca/prismlca/releases).

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately instead:

- **On GitHub:** [Report a vulnerability](https://github.com/prismlca/prismlca/security/advisories/new)
  (the *Security* tab of this repository). Only the maintainers see the report.
- **Without a GitHub account:** write to contact@prismlca.com with "Security" in the subject.

Helpful to include: the PrismLCA version (*About → Copy version info*), the operating system, what an
attacker can do and under which conditions, and the steps to reproduce it. Please leave out ecoinvent data
and API keys — we never need either to understand a report.

## What happens next

PrismLCA is a small project, so these are aims rather than guarantees: we acknowledge a report within a
week, tell you whether we can reproduce it, and keep you posted until it is fixed. The fix ships in a
release together with a GitHub security advisory; we credit you there unless you prefer not to be named.
Please give us the time to ship the fix before you publish details.

## Scope

In scope: the desktop app and its local backend, the installers and update check we publish, and the
release workflow in this repository. Out of scope: the services you connect PrismLCA to with your own
key (AI providers, routing and statistics services) — report problems there to the provider — and
findings that require an attacker who already controls your user account.
