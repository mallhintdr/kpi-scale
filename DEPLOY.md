# Deploying to the VPS (PM2 + nginx)

This guide puts the KPI Dashboard on your VPS the same way your other apps run: **Node under PM2**, served by **your existing nginx**, using **your existing MongoDB and Redis**.

You end up with:
- the **current database** (all units, officers, figures, Tameel and litigation records), as its own database `kpi_dashboard`;
- **your admin account** (`admin@bwp.test`) for demos;
- a **guest link**, `https://<domain>/guest`, that opens the dashboard read-only without a password.

**Your other apps are not touched.**
- The dashboard lives in `/opt/kpi`.
- It uses its own database name, its own Redis database number and its own PM2 processes (`kpi-api`, `kpi-worker`).
- Its API listens on a free port (4100), on `127.0.0.1` only.
- It adds one new nginx site file for its own domain.

Each command block says where to run it: **on your PC** (Windows PowerShell) or **on the VPS** (over SSH as root).

---

## 0. What you need

| Item | Notes |
|---|---|
| Domain | Its own domain or subdomain, e.g. `kpi.example.com`, with an **A record** pointing to the VPS IP. If you have no domain, use `kpi.<VPS-IP>.sslip.io` (e.g. `kpi.203.0.113.10.sslip.io`). It needs no setup. |
| GitHub access | The code is at `github.com/mallhintdr/kpi-scale`. If the repository is private, create a **Personal Access Token** (GitHub › Settings › Developer settings › Tokens, scope *repo*). Use it as the password when cloning. |
| Database copy | `D:\KPI Dashboard\deploy-backup\kpi.gz` on your PC (step 5). |

> **HTTPS is required.** Sign-in keeps a secure cookie that browsers only send over HTTPS. Over plain `http://`, users are signed out on every page reload.

---

## 1. Check what's on the VPS

**On your PC**:
```powershell
ssh root@<VPS-IP>
```
**On the VPS**:
```bash
node -v
pm2 -v
mongod --version | head -1
mongorestore --version | head -1
redis-cli config get maxmemory-policy
free -h && df -h /
```

| Result | What to do |
|---|---|
| `node -v` is **v22 or higher** | Nothing. Skip step 2. |
| `node -v` is lower than v22 | Step 2 installs Node 22 for the dashboard only. Your other apps keep their Node version. |
| `mongorestore: command not found` | `apt -y install mongodb-database-tools`. If that package isn't found, install the "MongoDB Database Tools" `.deb` for Ubuntu from mongodb.com/try/download/database-tools, then `apt -y install ./mongodb-database-tools-*.deb`. |
| `maxmemory-policy` is `noeviction` | Good. That's the Redis default. |
| `maxmemory-policy` is anything else | Tell me. The dashboard's job queue needs `noeviction`, and changing it affects your other apps, so we'd decide together. Usually the dashboard is then given its own small Redis. |
| Less than 1 GB memory free | The build may run out of memory. Add swap first (see Troubleshooting). |

---

## 2. Node 22 for the dashboard (only if `node -v` was lower than v22)

This installs Node 22 alongside your current Node. Your other apps and the `node` command they use stay as they are.

**On the VPS**:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 22
nvm alias default system 2>/dev/null || true   # keep your current node as the default
```
Each time you build the dashboard (steps 4 and 10), first run this line in that SSH session:
```bash
export PATH="$(dirname $(source ~/.nvm/nvm.sh && nvm which 22)):$PATH"; node -v   # must show v22
```

---

## 3. Get the code

**On the VPS**:
```bash
cd /opt
git clone https://github.com/mallhintdr/kpi-scale.git kpi
cd /opt/kpi
```
If asked, enter your GitHub username, then the access token as the password.

---

## 4. Settings and build

### 4.1 Choose free slots
```bash
ss -ltn | grep ':4100 '                                          # no output = port 4100 is free
mongosh --quiet --eval 'db.getMongo().getDBNames()'              # "kpi_dashboard" must NOT be in the list
for n in 1 2 3 4 5; do echo "redis db $n: $(redis-cli -n $n dbsize)"; done   # pick a number showing 0
```
- If 4100 is taken, use 4110, 4120 and so on.
- If Redis db 1 isn't empty, use the first number that shows `0`.
- Use your choices wherever this guide says `4100` and `/1`.

If `mongosh` asks for a password, your MongoDB has authentication on. See *MongoDB with a password* at the end of this guide.

### 4.2 App settings
```bash
cd /opt/kpi/server
cp .env.example .env
openssl rand -hex 48     # copy: first secret
openssl rand -hex 48     # copy: second secret
nano .env
```
Set these lines and leave the rest as they are:
```ini
NODE_ENV=production
PORT=4100
HOST=127.0.0.1
MONGO_URI=mongodb://127.0.0.1:27017/kpi_dashboard
REDIS_URL=redis://127.0.0.1:6379/1
RUN_WORKER=false
JWT_ACCESS_SECRET=<first secret>
JWT_REFRESH_SECRET=<second secret>
CORS_ORIGINS=https://kpi.example.com
SINGLE_TENANT=true
DEFAULT_TENANT=bor-bahawalpur
WHATSAPP_MODE=mock

