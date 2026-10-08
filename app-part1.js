const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const methodOverride = require('method-override');

const app = express();
const PORT = process.env.PORT || 3000;

// Database path: use Railway volume via DATABASE_PATH, else local db/
const fs = require('fs');
const dbDir = process.env.DATABASE_PATH
  ? path.dirname(process.env.DATABASE_PATH)
  : path.join(__dirname, 'db');
const dbPath = process.env.DATABASE_PATH || path.join(dbDir, 'dinkaholics.db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');

// Auto-create tables + seed admin on first boot (Railway-friendly)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    user_id INTEGER UNIQUE,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    game_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'completed' CHECK(status IN ('open', 'live', 'completed', 'cancelled')),
    notes TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS game_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    score INTEGER DEFAULT 0,
    is_winner INTEGER DEFAULT 0,
    notes TEXT,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
    UNIQUE(game_id, player_id)
  );
`);

// Migrate: add status column for pending signups
try {
  db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
} catch (e) { /* column already exists */ }

// Migrate: extra WTA game fields
const gameCols = [
  ['location', 'TEXT'],
  ['event_date', 'TEXT'],
  ['event_time', 'TEXT'],
  ['max_players', 'INTEGER'],
  ['entry_fee', 'TEXT'],
  ['cash_prize', 'TEXT'],
  ['winner_slots', 'INTEGER DEFAULT 2']
];
for (const [col, typ] of gameCols) {
  try { db.exec('ALTER TABLE games ADD COLUMN ' + col + ' ' + typ); } catch (e) { /* exists */ }
}

// Settings (e.g. custom logo as data URL)
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');

(function seedIfEmpty() {
  const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!adminExists) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('admin123', salt, 64).toString('hex');
    const result = db.prepare(
      "INSERT INTO users (username, password_hash, display_name, role, status) VALUES (?, ?, ?, 'admin', 'active')"
    ).run('admin', `${salt}:${hash}`, 'Club Admin');
    db.prepare('INSERT INTO players (name, user_id) VALUES (?, ?)').run('Club Admin', result.lastInsertRowid);
    console.log('Default admin created: username=admin  password=admin123');
  }
  const playerCount = db.prepare('SELECT COUNT(*) as c FROM players').get().c;
  if (playerCount <= 1) {
    const samplePlayers = ['Alex', 'Jordan', 'Sam', 'Taylor', 'Casey', 'Riley'];
    const insert = db.prepare('INSERT OR IGNORE INTO players (name) VALUES (?)');
    samplePlayers.forEach(p => insert.run(p));
    console.log('Sample players seeded');
  }
})();

// Behind Railway proxy
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dinkaholics-super-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    // No maxAge by default = session cookie (logs out when browser closes)
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') return res.status(403).send('Admin access required');
  next();
}

function getSetting(key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return (row && row.value) ? row.value : fallback;
  } catch (e) { return fallback; }
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

app.use((req, res, next) => {
  res.locals.currentUser = null;
  res.locals.myPlayerId = null;
  res.locals.clubLogo = getSetting('logo', '/img/logo.svg');
  if (req.session.userId) {
    const user = db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?').get(req.session.userId);
    res.locals.currentUser = user;
    const player = db.prepare('SELECT id FROM players WHERE user_id = ?').get(req.session.userId);
    if (player) res.locals.myPlayerId = player.id;
  }
  next();
});

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const hashVerify = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === hashVerify;
}

function getLeaderboard() {
  return db.prepare(`
    SELECT 
      p.id, p.name,
      COALESCE(s.wins, 0) as wins,
      COALESCE(s.games_played, 0) as games_played,
      COALESCE(s.total_score, 0) as total_score,
      COALESCE(s.win_rate, 0) as win_rate,
      COALESCE(s.avg_score, 0) as avg_score
    FROM players p
    LEFT JOIN (
      SELECT gs.player_id,
        COUNT(DISTINCT CASE WHEN gs.is_winner = 1 THEN gs.game_id END) as wins,
        COUNT(DISTINCT gs.game_id) as games_played,
        SUM(gs.score) as total_score,
        CASE WHEN COUNT(DISTINCT gs.game_id) = 0 THEN 0
          ELSE ROUND(100.0 * COUNT(DISTINCT CASE WHEN gs.is_winner = 1 THEN gs.game_id END) / COUNT(DISTINCT gs.game_id), 1)
        END as win_rate,
        AVG(gs.score) as avg_score
      FROM game_scores gs
      INNER JOIN games g ON gs.game_id = g.id AND g.status = 'completed'
      GROUP BY gs.player_id
    ) s ON p.id = s.player_id
    WHERE p.active = 1
    ORDER BY wins DESC, total_score DESC, win_rate DESC
  `).all();
}

function getRecentGames(limit = 10) {
  return db.prepare(`
    SELECT g.*, u.display_name as created_by_name,
      (SELECT GROUP_CONCAT(p.name || ' (' || gs.score || ')' || CASE WHEN gs.is_winner = 1 THEN ' *' ELSE '' END, ', ')
       FROM game_scores gs JOIN players p ON gs.player_id = p.id WHERE gs.game_id = g.id) as participants
    FROM games g LEFT JOIN users u ON g.created_by = u.id
    WHERE g.status = 'completed' ORDER BY g.game_date DESC LIMIT ?
  `).all(limit);
}

function attachScores(games) {
  if (!games) return [];
  const stmt = db.prepare(`
    SELECT gs.player_id, gs.score, gs.is_winner, gs.notes, p.name as player_name
    FROM game_scores gs JOIN players p ON gs.player_id = p.id
    WHERE gs.game_id = ? ORDER BY gs.notes, p.name
  `);
  games.forEach(g => {
    try {
      g.scores = stmt.all(g.id) || [];
    } catch (e) {
      console.error('attachScores error', g && g.id, e.message);
      g.scores = [];
    }
    g.player_count = g.scores.length;
  });
  return games;
}
