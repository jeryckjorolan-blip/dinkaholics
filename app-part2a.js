
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
  if (req.body.rememberMe === 'on' || req.body.rememberMe === '1') {
    req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
  } else {
    req.session.cookie.expires = false;
  }
  res.redirect('/');
});
app.post('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

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
  const { title, notes, location, event_date, event_time, max_players, entry_fee, cash_prize, winner_slots } = req.body;
  const slots = Math.max(1, Math.min(10, parseInt(winner_slots) || 2));
  const maxP = max_players ? parseInt(max_players) : null;
  db.prepare(`INSERT INTO games (title, status, notes, created_by, location, event_date, event_time, max_players, entry_fee, cash_prize, winner_slots)
    VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    title || 'WTA Game', notes || null, req.session.userId,
    location || null, event_date || null, event_time || null,
    maxP, entry_fee || null, cash_prize || null, slots
  );
  res.redirect('/wta?msg=Game+posted!');
});

app.post('/games/:id/join', requireAuth, (req, res) => {
  const gameId = req.params.id;
  const game = db.prepare('SELECT * FROM games WHERE id = ? AND status = ?').get(gameId, 'open');
  if (!game) return res.redirect('/wta?error=Game+not+found+or+already+started');
  let player = db.prepare('SELECT id FROM players WHERE user_id = ? AND active = 1').get(req.session.userId);
  if (!player) {
    const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.session.userId);
    if (user) player = db.prepare('SELECT id FROM players WHERE name = ? AND active = 1').get(user.display_name);
  }
  if (!player) return res.redirect('/wta?error=No+player+profile+linked.+Ask+an+admin.');
  const existing = db.prepare('SELECT id FROM game_scores WHERE game_id = ? AND player_id = ?').get(gameId, player.id);
  if (existing) return res.redirect('/wta?msg=Already+joined');
  if (game.max_players) {
    const count = db.prepare('SELECT COUNT(*) as c FROM game_scores WHERE game_id = ?').get(gameId).c;
    if (count >= game.max_players) return res.redirect('/wta?error=Game+is+full');
  }
  db.prepare('INSERT INTO game_scores (game_id, player_id, score) VALUES (?, ?, 0)').run(gameId, player.id);
  res.redirect('/wta?msg=Joined!');
});

app.post('/games/:id/leave', requireAuth, (req, res) => {
  const gameId = req.params.id;
  const game = db.prepare('SELECT * FROM games WHERE id = ? AND status = ?').get(gameId, 'open');
  if (!game) return res.redirect('/wta');
  const player = db.prepare('SELECT id FROM players WHERE user_id = ?').get(req.session.userId);
  if (player) db.prepare('DELETE FROM game_scores WHERE game_id = ? AND player_id = ?').run(gameId, player.id);
  res.redirect('/wta?msg=Left+game');
});

app.post('/games/:id/start', requireAuth, requireAdmin, (req, res) => {
  const gameId = req.params.id;
  const game = db.prepare('SELECT * FROM games WHERE id = ? AND status = ?').get(gameId, 'open');
  if (!game) return res.redirect('/wta?error=Game+not+found');
  const count = db.prepare('SELECT COUNT(*) as c FROM game_scores WHERE game_id = ?').get(gameId).c;
  if (count < 2) return res.redirect('/wta?error=Need+at+least+2+players+to+start');
  db.prepare('UPDATE games SET status = ? WHERE id = ?').run('live', gameId);
  res.redirect('/live?msg=Game+started!');
});

app.post('/games/:id/shuffle', requireAuth, requireAdmin, (req, res) => {
  const gameId = req.params.id;
  const game = db.prepare("SELECT * FROM games WHERE id = ? AND status = 'open'").get(gameId);
  if (!game) return res.redirect('/wta?error=Game+not+found+or+already+started');
  const scores = db.prepare('SELECT * FROM game_scores WHERE game_id = ?').all(gameId);
  if (scores.length < 2) return res.redirect('/wta?error=Need+at+least+2+players+to+shuffle');
  const arr = scores.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const update = db.prepare('UPDATE game_scores SET notes = ? WHERE id = ?');
  arr.forEach((s, i) => {
    const teamNum = Math.floor(i / 2) + 1;
    update.run('team:' + teamNum, s.id);
  });
  const leftover = arr.length % 2 === 1 ? '+1+waiting' : '';
  res.redirect('/wta?msg=Teams+shuffled' + leftover);
});

app.post('/games/:id/cancel-open', requireAuth, requireAdmin, (req, res) => {
  const gameId = req.params.id;
  db.prepare('DELETE FROM game_scores WHERE game_id = ?').run(gameId);
  db.prepare('UPDATE games SET status = ? WHERE id = ? AND status = ?').run('cancelled', gameId, 'open');
  res.redirect('/wta?msg=Game+cancelled');
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
