
app.post('/live/:id/score', requireAuth, (req, res) => {
  const gameId = req.params.id;
  const game = db.prepare('SELECT * FROM games WHERE id = ? AND status = ?').get(gameId, 'live');
  if (!game) return res.status(404).send('Live game not found');
  const scores = req.body.scores || {};
  const update = db.prepare('UPDATE game_scores SET score = ? WHERE game_id = ? AND player_id = ?');
  for (const [pid, score] of Object.entries(scores)) update.run(parseInt(score) || 0, gameId, pid);
  res.redirect('/live');
});

app.post('/live/:id/finish', requireAuth, (req, res) => {
  const gameId = req.params.id;
  const game = db.prepare('SELECT * FROM games WHERE id = ? AND status = ?').get(gameId, 'live');
  if (!game) return res.redirect('/live');
  const scores = db.prepare('SELECT * FROM game_scores WHERE game_id = ?').all(gameId);
  if (scores.length === 0) return res.redirect('/live');
  const maxScore = Math.max(...scores.map(s => s.score));
  const updateWinner = db.prepare('UPDATE game_scores SET is_winner = ? WHERE id = ?');
  scores.forEach(s => updateWinner.run(s.score === maxScore && maxScore > 0 ? 1 : 0, s.id));
  db.prepare('UPDATE games SET status = ? WHERE id = ?').run('completed', gameId);
  res.redirect('/?msg=Game+finished');
});

app.post('/live/:id/cancel', requireAuth, (req, res) => {
  const gameId = req.params.id;
  db.prepare('DELETE FROM game_scores WHERE game_id = ?').run(gameId);
  db.prepare('UPDATE games SET status = ? WHERE id = ?').run('cancelled', gameId);
  res.redirect('/live');
});

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, status, created_at FROM users ORDER BY created_at DESC').all();
  const players = db.prepare('SELECT p.*, u.username FROM players p LEFT JOIN users u ON p.user_id = u.id ORDER BY p.name').all();
  const games = db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM game_scores WHERE game_id = g.id) as player_count FROM games g ORDER BY g.game_date DESC LIMIT 50`).all();
  const pendingUsers = users.filter(u => u.status === 'pending');
  res.render('admin', { users, players, games, pendingUsers, title: 'Admin Panel', message: req.query.msg || null });
});

app.post('/admin/users/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (user && user.status === 'pending') {
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user.id);
    try {
      db.prepare('INSERT INTO players (name, user_id) VALUES (?, ?)').run(user.display_name, user.id);
    } catch (e) {}
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

app.post('/admin/players/:id/delete', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM game_scores WHERE player_id = ?').run(req.params.id);
  db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id);
  res.redirect('/admin?msg=Player+deleted');
});

app.get('/history', requireAuth, (req, res) => {
  const games = db.prepare(`SELECT g.*, u.display_name as created_by_name,
    (SELECT GROUP_CONCAT(p.name || ' (' || gs.score || ')' || CASE WHEN gs.is_winner = 1 THEN ' *' ELSE '' END, ', ')
     FROM game_scores gs JOIN players p ON gs.player_id = p.id WHERE gs.game_id = g.id) as participants
    FROM games g LEFT JOIN users u ON g.created_by = u.id
    WHERE g.status = 'completed' ORDER BY g.game_date DESC LIMIT 100`).all();
  res.render('history', { games, title: 'Game History' });
});

app.get('/player/:id', requireAuth, (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!player) return res.status(404).send('Player not found');
  const stats = db.prepare(`SELECT COUNT(DISTINCT CASE WHEN gs.is_winner = 1 THEN gs.game_id END) as wins, COUNT(DISTINCT gs.game_id) as games_played, COALESCE(SUM(gs.score), 0) as total_score, COALESCE(AVG(gs.score), 0) as avg_score FROM game_scores gs JOIN games g ON gs.game_id = g.id AND g.status = 'completed' WHERE gs.player_id = ?`).get(player.id);
  const recent = db.prepare(`SELECT g.title, g.game_date, gs.score, gs.is_winner FROM game_scores gs JOIN games g ON gs.game_id = g.id WHERE gs.player_id = ? AND g.status = 'completed' ORDER BY g.game_date DESC LIMIT 20`).all(player.id);
  res.render('player', { player, stats, recent, title: player.name });
});

app.get('/wta', requireAuth, (req, res) => {
  try {
    let openGames = [];
    try {
      openGames = db.prepare(`SELECT g.*, u.display_name as created_by_name,
        (SELECT COUNT(*) FROM game_scores WHERE game_id = g.id) as player_count
        FROM games g LEFT JOIN users u ON g.created_by = u.id
        WHERE g.status = 'open' ORDER BY g.event_date ASC, g.created_at DESC`).all() || [];
      attachScores(openGames);
    } catch (e) { console.error('wta open', e.message); openGames = []; }
    res.render('wta', {
      openGames,
      title: 'WTA Games',
      msg: req.query.msg || null,
      error: req.query.error || null
    });
  } catch (e) {
    console.error('WTA ERROR:', e);
    res.status(500).send('WTA error: ' + String(e && e.message || e));
  }
});

app.post('/admin/logo', requireAuth, requireAdmin, (req, res) => {
  const { logoData } = req.body;
  if (!logoData || typeof logoData !== 'string' || !logoData.startsWith('data:image/')) {
    return res.redirect('/admin?msg=Invalid+image');
  }
  if (logoData.length > 2_000_000) {
    return res.redirect('/admin?msg=Image+too+large+(max+~1.5MB)');
  }
  setSetting('logo', logoData);
  res.redirect('/admin?msg=Logo+updated!');
});

app.post('/admin/logo/reset', requireAuth, requireAdmin, (req, res) => {
  db.prepare("DELETE FROM settings WHERE key = 'logo'").run();
  res.redirect('/admin?msg=Logo+reset+to+default');
});

app.listen(PORT, () => {
  console.log(`\n🍺 Dinkaholics Club Tracker running at http://localhost:${PORT}`);
  console.log(`   Default login: admin / admin123\n`);
});
