# Security Policy

## Supported versions

`0.0.1` is a Developer Preview. Security fixes are applied to the latest published preview only.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials, execute unintended commands, bypass authority boundaries, or corrupt project/session state. Use the repository owner's private security-reporting channel. Include the affected version, reproduction steps, impact, and any proposed mitigation.

Do not include real API keys, Provider credentials, private prompts, session exports, or proprietary project files in a report.

## Security boundaries

Yuqi Team Orchestrator delegates through DeepSeek Harness public APIs. Workspace access, Provider credentials, model availability, network policy, and the selected authority mode remain controlled by the user's Harness environment. Git worktree isolation is optional and does not replace permission or sandbox boundaries.
