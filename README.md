# 🍺 Dinkaholics Club Tracker

Web app for tracking **Winners Take All** games, scores, wins, and rankings.

## Features

- Login required (club members only)
- Leaderboard (wins → total score → win rate)
- **Open WTA games** — admins post, members click **Join**
- Live scoring — update scores in real time, finish & auto-declare winners
- Admin panel — users, players, manual game entry
- Game history & player profiles

## Tech

- Node.js + Express
- SQLite (`node:sqlite` — built into Node 22+)
- EJS + Tailwind CDN
- Session auth with scrypt password hashing

## Local run

```bash
npm install
node server.js
```

Open http://localhost:3000  
**admin / admin123** — change this after first login.

Requires **Node 22+** (for `node:sqlite`).

---

## Deploy on Railway

### 1. This repo is ready

Push is already done — connect this repo on Railway.

### 2. Create Railway project

1. Go to [railway.app](https://railway.app) → **New Project**
2. **Deploy from GitHub repo** → select `dinkaholics`
3. Railway detects Node and uses `npm start`

### 3. Environment variables

In Railway → your service → **Variables**, add:

| Variable | Value |
|----------|--------|
| `SESSION_SECRET` | a long random string (e.g. run `openssl rand -hex 32`) |
| `NODE_ENV` | `production` |

Optional (for persistent volume — see step 4):

| Variable | Value |
|----------|--------|
| `DATABASE_PATH` | `/data/dinkaholics.db` |

### 4. Persistent volume (keep scores after restarts)

1. Railway → service → **Settings** → **Volumes**
2. Add volume, mount path: `/data`
3. Set env var: `DATABASE_PATH=/data/dinkaholics.db`

Without a volume, the database lives on the container disk and is **wiped on redeploy**.

### 5. Generate domain

Railway → **Settings** → **Networking** → **Generate Domain**  
You’ll get something like `https://dinkaholics-production.up.railway.app`

### 6. First login

- Username: `admin`
- Password: `admin123`

**Immediately** create a new admin user in Admin panel and delete the default one (or change the password by creating a new account).

### Notes

- Start command: `node server.js` (already in `package.json`)
- Port: Railway sets `PORT` automatically — the app reads it
- Node version: set to **22** or **24** in Railway settings if needed (Settings → Build → Node version)

---

## How members use it

1. Log in
2. **Live Scoring** → see open WTA games → **Join Game**
3. Admin clicks **Start Live** when enough players joined
4. Update scores → **Finish & Declare Winners**
5. Check **Leaderboard** and **History**

## Ranking

1. Wins (desc)
2. Total score
3. Win rate %

Only **completed** games count.
