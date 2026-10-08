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

app.use((req, res, next) => {
  res.locals.currentUser = null;
  res.locals.myPlayerId = null;
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
    SELECT gs.player_id, gs.score, gs.is_winner, p.name as player_name
    FROM game_scores gs JOIN players p ON gs.player_id = p.id
    WHERE gs.game_id = ? ORDER BY p.name
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

app.get('/', requireAuth, (req, res) => {
  try {
    const leaderboard = getLeaderboard() || [];
    let recentGames = [];
    try { recentGames = getRecentGames(8) || []; } catch (e) { console.error('recentGames', e.message); }
    let liveGames = [];
    let openGames = [];
    try {
      liveGames = db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM game_scores WHERE game_id = g.id) as player_count FROM games g WHERE status = 'live' ORDER BY created_at DESC`).all() || [];
    } catch (e) { console.error('liveGames', e.message); }
    try {
      openGames = db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM game_scores WHERE game_id = g.id) as player_count, u.display_name as created_by_name FROM games g LEFT JOIN users u ON g.created_by = u.id WHERE status = 'open' ORDER BY created_at DESC`).all() || [];
      attachScores(openGames);
    } catch (e) { console.error('openGames', e.message); openGames = []; }
    res.render('index', { leaderboard, recentGames, liveGames, openGames, title: 'Leaderboard' });
  } catch (e) {
    console.error('HOME ERROR:', e);
    res.status(500).send('Home error: ' + String(e && e.message || e));
  }
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { error: null, title: 'Login' });
});
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.render('login', { error: 'Invalid username or password', title: 'Login' });
  }
  if (user.status === 'pending') {
    return res.render('login', { error: 'Your account is waiting for admin approval. Please check back later.', title: 'Login' });
  }
  if (user.status === 'rejected') {
    return res.render('login', { error: 'Your signup was not approved. Contact an admin.', title: 'Login' });
  }
  req.session.userId = user.id;
  req.session.role = user.role;
  // Remember me: stay logged in for 30 days; otherwise session cookie (logs out when browser closes)
  if (req.body.rememberMe) {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
  } else {
    req.session.cookie.expires = false; // session cookie
  }
  res.redirect('/');
});
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('signup', { error: null, success: null, title: 'Sign Up' });
});
app.post('/signup', (req, res) => {
  const { display_name, username, password } = req.body;
  if (!display_name || !username || !password) {
    return res.render('signup', { error: 'All fields are required', success: null, title: 'Sign Up' });
  }
  if (password.length < 4) {
    return res.render('signup', { error: 'Password must be at least 4 characters', success: null, title: 'Sign Up' });
  }
  const uname = String(username).trim().toLowerCase();
  if (uname.length < 3) {
    return res.render('signup', { error: 'Username must be at least 3 characters', success: null, title: 'Sign Up' });
  }
  try {
    const hash = hashPassword(password);
    db.prepare(
      "INSERT INTO users (username, password_hash, display_name, role, status) VALUES (?, ?, ?, 'member', 'pending')"
    ).run(uname, hash, String(display_name).trim());
    res.render('signup', {
      error: null,
      success: 'Account request submitted! An admin will approve you soon. Tell the group chat you signed up as: ' + uname,
      title: 'Sign Up'
    });
  } catch (e) {
    res.render('signup', { error: 'Username already taken. Try another.', success: null, title: 'Sign Up' });
  }
});