# Guest link: visitors are signed in as this account, read-only
GUEST_EMAIL=commissioner@bwp.test
```
Save with `Ctrl+O`, `Enter`, then `Ctrl+X`. Then protect the file: `chmod 600 .env`.

What some of these settings do:
- `HOST=127.0.0.1` means the API can only be reached through nginx, not directly from the internet.
- `RUN_WORKER=false` is set because background jobs run in their own PM2 process (`kpi-worker`).
- `GUEST_EMAIL`: `commissioner@bwp.test` shows the whole division. Use e.g. `dc.bahawalpur@bwp.test` to show one district. Don't use an admin account.

### 4.3 Build
(If you did step 2, run its `export PATH=…` line first.)
```bash
cd /opt/kpi/server && npm ci && npm run build
cd /opt/kpi/web && npm ci && npm run build
```
The server build creates `/opt/kpi/server/dist`, and the website build creates `/opt/kpi/web/dist`. Together they take 2–5 minutes.

---

## 5. Load the database

**On your PC.** Make a fresh copy, so it includes your latest changes, then upload it:
```powershell
cd "D:\KPI Dashboard"
& "C:\Program Files\MongoDB\Tools\100\bin\mongodump.exe" --uri mongodb://127.0.0.1:27017/kpi_dashboard --archive=deploy-backup\kpi.gz --gzip
scp deploy-backup\kpi.gz root@<VPS-IP>:/opt/kpi/kpi.gz
```

**On the VPS.** Restore into the new `kpi_dashboard` database only:
```bash
cd /opt/kpi
mongorestore --uri mongodb://127.0.0.1:27017 --archive=kpi.gz --gzip --nsInclude='kpi_dashboard.*'
```
It should end with `… documents restored successfully`.

`--nsInclude` limits the restore to `kpi_dashboard`, so your other apps' databases can't be affected. Don't add `--drop` on this first restore.

Then update the database indexes:
```bash
cd /opt/kpi/server && node dist/migrate.js
```

---

## 6. Start with PM2

**On the VPS**:
```bash
cd /opt/kpi
# Only if you did step 2 (Node 22 alongside your current Node):
export NODE_BIN="$(source ~/.nvm/nvm.sh && nvm which 22)"

pm2 start ecosystem.config.cjs
pm2 save
pm2 ls                                   # kpi-api and kpi-worker: "online"
curl -s localhost:4100/api/config        # {"singleTenant":true,...,"guest":true}
```
`pm2 save` makes the dashboard start again after a reboot, together with your other apps. If PM2 wasn't already set to start at boot, run `pm2 startup` once and follow its instruction.

---

## 7. Nginx site and HTTPS

Your nginx keeps serving your other apps. Here you **add** one new site file. Don't edit or delete the existing ones.

**On the VPS**, create the site file. Replace `kpi.example.com` with your domain, and `4100` if you chose another port:
```bash
cat > /etc/nginx/sites-available/kpi <<'EOF'
server {
    listen 80;
    server_name kpi.example.com;

    root /opt/kpi/web/dist;
    client_max_body_size 20m;              # litigation documents and Excel imports

    # API (Node under PM2)
    location /api/ {
        proxy_pass http://127.0.0.1:4100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;           # large Excel / PDF downloads
    }

    # Website files (built once; long cache for versioned files)
    location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
    location = /sw.js { add_header Cache-Control "no-cache"; }
    location / { try_files $uri /index.html; }
}
EOF
ln -s /etc/nginx/sites-available/kpi /etc/nginx/sites-enabled/kpi
chmod o+x /opt /opt/kpi /opt/kpi/web    # nginx must be able to read the website folder
nginx -t && systemctl reload nginx
```
`nginx -t` must report `syntax is ok` and `test is successful`. If it doesn't, nothing is reloaded and your other sites keep running.

Add HTTPS. Certbot changes only this domain's file:
```bash
certbot --version || apt -y install certbot python3-certbot-nginx
certbot --nginx -d kpi.example.com --redirect -m you@example.com --agree-tos -n
certbot renew --dry-run
```
Then open `https://kpi.example.com`.

---

## 8. Accounts: admin, guest link, test passwords

| Purpose | How |
|---|---|
| **Your admin / demo account** | `https://kpi.example.com/login` with `admin@bwp.test`. |
| **Guest link** (share this) | `https://kpi.example.com/guest`: opens the dashboard straight away, no password. |
| Guest button | The sign-in page also shows **View Demo as Guest**. |

