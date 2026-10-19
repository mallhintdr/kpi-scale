# Deploying to the VPS (PM2 + nginx)

This guide puts the KPI Dashboard on your VPS the same way your other apps run: **Node under PM2**, served by **your existing nginx**, using **your existing MongoDB and Redis**.

You end up with:
- the **current database** (all units, officers, figures, Tameel and litigation records), as its own database `kpi_dashboard`;
- **your admin account** (`admin@bwp.test`) for demos;
- a **guest link**, `https://kpi-bwp.naqsha-zameen.pk/guest`, that opens the dashboard read-only without a password.

The dashboard will be at **https://kpi-bwp.naqsha-zameen.pk**.

**Your other apps are not touched.**
- The dashboard lives in `/var/www/kpi-bwp`.
- It uses its own database name, its own Redis database number and its own PM2 processes (`kpi-api`, `kpi-worker`).
- It runs on the Node already installed (v20.18), so nothing changes for your other apps.
- Its API listens on a free port (4100), on `127.0.0.1` only.
- It adds one new nginx site file for its own domain.

Each command block says where to run it: **on your PC** (Windows PowerShell) or **on the VPS** (over SSH as root).

---

## 0. What you need

| Item | Notes |
|---|---|
| Domain | **`kpi-bwp.naqsha-zameen.pk`**. In the DNS of `naqsha-zameen.pk`, add an **A record**: name `kpi-bwp`, value = the VPS IP. Check from your PC with `nslookup kpi-bwp.naqsha-zameen.pk`; it must show the VPS IP before step 6. |
| GitHub access | The code is at `github.com/mallhintdr/kpi-scale`. If the repository is private, create a **Personal Access Token** (GitHub › Settings › Developer settings › Tokens, scope *repo*). Use it as the password when cloning. |
| Database copy | `D:\KPI Dashboard\deploy-backup\kpi.gz` on your PC (step 4). |

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
| `node -v` is **v20.18 or higher** | Nothing. The dashboard runs on the server's own Node; nothing is installed or changed for your other apps. (Tested on v20.18.1: the full automated test suite and both builds.) |
| `node -v` is lower than v20.18 | Tell me before going on. |
| `mongorestore: command not found` | `apt -y install mongodb-database-tools`. If that package isn't found, install the "MongoDB Database Tools" `.deb` for Ubuntu from mongodb.com/try/download/database-tools, then `apt -y install ./mongodb-database-tools-*.deb`. |
| `maxmemory-policy` is `noeviction` | Good. That's the Redis default. |
| `maxmemory-policy` is anything else | Tell me. The dashboard's job queue needs `noeviction`, and changing it affects your other apps, so we'd decide together. Usually the dashboard is then given its own small Redis. |
| Less than 1 GB memory free | The build may run out of memory. Add swap first (see Troubleshooting). |

---

## 2. Get the code

**On the VPS**:
```bash
mkdir -p /var/www
cd /var/www
git clone https://github.com/mallhintdr/kpi-scale.git kpi-bwp
cd /var/www/kpi-bwp
```
If asked, enter your GitHub username, then the access token as the password.

---

## 3. Settings and build

### 3.1 Choose free slots
```bash
ss -ltn | grep ':4100 '                                          # no output = port 4100 is free
mongosh --quiet --eval 'db.getMongo().getDBNames()'              # "kpi_dashboard" must NOT be in the list
for n in 1 2 3 4 5; do echo "redis db $n: $(redis-cli -n $n dbsize)"; done   # pick a number showing 0
```
- If 4100 is taken, use 4110, 4120 and so on.
- If Redis db 1 isn't empty, use the first number that shows `0`.
- Use your choices wherever this guide says `4100` and `/1`.

If `mongosh` asks for a password, your MongoDB has authentication on. See *MongoDB with a password* at the end of this guide.