app.post('/games/open', requireAuth, requireAdmin, (req, res) => {
  const { title, notes } = req.body;
  db.prepare("INSERT INTO games (title, status, notes, created_by) VALUES (?, 'open', ?, ?)").run(title || 'WTA Game', notes || null, req.session.userId);
  res.redirect('/live');
});
app.post('/games/:id/join', requireAuth, (req, res) => {
  const game = db.prepare("SELECT * FROM games WHERE id = ? AND status = 'open'").get(req.params.id);
  if (!game) return res.redirect('/live?error=Game+not+found+or+already+started');
  const player = db.prepare('SELECT id FROM players WHERE user_id = ?').get(req.session.userId);
  if (!player) return res.redirect('/live?error=No+player+profile+linked+to+your+account.+Ask+an+admin.');
  const existing = db.prepare('SELECT id FROM game_scores WHERE game_id = ? AND player_id = ?').get(game.id, player.id);
  if (existing) return res.redirect('/live?msg=Already+joined');
  db.prepare('INSERT INTO game_scores (game_id, player_id, score) VALUES (?, ?, 0)').run(game.id, player.id);
  res.redirect('/live?msg=Joined!');
});
app.post('/games/:id/leave', requireAuth, (req, res) => {
  const game = db.prepare("SELECT * FROM games WHERE id = ? AND status = 'open'").get(req.params.id);
  if (!game) return res.redirect('/live');
  const player = db.prepare('SELECT id FROM players WHERE user_id = ?').get(req.session.userId);
  if (player) db.prepare('DELETE FROM game_scores WHERE game_id = ? AND player_id = ?').run(game.id, player.id);
  res.redirect('/live?msg=Left+game');
});
app.post('/games/:id/start', requireAuth, requireAdmin, (req, res) => {
  const game = db.prepare("SELECT * FROM games WHERE id = ? AND status = 'open'").get(req.params.id);
  if (!game) return res.redirect('/live?error=Game+not+found');
  const count = db.prepare('SELECT COUNT(*) as c FROM game_scores WHERE game_id = ?').get(game.id).c;
  if (count < 2) return res.redirect('/live?error=Need+at+least+2+players+to+start');
  db.prepare("UPDATE games SET status = 'live' WHERE id = ?").run(game.id);
  res.redirect('/live?msg=Game+started!');
});
app.post('/games/:id/cancel-open', requireAuth, requireAdmin, (req, res) => {
  const game = db.prepare("SELECT * FROM games WHERE id = ? AND status = 'open'").get(req.params.id);
  if (!game) return res.redirect('/live');
  db.prepare("UPDATE games SET status = 'cancelled' WHERE id = ?").run(game.id);
  res.redirect('/live?msg=Game+cancelled');
});

app.get('/live', requireAuth, (req, res) => {
  try {
    const players = db.prepare('SELECT id, name FROM players WHERE active = 1 ORDER BY name').all() || [];
    let liveGames = [];
    let openGames = [];
    try {
      liveGames = db.prepare(`SELECT g.* FROM games g WHERE status = 'live' ORDER BY created_at DESC`).all() || [];
      attachScores(liveGames);
    } catch (e) { console.error('liveGames', e.message); liveGames = []; }
    try {
      openGames = db.prepare(`SELECT g.*, u.display_name as created_by_name FROM games g LEFT JOIN users u ON g.created_by = u.id WHERE status = 'open' ORDER BY created_at DESC`).all() || [];
      attachScores(openGames);
    } catch (e) { console.error('openGames', e.message); openGames = []; }
    res.render('live', { players, liveGames, openGames, title: 'Live Scoring', msg: req.query.msg || null, error: req.query.error || null });
  } catch (e) {
    console.error('LIVE ERROR:', e);
    res.status(500).send('Live error: ' + String(e && e.message || e));
  }
});

app.post('/live/start', requireAuth, (req, res) => {
  const { title, player_ids } = req.body;
  if (!player_ids || (Array.isArray(player_ids) ? player_ids.length < 2 : true)) return res.redirect('/live?error=Select+at+least+2+players');
  const ids = Array.isArray(player_ids) ? player_ids : [player_ids];
  const result = db.prepare('INSERT INTO games (title, status, created_by) VALUES (?, ?, ?)').run(title || 'Live Game', 'live', req.session.userId);
  const insertScore = db.prepare('INSERT INTO game_scores (game_id, player_id, score) VALUES (?, ?, 0)');
  ids.forEach(pid => insertScore.run(result.lastInsertRowid, pid));
  res.redirect('/live');
});

app.post('/live/:id/score', requireAuth, (req, res) => {
  const { player_id, score } = req.body;
  const game = db.prepare("SELECT * FROM games WHERE id = ? AND status = 'live'").get(req.params.id);
  if (!game) return res.redirect('/live');
  db.prepare('UPDATE game_scores SET score = ? WHERE game_id = ? AND player_id = ?').run(Number(score) || 0, game.id, player_id);
  res.redirect('/live');
});

app.post('/live/:id/finish', requireAuth, (req, res) => {
  const game = db.prepare("SELECT * FROM games WHERE id = ? AND status = 'live'").get(req.params.id);
  if (!game) return res.redirect('/live');
  const scores = db.prepare('SELECT * FROM game_scores WHERE game_id = ?').all(game.id);
  if (scores.length === 0) return res.redirect('/live');
  const maxScore = Math.max(...scores.map(s => s.score));
  scores.forEach(s => {
    db.prepare('UPDATE game_scores SET is_winner = ? WHERE id = ?').run(s.score === maxScore ? 1 : 0, s.id);
  });
  db.prepare("UPDATE games SET status = 'completed' WHERE id = ?").run(game.id);
  res.redirect('/?msg=Game+finished');
});

