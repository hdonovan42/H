---
name: vps
description: Show VPS health dashboard — CPU, RAM, disk, swap, services, and security status.
argument-hint: [section]
allowed-tools: Bash, Read
---

# VPS Status Dashboard

Connect to the VPS (89.167.4.126) and display a comprehensive health report.

## Connection

```bash
ssh root@89.167.4.126
```

## Sections

If an argument is provided (e.g. `/vps services`), show only that section. Otherwise show all sections.

### 1. System Overview

```bash
ssh root@89.167.4.126 "hostname; uptime; uname -r"
```

Display: hostname, uptime, kernel version, load averages.

### 2. Resources

```bash
ssh root@89.167.4.126 "echo '=CPU='; top -bn1 | head -3; echo '=RAM='; free -h; echo '=SWAP='; swapon --show; echo '=DISK='; df -h / /tmp"
```

Display as a compact table:

| Resource | Used | Total | % |
|----------|------|-------|---|
| CPU | (from load avg) | 2 cores | |
| RAM | x | y | z% |
| Swap | x | y | z% |
| Disk | x | y | z% |

Flag anything above 80% usage.

### 3. Services

```bash
ssh root@89.167.4.126 "su - hq -c 'export PATH=\$PATH:/home/hq/.nvm/versions/node/v22.22.0/bin && pm2 jlist' 2>/dev/null; systemctl is-active moltbot-gateway vault-daemon vault-api 2>/dev/null; systemctl status moltbot-gateway --no-pager -n 3 2>/dev/null"
```

Display each service with status:

| Service | Status | Uptime | Memory |
|---------|--------|--------|--------|
| autosnipe-api | online/stopped | Xd | XXmb |
| axiom2-api | online/stopped | Xd | XXmb |
| moltbot-gateway | active/dead | Xd | XXmb |
| vault-daemon | active/dead | - | - |
| vault-api | active/dead | - | - |

Flag any service that is stopped/dead/erroring.

### 4. WhatsApp Channel

```bash
ssh root@89.167.4.126 "journalctl -u moltbot-gateway --since '30 minutes ago' --no-pager | grep -E 'Listening|closed|exit|error|Error' | tail -10"
```

Report: connection stability (frequent 428/408 = unstable), last successful connection, any channel exits.

### 5. Security

```bash
ssh root@89.167.4.126 "echo '=FAILED SSH='; journalctl -u ssh --since '24 hours ago' --no-pager | grep -c 'Failed password\|Invalid user' 2>/dev/null; echo '=USERS WITH SHELLS='; grep -v nologin /etc/passwd | grep -v /bin/false | grep -v sync; echo '=SUSPICIOUS PROCS='; ps aux --sort=-%cpu | awk '\$3 > 50 {print}' | head -5; echo '=LISTENING PORTS='; ss -tlnp | grep -v '127.0.0' | grep -v '::1'"
```

Report: failed SSH attempts (last 24h), users with login shells, any process using >50% CPU, externally-listening ports.

### 6. Top Processes

```bash
ssh root@89.167.4.126 "ps aux --sort=-%mem | head -8"
```

Show top 5 processes by memory usage.

## Output Format

- Use compact tables and short labels
- Prefix warnings with **WARNING**
- Prefix critical issues with **CRITICAL**
- Keep the entire output under 40 lines
- End with a one-line summary: "VPS healthy" or "VPS has N issue(s)"

$ARGUMENTS
