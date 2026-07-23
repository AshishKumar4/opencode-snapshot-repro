# OpenCode Snapshot Hang Reproduction

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/AshishKumar4/opencode-snapshots-bug)

Minimal, deterministic reproduction of an OpenCode session blocked indefinitely by filesystem snapshot staging inside a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/).

## One-click reproduction

Prerequisite: [Cloudflare Containers](https://developers.cloudflare.com/containers/) requires a Workers Paid plan.

1. Click **Deploy to Cloudflare** above.
2. Choose a long random value for `REPRO_TOKEN` when prompted.
3. Wait for the Worker and container image deployment to finish. Initial container provisioning can take a few minutes.
4. Open the deployed Worker URL. See [Finding the app URL](#finding-the-app-url) if the dashboard says **No URLs enabled**.
5. Enter the same `REPRO_TOKEN` in the page.
6. Click **Setup repository**, then **Start reproduction**.

The page polls automatically. A successful reproduction shows:

- the OpenCode session remains `busy`;
- the live process table contains OpenCode's private snapshot command:

  ```text
  git ... --git-dir .../snapshot/... --work-tree /workspace add --all --sparse --pathspec-from-file=- --pathspec-file-nul
  ```

- `snapshotGitLog` records the same intercepted command;
- CPU, memory, disk, PID count, generated files, and process data update in place.

Click **Destroy sandbox** after testing so the container is not left running.

## Finding the app URL

Cloudflare accounts can have the permanent `workers.dev` route disabled. The Deploy Button cannot override that account-level setting.

If the Worker overview says **No URLs enabled**:

1. Open the Worker's **Domains** tab.
2. Enable the `workers.dev` route to get a permanent URL.

The template also enables version preview URLs. To use one without changing the permanent route:

1. Open **Deployments**.
2. Select the latest successful version or **View build**.
3. Open its preview URL.

Deploy Button creates a copy of this repository in your Git provider account. Existing copies do not receive later template updates automatically. If your copied repository predates preview URL support or the diagnostic dashboard, deploy from the button again or pull the latest files from this repository.

## Diagnostic dashboard

The deployed page includes:

- the OpenCode session state with automatic polling;
- every live OS process in the container, including PID, parent PID, age, CPU, RSS, state, and full command;
- Sandbox SDK managed-process state;
- live cgroup CPU, memory, and PID readings;
- live filesystem capacity and usage;
- the exact intercepted snapshot Git command;
- one-click sandbox teardown.

These are instantaneous readings collected from the live container through the Sandbox SDK. Seal Admin's historical percentile charts use Cloudflare's account-level GraphQL analytics API, which would require an additional account API token and is intentionally not part of this public reproduction.

## What this proves

The image pins:

- `@cloudflare/sandbox` `0.12.1`;
- OpenCode CLI `1.17.4`;
- `@opencode-ai/sdk` `1.15.13`.

The container installs a narrow fault-injection wrapper in front of Git. Every Git operation passes through unchanged except OpenCode's private snapshot staging command, which logs its exact arguments and sleeps. This isolates the liveness bug: OpenCode has no deadline around `Snapshot.track`, so one slow or stuck `git add` leaves the session busy indefinitely.

No model credential is required. The configured provider points to an unreachable loopback address; snapshot staging happens before the provider request.

## Manual deployment

```bash
git clone https://github.com/AshishKumar4/opencode-snapshots-bug.git
cd opencode-snapshots-bug
pnpm install
cp .dev.vars.example .dev.vars
# Replace the placeholder REPRO_TOKEN in .dev.vars.
pnpm types
pnpm typecheck
pnpm run deploy
pnpm exec wrangler secret put REPRO_TOKEN
```

Run the secret command after the first deploy. The Deploy Button configures the secret during its setup flow from `.dev.vars.example`.

Docker must be running for a manual container deployment. See the [Containers deployment guide](https://developers.cloudflare.com/containers/get-started/).

## Command-line reproduction

```bash
export REPRO_URL="https://<your-worker>.<your-subdomain>.workers.dev"
export REPRO_TOKEN="<the-token-entered-during-deployment>"

curl -fsS -X POST "$REPRO_URL/setup?files=1000" \
  -H "Authorization: Bearer $REPRO_TOKEN"

SESSION_ID=$(curl -fsS -X POST "$REPRO_URL/start" \
  -H "Authorization: Bearer $REPRO_TOKEN" | jq -r .sessionId)

curl -fsS "$REPRO_URL/status?session=$SESSION_ID" \
  -H "Authorization: Bearer $REPRO_TOKEN" | jq

curl -fsS -X POST "$REPRO_URL/reset" \
  -H "Authorization: Bearer $REPRO_TOKEN"
```

The protected API is intentionally small:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/setup?files=1000` | Create a clean Git repository and generated files |
| `POST` | `/start` | Start OpenCode and enqueue the prompt |
| `GET` | `/status?session=...` | Inspect session and process state |
| `POST` | `/reset` | Destroy the sandbox |