app.post('/live/:id/cancel', requireAuth, (req, res) => {
  const game = db.prepare("SELECT * FROM games WHERE id = ? AND status = 'live'").get(req.params.id);
  if (game) db.prepare("UPDATE games SET status = 'cancelled' WHERE id = ?").run(game.id);
  res.redirect('/live');
});

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, status, created_at FROM users ORDER BY created_at DESC').all();
  const players = db.prepare('SELECT p.*, u.username FROM players p LEFT JOIN users u ON p.user_id = u.id ORDER BY p.name').all();
  const games = db.prepare("SELECT g.*, u.display_name as created_by_name FROM games g LEFT JOIN users u ON g.created_by = u.id ORDER BY g.created_at DESC LIMIT 50").all();
  const pendingUsers = users.filter(u => u.status === 'pending');
  res.render('admin', { users, players, games, pendingUsers, title: 'Admin Panel', message: req.query.msg || null });
});

app.post('/admin/users/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (user && user.status === 'pending') {
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user.id);
    try {
      db.prepare('INSERT INTO players (name, user_id) VALUES (?, ?)').run(user.display_name, user.id);
    } catch (e) {
      // player name may already exist
    }
    res.redirect('/admin?msg=User+approved');
  } else {
    res.redirect('/admin');
  }
});

app.post('/admin/users/:id/reject', requireAuth, requireAdmin, (req, res) => {
  db.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").run(req.params.id);
  res.redirect('/admin?msg=User+rejected');
});

app.post('/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, display_name, role } = req.body;
  try {
    const hash = hashPassword(password);
    const result = db.prepare("INSERT INTO users (username, password_hash, display_name, role, status) VALUES (?, ?, ?, ?, 'active')").run(username, hash, display_name, role || 'member');
    db.prepare('INSERT INTO players (name, user_id) VALUES (?, ?)').run(display_name, result.lastInsertRowid);
    res.redirect('/admin?msg=User+created');
  } catch (e) { res.redirect('/admin?msg=Username+already+exists'); }
});

app.post('/admin/users/:id/delete', requireAuth, requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.session.userId) return res.redirect('/admin?msg=Cannot+delete+yourself');
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.redirect('/admin?msg=User+deleted');
});

app.post('/admin/players', requireAuth, requireAdmin, (req, res) => {
  const { name } = req.body;
  try {
    db.prepare('INSERT INTO players (name) VALUES (?)').run(name);
    res.redirect('/admin?msg=Player+added');
  } catch (e) { res.redirect('/admin?msg=Player+already+exists'); }
});

app.post('/admin/players/:id/toggle', requireAuth, requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (p) db.prepare('UPDATE players SET active = ? WHERE id = ?').run(p.active ? 0 : 1, p.id);
  res.redirect('/admin');
});

app.post('/admin/games/:id/delete', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM games WHERE id = ?').run(req.params.id);
  res.redirect('/admin?msg=Game+deleted');
});

app.get('/history', requireAuth, (req, res) => {
  const games = db.prepare(`
    SELECT g.*, u.display_name as created_by_name,
      (SELECT GROUP_CONCAT(p.name || ' (' || gs.score || ')' || CASE WHEN gs.is_winner = 1 THEN ' *' ELSE '' END, ', ')
       FROM game_scores gs JOIN players p ON gs.player_id = p.id WHERE gs.game_id = g.id) as participants
    FROM games g LEFT JOIN users u ON g.created_by = u.id
    WHERE g.status = 'completed' ORDER BY g.game_date DESC LIMIT 100
  `).all();
  res.render('history', { games, title: 'Game History' });
});

app.get('/player/:id', requireAuth, (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!player) return res.status(404).send('Player not found');
  const stats = db.prepare(`
    SELECT COUNT(DISTINCT gs.game_id) as games_played,
      COUNT(DISTINCT CASE WHEN gs.is_winner = 1 THEN gs.game_id END) as wins,
      COALESCE(SUM(gs.score), 0) as total_score,
      COALESCE(AVG(gs.score), 0) as avg_score
    FROM game_scores gs
    INNER JOIN games g ON gs.game_id = g.id AND g.status = 'completed'
    WHERE gs.player_id = ?
  `).get(player.id);
  const recent = db.prepare(`
    SELECT g.id, g.title, g.game_date, gs.score, gs.is_winner
    FROM game_scores gs JOIN games g ON gs.game_id = g.id
    WHERE gs.player_id = ? AND g.status = 'completed'
    ORDER BY g.game_date DESC LIMIT 20
  `).all(player.id);
  res.render('player', { player, stats, recent, title: player.name });
});

app.listen(PORT, () => {
  console.log(`Dinkaholics running on port ${PORT}`);
  console.log(`Default login: admin / admin123`);
});
