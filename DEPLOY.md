# Deploying to a VPS

This guide puts the KPI Dashboard on your own Linux VPS:
- with the **current database** (all units, officers, figures, Tameel and litigation records);
- with **your admin account** kept for demos;
- with a **guest link** that opens the dashboard without a password, read-only.

Each command block says where to run it: **on your PC** (Windows PowerShell) or **on the VPS** (over SSH).

---

## 0. What you need

| Item | Notes |
|---|---|
| VPS | Ubuntu 22.04 or 24.04. **At least 2 GB RAM** (4 GB better), 2 CPUs, 40 GB disk. |
| Domain name | E.g. `kpi.example.com`, with an **A record** pointing to the VPS IP. If you have no domain yet, use `<VPS-IP>.sslip.io` (e.g. `203.0.113.10.sslip.io`). It works without any setup. |
| GitHub access | The code is in `github.com/mallhintdr/kpi-scale`. If the repository is private, create a **Personal Access Token** (GitHub › Settings › Developer settings › Tokens, scope *repo*) to use as the password when cloning. |
| Database copy | `deploy-backup\kpi.gz` in the project folder (already created). To refresh it later, see step 4. |

> HTTPS is **required**, not optional. Sign-in keeps a secure cookie that browsers only accept over HTTPS. On plain `http://` users would be signed out on every page reload.

---

## 1. Prepare the VPS

**On your PC**, connect:
```powershell
ssh root@<VPS-IP>
```

**On the VPS**:
```bash
# Updates
apt update && apt -y upgrade

# Swap (lets a 2 GB VPS build the app without running out of memory)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Firewall: only SSH and web
apt -y install ufw
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# Docker
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version
```

---

## 2. Get the code

**On the VPS**:
```bash
cd /opt
git clone https://github.com/mallhintdr/kpi-scale.git kpi
cd /opt/kpi
```
If asked, enter your GitHub username, then the access token as the password.

---

## 3. Settings and secrets

**On the VPS**:
```bash
cd /opt/kpi
cp server/.env.example server/.env.production
# two random secrets: copy each output line
openssl rand -hex 48
openssl rand -hex 48
nano server/.env.production
```
Set these lines and leave the rest as they are. `MONGO_URI` and `REDIS_URL` are filled in by Docker.

```ini
NODE_ENV=production
JWT_ACCESS_SECRET=<first random value>
JWT_REFRESH_SECRET=<second random value>
CORS_ORIGINS=https://kpi.example.com
SINGLE_TENANT=true
DEFAULT_TENANT=bor-bahawalpur
WHATSAPP_MODE=mock

# Guest link: visitors are signed in as this account, read-only
GUEST_EMAIL=commissioner@bwp.test
```
Save with `Ctrl+O`, `Enter`, then `Ctrl+X`.

**Choosing the guest account.**
- `commissioner@bwp.test` shows the whole division: Home, performance, league tables, trends, litigation and so on.
- To show a smaller area, use any other account, such as `dc.bahawalpur@bwp.test`.
- Don't use an admin account. The guest can't change anything either way, but admin menus would still be visible.

---

## 4. Upload the database

**On your PC.** The copy in `deploy-backup\kpi.gz` was taken on 17 Oct 2026. To include changes made since then, make a fresh copy first:
```powershell
cd "D:\KPI Dashboard"
& "C:\Program Files\MongoDB\Tools\100\bin\mongodump.exe" --uri mongodb://127.0.0.1:27017/kpi_dashboard --archive=deploy-backup\kpi.gz --gzip
```
Upload it to the VPS:
```powershell
scp "D:\KPI Dashboard\deploy-backup\kpi.gz" root@<VPS-IP>:/opt/kpi/kpi.gz
```

**On the VPS**, start only the database and load the copy:
```bash
cd /opt/kpi
docker compose up -d mongo
sleep 5
docker compose cp kpi.gz mongo:/kpi.gz
docker compose exec mongo mongorestore --archive=/kpi.gz --gzip --drop
```
The last lines should report `documents restored successfully`.

---

## 5. Start the app

**On the VPS**:
```bash
cd /opt/kpi
docker compose up -d --build
```
The first build takes 5–10 minutes. Then check:
```bash
docker compose ps                         # all "running"; "migrate" shows "exited (0)": that is normal
curl -s localhost:8080/api/config         # {"singleTenant":true,...,"guest":true}
```

