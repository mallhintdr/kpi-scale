# Deploying to a VPS

This guide puts the KPI Dashboard on your own Linux VPS:
- with the **current database** (all units, officers, figures, Tameel and litigation records);
- with **your admin account** kept for demos;
- with a **guest link** that opens the dashboard without a password, read-only.

**This VPS already runs other apps.** The steps don't touch them:
- the dashboard uses its own folder (`/opt/kpi`) and its own Docker containers, database and Redis, with none of them exposed outside the VPS;
- it uses one free local port (`WEB_PORT`, chosen in step 3);
- it adds one nginx site file for its own domain or subdomain.

Each command block says where to run it: **on your PC** (Windows PowerShell) or **on the VPS** (over SSH).

---

## 0. What you need

| Item | Notes |
|---|---|
| VPS | Ubuntu 22.04 or 24.04. **At least 2 GB RAM** (4 GB better), 2 CPUs, 40 GB disk. |
| Domain name | Its own domain or **subdomain**, e.g. `kpi.example.com`. Your other apps keep theirs. Point it to the VPS with an A record. If you have no domain yet, use `kpi.<VPS-IP>.sslip.io` (e.g. `kpi.203.0.113.10.sslip.io`). It works without any setup and doesn't clash with your other apps. |
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
# What is already there: memory, swap, disk, Docker, firewall, ports in use
free -h
df -h /
docker --version; docker compose version
ufw status
ss -ltnp
```
Then do only the parts you need:

- **Docker missing:** `curl -fsSL https://get.docker.com | sh`. If `docker --version` works but `docker compose version` fails, run `apt -y install docker-compose-plugin`.
- **No swap on a VPS with 4 GB RAM or less:** the build needs about 1.5 GB more memory while it runs, on top of your other apps.
  ```bash
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ```
- **Firewall:** if `ufw status` says `active`, run `ufw allow 80 && ufw allow 443` (it is probably already allowed for your other sites). If it says `inactive`, **leave it off**. Turning it on now would block your other apps' ports. The dashboard opens no new public ports anyway.
- **Disk:** keep at least 10 GB free for the images and database.

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

**Choose a free local port** for the dashboard. Nginx forwards your domain to it. Check that nothing else uses it (no output means it's free):
```bash
ss -ltn | grep ':8080 '
```
If 8080 is taken, try 8090, 8095 and so on. Then save your choice. Docker reads `/opt/kpi/.env`, which is separate from the app settings below:
```bash
cd /opt/kpi
echo "WEB_PORT=8090" > .env       # your free port
```
Use the same port everywhere this guide says `<WEB_PORT>`.

**App settings**, on the VPS:
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
curl -s localhost:<WEB_PORT>/api/config         # {"singleTenant":true,...,"guest":true}
```

---

## 6. Nginx and HTTPS

Nginx on the VPS receives visitors on ports 80 and 443 and passes them to the dashboard on `localhost:<WEB_PORT>`. Your other sites keep their own files and are not affected. Certbot gets a free Let's Encrypt certificate and renews it automatically.

> Only **add** the new site file below. Don't edit or delete the files for your other apps, and **don't remove the `default` site**.

**On the VPS**, install certbot if you don't have it (nginx is already installed for your other apps):
```bash
certbot --version || apt -y install certbot python3-certbot-nginx
```

Create the site file (replace `kpi.example.com` with your domain and `<WEB_PORT>` with your port):
```bash
cat > /etc/nginx/sites-available/kpi <<'EOF'
server {
    listen 80;
    server_name kpi.example.com;

    client_max_body_size 20m;          # litigation documents and imports

    location / {
        proxy_pass http://127.0.0.1:<WEB_PORT>;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;       # large Excel / PDF downloads
    }
}
EOF
ln -s /etc/nginx/sites-available/kpi /etc/nginx/sites-enabled/kpi
nginx -t && systemctl reload nginx
```
`nginx -t` must say `syntax is ok` and `test is successful`.

Get the certificate. Name only this domain, so certbot changes only the new site file. It adds HTTPS there and redirects `http` to `https`:
```bash
certbot --nginx -d kpi.example.com --redirect -m you@example.com --agree-tos -n
```
Check that automatic renewal works:
```bash
certbot renew --dry-run
```
Open `https://kpi.example.com` in your browser.

If certbot fails:
- check that the domain points to this VPS (`ping kpi.example.com` shows the VPS IP);
- check that ports 80 and 443 are open (`ufw status`);
- check that this domain isn't already used by `server_name` in another site file: `grep -rn "kpi.example.com" /etc/nginx/sites-enabled/` should list only `kpi`.

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
| `502 Bad Gateway` | The app is still starting or has crashed. Check `docker compose ps` and `docker compose logs api`. Nginx errors are in `/var/log/nginx/error.log`. |
| `413 Request Entity Too Large` on upload | `client_max_body_size 20m;` is missing from `/etc/nginx/sites-available/kpi`. Add it, then `nginx -t && systemctl reload nginx`. |
| The domain opens one of your **other** apps, or the "Welcome to nginx" page | `server_name` in `/etc/nginx/sites-available/kpi` doesn't exactly match the domain you typed, or the `kpi` link in `sites-enabled` is missing. Fix it, then `nginx -t && systemctl reload nginx`. |
| `docker compose up` says "port is already allocated" | `WEB_PORT` is used by another app. Pick another free port in `/opt/kpi/.env`, update `proxy_pass` in the nginx file, then `docker compose up -d` and reload nginx. |
| Build stops with "killed" | Out of memory. Check that swap is on (`free -h`, step 1). |
| Uploads fail for big documents | The limit is 10 MB per document. Photos are compressed on the phone before upload. |
