# GitHub Secrets Setup

Secrets required by the [release workflow](.github/workflows/release.yml) to build and sign release APKs.

## Required Secrets

| Secret | Description |
|--------|-------------|
| `KEYSTORE_BASE64` | Base64-encoded `.jks` keystore file |
| `KEY_ALIAS` | Key alias inside the keystore (e.g. `seekerclaw`) |
| `KEY_PASSWORD` | Password for the key alias |
| `STORE_PASSWORD` | Password for the keystore file |
| `GOOGLE_SERVICES_JSON` | Base64-encoded `google-services.json` (optional — Firebase analytics) |

## How to encode files as Base64

```bash
# Linux / macOS
base64 -w 0 seekerclaw-release.jks > keystore.b64

# macOS (if -w not supported)
base64 -i seekerclaw-release.jks -o keystore.b64

# Windows (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("seekerclaw-release.jks")) | Out-File keystore.b64 -NoNewline
```

The contents of `keystore.b64` is what you paste into the `KEYSTORE_BASE64` secret.

Same approach for Firebase:
```bash
base64 -w 0 app/google-services.json    # Linux
```
Paste the output into the `GOOGLE_SERVICES_JSON` secret. If omitted, the build still succeeds — Firebase analytics just becomes a no-op.

## Adding secrets to GitHub

1. Go to **Settings > Secrets and variables > Actions** in your GitHub repo
2. Click **New repository secret**
3. Add each secret from the table above:
   - `KEYSTORE_BASE64` — paste the full base64 string (no line breaks)
   - `KEY_ALIAS` — the alias you used when creating the keystore
   - `KEY_PASSWORD` — the key password
   - `STORE_PASSWORD` — the keystore password

## Generating a new keystore (if you don't have one)

```bash
keytool -genkeypair \
  -v \
  -keystore seekerclaw-release.jks \
  -alias seekerclaw \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -storepass YOUR_STORE_PASSWORD \
  -keypass YOUR_KEY_PASSWORD \
  -dname "CN=SeekerClaw, O=SeekerClaw, L=Unknown, ST=Unknown, C=US"
```

Then encode it with the base64 commands above.

## Triggering a release

Push a version tag to trigger the workflow:

```bash
git tag v1.4.0
git push origin v1.4.0
```

The workflow will:
1. Build a signed release APK
2. Verify the APK signature
3. Extract changelog from `CHANGELOG.md` for the tagged version
4. Create a GitHub Release with the APK attached

## Local signing (development)

For local release builds, add these to `local.properties` (gitignored):

```properties
SEEKERCLAW_KEYSTORE_PATH=/path/to/seekerclaw-release.jks
SEEKERCLAW_STORE_PASSWORD=your_store_password
SEEKERCLAW_KEY_ALIAS=seekerclaw
SEEKERCLAW_KEY_PASSWORD=your_key_password
```

## Security notes

- Never commit keystore files (`.jks`, `.keystore`) — they're in `.gitignore`
- Never commit `local.properties` or `keystore.properties` — they're in `.gitignore`
- Use unique passwords for `STORE_PASSWORD` and `KEY_PASSWORD`
- Keep a backup of your keystore — losing it means you can't update the app on any store