---

## 6. HTTPS with Caddy

Caddy gets and renews the certificate automatically.

**On the VPS** (replace the domain):
```bash
apt -y install caddy
cat > /etc/caddy/Caddyfile <<'EOF'
kpi.example.com {
    encode gzip
    reverse_proxy localhost:8080
}
EOF
systemctl reload caddy
```
Open `https://kpi.example.com` in your browser. If the certificate fails, check that the domain points to this VPS (`ping kpi.example.com`) and that ports 80 and 443 are open.

---

## 7. Check the accounts

| Purpose | How |
|---|---|
| **Your admin / demo account** | `https://kpi.example.com/login` with `admin@bwp.test`. |
| **Guest link** (share this) | `https://kpi.example.com/guest`: opens the dashboard straight away, no password. |
| Guest button | The sign-in page also shows **View Demo as Guest**. |

**What a guest can and can't do.**
- Guests can open every page the guest account can see, including Excel and PDF downloads.
- Any attempt to save, enter, import or delete is refused with "Guest view is read-only".
- A yellow banner at the top says "Demo guest view — read-only".
- The guest session ends when the browser is closed.

**Before sharing the link:**
1. **Change the admin password.** Sign in as `admin@bwp.test`, open the profile (your name, top right), then change the password. The copied database still has the test password `Password123` on every account.
2. **Lock down the other test accounts.** Everyone else (`patwari1.hasilpur@bwp.test` and the rest) can still sign in with `Password123`. For a public demo, change their passwords in **People**, or ask me to add a one-off script that resets all passwords except yours.
3. **Clean out litigation test cases** you don't want shown, from the Litigation register.

---

## 8. Daily backups

**On the VPS**:
```bash
mkdir -p /opt/backups
crontab -e
```
Add this line. It runs a backup at 2 am and keeps 14 days:
```
0 2 * * * cd /opt/kpi && docker compose exec -T mongo mongodump --archive --gzip > /opt/backups/kpi-$(date +\%F).gz && find /opt/backups -name 'kpi-*.gz' -mtime +14 -delete
```
Download a backup to your PC now and then. **On your PC**:
```powershell
scp root@<VPS-IP>:/opt/backups/kpi-2026-10-20.gz "D:\KPI Dashboard\deploy-backup\"
```
The backups include the uploaded litigation documents.

To restore a backup **on the VPS**:
```bash
docker compose cp /opt/backups/kpi-2026-10-20.gz mongo:/r.gz
docker compose exec mongo mongorestore --archive=/r.gz --gzip --drop
docker compose restart api worker
```

---

## 9. Updating to a new version

After new changes are pushed to GitHub, run **on the VPS**:
```bash
cd /opt/kpi
git pull
docker compose up -d --build
```
Database indexes are updated automatically, and the data is kept.

---

## 10. Useful commands (on the VPS)

| Task | Command |
|---|---|
| See status | `docker compose ps` |
| API errors | `docker compose logs api --tail 100` |
| Follow logs live | `docker compose logs -f api worker` |
| Restart the app | `docker compose restart api worker web` |
| Stop everything | `docker compose down` (data is kept in Docker volumes) |
| Turn the guest link off | Clear `GUEST_EMAIL=` in `server/.env.production`, then `docker compose up -d` |
| Disk usage | `df -h` and `docker system df` |
| Free space from old builds | `docker image prune -f` |

**Never** run `docker compose down -v`. The `-v` deletes the database volume.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Signed out on every reload | The site is opened over `http://`. Use the `https://` address (step 6). |
| Sign-in says "Invalid email or password" for everyone | The database wasn't restored. Repeat step 4, then `docker compose restart api`. |
| Guest link says "Guest account not found" | `GUEST_EMAIL` doesn't match an active account. Fix it in `.env.production`, then `docker compose up -d`. |
| `502 Bad Gateway` | The app is still starting or has crashed. Check `docker compose ps` and `docker compose logs api`. |
| Build stops with "killed" | Out of memory. Check that swap is on (`free -h`, step 1). |
| Uploads fail for big documents | The limit is 10 MB per document. Photos are compressed on the phone before upload. |