### 3.2 App settings
```bash
cd /var/www/kpi-bwp/server
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
CORS_ORIGINS=https://kpi-bwp.naqsha-zameen.pk
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

### 3.3 Build
```bash
cd /var/www/kpi-bwp/server && npm ci && npm run build
cd /var/www/kpi-bwp/web && npm ci && npm run build
```
The server build creates `/var/www/kpi-bwp/server/dist`, and the website build creates `/var/www/kpi-bwp/web/dist`. Together they take 2–5 minutes.

---

## 4. Load the database

**On your PC.** Make a fresh copy, so it includes your latest changes, then upload it:
```powershell
cd "D:\KPI Dashboard"
& "C:\Program Files\MongoDB\Tools\100\bin\mongodump.exe" --uri mongodb://127.0.0.1:27017/kpi_dashboard --archive=deploy-backup\kpi.gz --gzip
scp deploy-backup\kpi.gz root@<VPS-IP>:/var/www/kpi-bwp/kpi.gz
```

**On the VPS.** Restore into the new `kpi_dashboard` database only:
```bash
cd /var/www/kpi-bwp
mongorestore --uri mongodb://127.0.0.1:27017 --archive=kpi.gz --gzip --nsInclude='kpi_dashboard.*'
```
It should end with `… documents restored successfully`.

`--nsInclude` limits the restore to `kpi_dashboard`, so your other apps' databases can't be affected. Don't add `--drop` on this first restore.

Then update the database indexes:
```bash
cd /var/www/kpi-bwp/server && node dist/migrate.js
```

---

## 5. Start with PM2

**On the VPS**:
```bash
cd /var/www/kpi-bwp
pm2 start ecosystem.config.cjs           # runs with the server's own node
pm2 save
pm2 ls                                   # kpi-api and kpi-worker: "online"
curl -s localhost:4100/api/config        # {"singleTenant":true,...,"guest":true}
```
`pm2 save` makes the dashboard start again after a reboot, together with your other apps. If PM2 wasn't already set to start at boot, run `pm2 startup` once and follow its instruction.

---

## 6. Nginx site and HTTPS

Your nginx keeps serving your other apps. Here you **add** one new site file. Don't edit or delete the existing ones.

**On the VPS**, create the site file. Change `4100` only if you chose another port in step 3.1:
```bash
cat > /etc/nginx/sites-available/kpi <<'EOF'
server {
    listen 80;
    server_name kpi-bwp.naqsha-zameen.pk;

    root /var/www/kpi-bwp/web/dist;
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
chmod o+x /var/www /var/www/kpi-bwp /var/www/kpi-bwp/web    # nginx must be able to read the website folder
nginx -t && systemctl reload nginx
```
`nginx -t` must report `syntax is ok` and `test is successful`. If it doesn't, nothing is reloaded and your other sites keep running.

Add HTTPS. Certbot changes only this domain's file:
```bash
certbot --version || apt -y install certbot python3-certbot-nginx
certbot --nginx -d kpi-bwp.naqsha-zameen.pk --redirect -m <your-email> --agree-tos -n
certbot renew --dry-run
```
Then open `https://kpi-bwp.naqsha-zameen.pk`.

---

## 7. Accounts: admin, guest link, test passwords

| Purpose | How |
|---|---|
| **Your admin / demo account** | `https://kpi-bwp.naqsha-zameen.pk/login` with `admin@bwp.test`. |
| **Guest link** (share this) | `https://kpi-bwp.naqsha-zameen.pk/guest`: opens the dashboard straight away, no password. |
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

## 8. Daily backups

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

## 9. Updating to a new version

**On the VPS**:
```bash
cd /var/www/kpi-bwp && git pull
cd server && npm ci && npm run build && node dist/migrate.js
cd ../web && npm ci && npm run build
pm2 restart kpi-api kpi-worker
```
The data is kept. `migrate.js` only updates indexes.

---

## 10. Everyday commands (on the VPS)

| Task | Command |
|---|---|
| Status | `pm2 ls` |
| API errors | `pm2 logs kpi-api --lines 100` |
| Worker (reminders, jobs) | `pm2 logs kpi-worker --lines 100` |
| Restart the dashboard | `pm2 restart kpi-api kpi-worker` |
| Stop the dashboard only | `pm2 stop kpi-api kpi-worker` |
| Turn the guest link off | Clear `GUEST_EMAIL=` in `/var/www/kpi-bwp/server/.env`, then `pm2 restart kpi-api` |
| Nginx errors | `tail -50 /var/log/nginx/error.log` |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Signed out on every reload | The site is opened over `http://`. Use `https://` (step 6). |
| "Invalid email or password" for every account | The database wasn't restored into `kpi_dashboard`. Repeat step 4, then `pm2 restart kpi-api`. |
| Guest link says "Guest account not found" | `GUEST_EMAIL` doesn't match an active account. Fix `/var/www/kpi-bwp/server/.env`, then `pm2 restart kpi-api`. |
| `502 Bad Gateway` | The API isn't running, or nginx points to the wrong port. Check `pm2 logs kpi-api` and that `PORT` in `.env` matches `proxy_pass`. |
| `500` or a blank page, with nginx error "Permission denied" | Run `chmod o+x /var/www /var/www/kpi-bwp /var/www/kpi-bwp/web`, then `chmod -R o+r /var/www/kpi-bwp/web/dist`. |
| `413 Request Entity Too Large` on upload | `client_max_body_size 20m;` is missing from `/etc/nginx/sites-available/kpi`. |
| The domain opens one of your other apps | `server_name` doesn't exactly match the domain, or the `sites-enabled/kpi` link is missing. Fix it, then `nginx -t && systemctl reload nginx`. |
| `kpi-api` keeps restarting with `SyntaxError` / "Unexpected token" | The Node in use is older than v20.18 (`node -v`). Send me the output of `pm2 logs kpi-api --lines 30`. |
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

---

## Quick update script

After the first setup, every update is one command. **On the VPS**:
```bash
bash /kpi-bwp/update.sh
```
Or **from your PC**:
```powershell
ssh root@<VPS-IP> "bash /kpi-bwp/update.sh"
```
It pulls the code, builds the backend, updates the database (`migrate.js`), builds the frontend, restarts `kpi-api` and `kpi-worker`, and checks the API answers. It stops at the first error, so a failed build never restarts the app with broken code. If there is nothing new on GitHub it stops straight away; `bash /kpi-bwp/update.sh --force` rebuilds anyway.