**What a guest can and can't do.**
- A guest sees every page the guest account can see, including Excel and PDF downloads.
- Saving, data entry, imports and deletes are refused with "Guest view is read-only".
- A yellow banner at the top says "Demo guest view — read-only".
- The session ends when the browser is closed.

**Before sharing the link:**
1. **Change the admin password.** Sign in as `admin@bwp.test`, click your name (top right), then change the password. The copied database still has the test password `Password123` on every account.
2. **Lock down the other test accounts.** Everyone else (`patwari1.hasilpur@bwp.test` and the rest) can still sign in with `Password123`. Change those passwords in **People**, or ask for a script that resets all passwords except yours.
3. **Remove litigation test cases** you don't want shown, from the Litigation register.

---

## 9. Daily backups

**On the VPS**:
```bash
mkdir -p /opt/backups
crontab -e
```
Add this line. It backs up at 2 am and keeps 14 days, covering only the dashboard's database:
```
0 2 * * * mongodump --uri mongodb://127.0.0.1:27017/kpi_dashboard --archive=/opt/backups/kpi-$(date +\%F).gz --gzip && find /opt/backups -name 'kpi-*.gz' -mtime +14 -delete
```
The backups include the uploaded litigation documents.

Download a backup to your PC now and then. **On your PC**:
```powershell
scp root@<VPS-IP>:/opt/backups/kpi-2026-10-20.gz "D:\KPI Dashboard\deploy-backup\"
```
To restore a backup **on the VPS**. This replaces only the dashboard's data:
```bash
mongorestore --uri mongodb://127.0.0.1:27017 --archive=/opt/backups/kpi-2026-10-20.gz --gzip --nsInclude='kpi_dashboard.*' --drop
pm2 restart kpi-api kpi-worker
```

---

## 10. Updating to a new version

**On the VPS**. If you did step 2, run its `export PATH=…` line first.
```bash
cd /opt/kpi && git pull
cd server && npm ci && npm run build && node dist/migrate.js
cd ../web && npm ci && npm run build
pm2 restart kpi-api kpi-worker
```
The data is kept. `migrate.js` only updates indexes.

---

## 11. Everyday commands (on the VPS)

| Task | Command |
|---|---|
| Status | `pm2 ls` |
| API errors | `pm2 logs kpi-api --lines 100` |
| Worker (reminders, jobs) | `pm2 logs kpi-worker --lines 100` |
| Restart the dashboard | `pm2 restart kpi-api kpi-worker` |
| Stop the dashboard only | `pm2 stop kpi-api kpi-worker` |
| Turn the guest link off | Clear `GUEST_EMAIL=` in `/opt/kpi/server/.env`, then `pm2 restart kpi-api` |
| Nginx errors | `tail -50 /var/log/nginx/error.log` |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Signed out on every reload | The site is opened over `http://`. Use `https://` (step 7). |
| "Invalid email or password" for every account | The database wasn't restored into `kpi_dashboard`. Repeat step 5, then `pm2 restart kpi-api`. |
| Guest link says "Guest account not found" | `GUEST_EMAIL` doesn't match an active account. Fix `/opt/kpi/server/.env`, then `pm2 restart kpi-api`. |
| `502 Bad Gateway` | The API isn't running, or nginx points to the wrong port. Check `pm2 logs kpi-api` and that `PORT` in `.env` matches `proxy_pass`. |
| `500` or a blank page, with nginx error "Permission denied" | Run `chmod o+x /opt /opt/kpi /opt/kpi/web`, then `chmod -R o+r /opt/kpi/web/dist`. |
| `413 Request Entity Too Large` on upload | `client_max_body_size 20m;` is missing from `/etc/nginx/sites-available/kpi`. |
| The domain opens one of your other apps | `server_name` doesn't exactly match the domain, or the `sites-enabled/kpi` link is missing. Fix it, then `nginx -t && systemctl reload nginx`. |
| `kpi-api` keeps restarting with `SyntaxError` / "Unexpected token" | PM2 is using an old Node. Redo step 6 with `NODE_BIN` set, after `pm2 delete kpi-api kpi-worker`. |
| Build stops with "Killed" | Out of memory. Add swap: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab`, then build again. |

### MongoDB with a password
If your MongoDB requires sign-in, create a user for the dashboard. Use your MongoDB admin login:
```bash
mongosh -u <admin-user> -p --authenticationDatabase admin --eval '
  db.getSiblingDB("kpi_dashboard").createUser({ user: "kpi", pwd: "<strong password>", roles: [{ role: "readWrite", db: "kpi_dashboard" }] })'
```
Then make these changes:
- in `.env`, use `MONGO_URI=mongodb://kpi:<strong password>@127.0.0.1:27017/kpi_dashboard?authSource=kpi_dashboard`;
- add `-u <admin-user> -p --authenticationDatabase admin` to the `mongorestore` and `mongodump` commands above.
