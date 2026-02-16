---
name: dcp
description: Deploy, Commit & Push — deploys the current project to VPS, commits all changes, and pushes to remote.
argument-hint: [project-name]
allowed-tools: Bash, Read, Glob, Grep
---

# Deploy, Commit & Push

Run the full ship cycle: deploy to VPS, commit changes, push to GitHub.

## Steps

### 1. Detect project

Determine which project to deploy from context:
- If an argument is provided (e.g. `/dcp VAULT`), use that project name
- Otherwise, infer from recent file changes or the current working context
- Valid projects with deploy scripts: `VAULT`, `AXIOM_v2`

Map to deploy directory:
- `VAULT` → `projects/VAULT/deploy/deploy.sh`
- `AXIOM_v2` → `projects/AXIOM_v2/deploy/deploy.sh`

If the project can't be determined, ask which project to deploy.

### 2. Deploy

Run the project's deploy script:
```bash
cd projects/<PROJECT> && bash deploy/deploy.sh
```

Wait for completion. If the deploy fails, stop and report the error — do NOT commit or push broken code.

After deploy, verify the service is healthy:
- **VAULT**: `ssh hq@89.167.4.126 'curl -s localhost:3200/api/v1/status'` — check `alive: true`
- **AXIOM_v2**: `ssh hq@89.167.4.126 'export PATH=$PATH:/home/hq/.nvm/versions/node/v22.22.0/bin && pm2 show axiom2-api'` — check status online

### 3. Commit

Check `git status` for uncommitted changes. If there are changes:
- Stage all modified/new files relevant to the project (use specific file paths, not `git add .`)
- Write a concise commit message summarising the changes
- Commit with `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`

If the working tree is already clean, skip this step.

### 4. Push

```bash
git push
```

### 5. Report

Print a summary:
- Deploy status (success/fail)
- Service health check result
- Commit hash (if committed)
- Push status

$ARGUMENTS
