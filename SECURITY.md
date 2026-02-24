# Security Policy

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Instead, report vulnerabilities by emailing **security@seekerclaw.xyz**.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and aim to provide a fix within 7 days for critical issues.

## Security Model

SeekerClaw takes security seriously:

- **Encryption at rest:** All sensitive configuration (API keys, tokens) is encrypted using Android Keystore (AES-256-GCM) before being written to disk.
- **No telemetry:** The app does not collect or transmit user data. Firebase Analytics is optional and disabled by default in open-source builds.
- **HTTPS only:** All external API calls (Claude, Telegram, Solana RPCs, MCP servers) use HTTPS.
- **Prompt injection defense:** The Node.js agent includes content trust scoring and prompt injection detection for untrusted inputs.
- **MCP server isolation:** Remote tool descriptions are sanitized, results are marked as untrusted, and rug-pull detection (SHA-256 hash comparison) alerts on unexpected tool changes.
- **Owner gate:** Only the configured Telegram owner can issue commands to the agent.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.4.x   | Yes       |
| < 1.4   | No        |
