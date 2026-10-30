# marketplace-advanced.kadena.ws (v11 preview)

A second copy of the Marketplace, running this repository's `main`, on the same server as marketplace.kadena.ws.
It talks to **Kadena mainnet** (escrow v11 on chains 1 and 2), so trades on it are real. A yellow bar on every page
says so. It is hidden from search engines.

| | Live site | Preview |
|---|---|---|
| Address | marketplace.kadena.ws | marketplace-advanced.kadena.ws |
| Code | KadenaNexus/marketplace `main` | KadenaNexus/marketplace-advanced `main` |
| API (PM2) | kadena-server, port 5050 | kadena-advanced-server, 127.0.0.1:5060 |
| Frontend | kadena-app, port 8081 | static files in /var/www/marketplace-advanced.kadena.ws |
| Database | kadena_nexus | kadena_advanced (its own) |
| Deploy script | deploy-marketplace | deploy-marketplace-advanced |

Nothing here changes the live site, its database, its PM2 processes or its nginx file.

## One-time setup, in order

**1. DNS (Saudi.KDA, GoDaddy → kadena.ws → DNS).** Add one record and change nothing else:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | marketplace-advanced | 89.167.14.58 | 1 hour |

**2. GitHub access.** The repository is **public** (Saudi.KDA, Oct 20), so the server needs no key or token and setup skips
this step. Only if it is made private again: the organization does not allow deploy keys, so create a fine-grained
token that can only read it, and the setup script asks for it:

- github.com → your photo → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** →
  **Generate new token**.
- Name `marketplace-advanced preview server`, expiration **1 year**, resource owner **KadenaNexus**.
- Repository access: **Only select repositories** → `marketplace-advanced`.
- Permissions → Repository permissions → **Contents: Read-only**. Nothing else.
- Generate, copy the token (`github_pat_…`), and send it to whoever runs step 3 in a disappearing message.
- If KadenaNexus requires approval for tokens: organization **Settings → Personal access tokens → Pending requests**, approve it.

**3. Server (whoever has sudo on the server; about 10 minutes).**

    # from a computer that has this repository (it is private, so the server can't fetch it yet):
    scp -r deploy/staging <you>@89.167.14.58:/tmp/ma-setup
    # then on the server:
    sudo bash /tmp/ma-setup/setup.sh <pm2-account> <path-to-the-live-marketplace-.env>

- `<pm2-account>`: the Linux account that runs the existing PM2 apps.
- The second argument is optional. It copies only the email (Resend), web-push and WalletConnect lines from the live
  `.env`, so the key never leaves the server.
- It asks for the token from step 2 (nothing is shown while pasting), checks GitHub accepts it, and keeps it in
  `~/.config/marketplace-advanced/git-credentials` of the PM2 account (mode 600). It is never printed and is not in
  the repository URL. **To renew it** next year: delete that file and run the script again.
- It then creates the database, the `.env` (mode 600), the first build, the PM2 process, nginx, the HTTPS
  certificate, and `/usr/local/bin/deploy-marketplace-advanced`, which the `deployer` account may run with sudo and
  nothing else. Every step can be re-run safely.

If step 1 isn't visible yet, it stops and says so.

**4. GitHub secrets (Saudi.KDA).** In KadenaNexus → Settings → Secrets and variables → Actions:

- For **DEPLOY_HOST**, **DEPLOY_USER** and **DEPLOY_KEY**, open each secret's *Repository access*. Add
  `marketplace-advanced` to the selected repositories. Keep it on "Selected repositories".
- In the marketplace-advanced repository → Settings → Secrets → Actions, add **DEPLOY_SCRIPT** =
  `deploy-marketplace-advanced`.

**5. Merge** the homepage pull request that lets the shared deploy workflow run for this repository.

From then on, every merge to `main` of marketplace-advanced deploys to the preview.

## What a deploy does

`deploy-marketplace-advanced` checks out `origin/main` and runs `npm ci` and the build. It then:

1. swaps in the new files;
2. restarts only `kadena-advanced-server`;
3. checks the API and https://marketplace-advanced.kadena.ws/.

If anything fails, it puts back the previous build and code and exits with an error, so the GitHub run turns red.
It never runs database or contract commands.

## Auto-release on the preview

Auto-release stays off until the agent key exists on this server (docs/AUTO-RELEASE-SETUP.md):

    cd ~/apps/marketplace-advanced && node server/scripts/new-agent-key.mjs .env && pm2 restart kadena-advanced-server

## Useful commands (as the PM2 account)

    pm2 logs kadena-advanced-server --lines 50
    sudo deploy-marketplace-advanced          # redeploy main by hand
