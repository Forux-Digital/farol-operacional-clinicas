require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3700;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret-change-me';
const CHATWOOT_BASE = process.env.CHATWOOT_BASE_URL || 'https://chatclinics.5ef4kt.easypanel.host';
const JWT_EXPIRY = '24h';

// ── Chatwoot Postgres (credentials from env) ────────────────────
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Account 38 = Sorria Goias (excluida do recorte SP)
const EXCLUDED_ACCOUNTS = [38];

// Bot/IA filter
const BOT_FILTER = "u.email NOT LIKE '%@arvore.ia'";
const BOT_FILTER_CONV = `c.assignee_id NOT IN (SELECT id FROM users WHERE email LIKE '%@arvore.ia')`;

// ── Middleware ────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());

// ── Local managers config ────────────────────────────────────────
function loadManagers() {
  try {
    const data = fs.readFileSync(path.join(__dirname, 'managers.json'), 'utf8');
    return JSON.parse(data).managers || [];
  } catch {
    return [];
  }
}

// ── Auth: Chatwoot sign_in API ───────────────────────────────────
async function chatwootAuth(email, password) {
  try {
    const res = await fetch(`${CHATWOOT_BASE}/auth/sign_in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const data = body.data;
    if (!data) return null;

    // Extract account IDs the user has access to
    const accounts = (data.available_accounts || [])
      .map(a => a.id)
      .filter(id => !EXCLUDED_ACCOUNTS.includes(id));

    const role = (data.available_accounts || []).some(a => a.role === 'administrator')
      ? 'admin' : 'agent';

    return {
      id: data.id,
      name: data.name || email.split('@')[0],
      email: data.email || email,
      accounts,
      role,
      source: 'chatwoot',
    };
  } catch (err) {
    console.error('Chatwoot auth error:', err.message);
    return null;
  }
}

// ── Auth: Local managers ─────────────────────────────────────────
async function localAuth(email, password) {
  const managers = loadManagers();
  const manager = managers.find(m => m.email.toLowerCase() === email.toLowerCase());
  if (!manager) return null;

  const valid = await bcrypt.compare(password, manager.passwordHash);
  if (!valid) return null;

  return {
    id: `local_${manager.email}`,
    name: manager.name,
    email: manager.email,
    accounts: manager.accounts, // [] = all accounts
    role: manager.role || 'manager',
    source: 'local',
  };
}

// ── JWT helpers ──────────────────────────────────────────────────
function createToken(user) {
  return jwt.sign({
    id: user.id,
    name: user.name,
    email: user.email,
    accounts: user.accounts,
    role: user.role,
    source: user.source,
  }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ── Auth middleware ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.farol_token;
  if (!token) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Sessão expirada' });
  }
  req.user = user;
  next();
}

// Helper: get allowed accounts for current user (respects global access)
function getUserAccountFilter(user) {
  // accounts=[] means global access (admin/leader)
  if (!user.accounts || user.accounts.length === 0) {
    return EXCLUDED_ACCOUNTS; // only exclude the global exclusions
  }
  return user.accounts; // return the specific allowed accounts
}

function buildAccountWhere(user, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  if (!user.accounts || user.accounts.length === 0) {
    // Global access — only exclude the excluded accounts
    return `${prefix}account_id NOT IN (${EXCLUDED_ACCOUNTS.join(',')})`;
  }
  // Specific access — only include user's accounts (already excludes 38 since it's never in their list)
  return `${prefix}account_id IN (${user.accounts.join(',')})`;
}

// ══════════════════════════════════════════════════════════════════
// AUTH ENDPOINTS
// ══════════════════════════════════════════════════════════════════

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });
  }

  // Try Chatwoot first, then local
  let user = await chatwootAuth(email, password);
  if (!user) {
    user = await localAuth(email, password);
  }
  if (!user) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  const token = createToken(user);
  res.cookie('farol_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24h
  });

  res.json({
    name: user.name,
    email: user.email,
    role: user.role,
    accountCount: user.accounts.length || 'all',
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('farol_token');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.farol_token;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Sessão expirada' });
  res.json({
    name: user.name,
    email: user.email,
    role: user.role,
    accountCount: user.accounts.length || 'all',
  });
});

// ══════════════════════════════════════════════════════════════════
// STATIC FILES — login page is public, dashboard requires auth
// ══════════════════════════════════════════════════════════════════

// Serve login page without auth
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Health check (no auth)
app.get('/api/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT NOW() as now');
    res.json({ status: 'ok', dbTime: r.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Protect dashboard: redirect to login if not authenticated
app.get('/', (req, res) => {
  const token = req.cookies?.farol_token;
  const user = token ? verifyToken(token) : null;
  if (!user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Static assets (CSS, JS, fonts) — always accessible
app.use('/app.js', express.static(path.join(__dirname, 'public', 'app.js')));
app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // don't auto-serve index.html
}));

// ══════════════════════════════════════════════════════════════════
// DATA API ENDPOINTS (all require auth)
// ══════════════════════════════════════════════════════════════════

// ── GET /api/units ──────────────────────────────────────────────
app.get('/api/units', requireAuth, async (req, res) => {
  try {
    const hoursThreshold = parseInt(req.query.hours) || 48;
    const accountWhere = buildAccountWhere(req.user);

    const query = `
      WITH queue AS (
        SELECT account_id, COUNT(*) as cnt
        FROM conversations
        WHERE status = 0
          AND assignee_id IS NULL
          AND ${accountWhere}
        GROUP BY account_id
      ),
      stalled AS (
        SELECT c.account_id, COUNT(*) as cnt
        FROM conversations c
        WHERE c.status = 0
          AND c.assignee_id IS NOT NULL
          AND ${BOT_FILTER_CONV}
          AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
          AND ${buildAccountWhere(req.user, 'c')}
        GROUP BY c.account_id
      ),
      stalled_ops AS (
        SELECT c.account_id, COUNT(DISTINCT c.assignee_id) as cnt
        FROM conversations c
        WHERE c.status = 0
          AND c.assignee_id IS NOT NULL
          AND ${BOT_FILTER_CONV}
          AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
          AND ${buildAccountWhere(req.user, 'c')}
        GROUP BY c.account_id
      ),
      oldest AS (
        SELECT c.account_id, MIN(COALESCE(c.last_activity_at, c.created_at)) as oldest_at
        FROM conversations c
        WHERE c.status = 0
          AND c.assignee_id IS NOT NULL
          AND ${BOT_FILTER_CONV}
          AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
          AND ${buildAccountWhere(req.user, 'c')}
        GROUP BY c.account_id
      )
      SELECT
        a.id as account_id,
        a.name as account_name,
        COALESCE(q.cnt, 0)::int as queue_count,
        COALESCE(s.cnt, 0)::int as stalled_count,
        COALESCE(so.cnt, 0)::int as stalled_operators,
        o.oldest_at
      FROM accounts a
      LEFT JOIN queue q ON q.account_id = a.id
      LEFT JOIN stalled s ON s.account_id = a.id
      LEFT JOIN stalled_ops so ON so.account_id = a.id
      LEFT JOIN oldest o ON o.account_id = a.id
      WHERE ${accountWhere.replace('account_id', 'a.id')}
      ORDER BY (COALESCE(s.cnt, 0) + COALESCE(q.cnt, 0)) DESC
    `;

    const result = await pool.query(query);
    const units = result.rows.map(row => ({
      ...row,
      chatwootUrl: `${CHATWOOT_BASE}/app/accounts/${row.account_id}/dashboard`,
      status: getStatus(row.queue_count, row.stalled_count),
    }));

    const totals = {
      totalQueue: units.reduce((s, u) => s + u.queue_count, 0),
      totalStalled: units.reduce((s, u) => s + u.stalled_count, 0),
      criticalUnits: units.filter(u => u.status === 'critical').length,
      warningUnits: units.filter(u => u.status === 'warning').length,
      okUnits: units.filter(u => u.status === 'ok').length,
      totalOperatorsWithIssues: units.reduce((s, u) => s + u.stalled_operators, 0),
    };

    res.json({ units, totals, hoursThreshold, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Error in /api/units:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/units/:id/detail ──────────────────────────────────
app.get('/api/units/:id/detail', requireAuth, async (req, res) => {
  try {
    const accountId = parseInt(req.params.id);
    const hoursThreshold = parseInt(req.query.hours) || 48;
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);

    // Check permission: user must have access to this account
    if (req.user.accounts && req.user.accounts.length > 0 && !req.user.accounts.includes(accountId)) {
      return res.status(403).json({ error: 'Sem permissão para esta unidade' });
    }

    const accResult = await pool.query('SELECT name FROM accounts WHERE id = $1', [accountId]);
    if (accResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const accountName = accResult.rows[0].name;

    const queueQuery = `
      SELECT
        c.id, c.display_id,
        COALESCE(c.last_activity_at, c.created_at) as last_activity_at,
        c.created_at,
        ct.name as contact_name,
        ct.phone_number as contact_phone,
        i.name as inbox_name,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_activity_at, c.created_at))) / 3600 as hours_inactive
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
      LEFT JOIN inboxes i ON i.id = c.inbox_id
      WHERE c.account_id = $1
        AND c.status = 0
        AND c.assignee_id IS NULL
      ORDER BY COALESCE(c.last_activity_at, c.created_at) ASC
      LIMIT $2
    `;

    const stalledQuery = `
      SELECT
        c.id, c.display_id,
        COALESCE(c.last_activity_at, c.created_at) as last_activity_at,
        c.created_at,
        ct.name as contact_name,
        ct.phone_number as contact_phone,
        u.name as assignee_name,
        u.id as assignee_id,
        i.name as inbox_name,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_activity_at, c.created_at))) / 3600 as hours_inactive
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
      JOIN users u ON u.id = c.assignee_id AND ${BOT_FILTER}
      LEFT JOIN inboxes i ON i.id = c.inbox_id
      WHERE c.account_id = $1
        AND c.status = 0
        AND c.assignee_id IS NOT NULL
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
      ORDER BY COALESCE(c.last_activity_at, c.created_at) ASC
      LIMIT $2
    `;

    const operatorQuery = `
      SELECT
        u.id as assignee_id,
        u.name as assignee_name,
        COUNT(*) as stalled_count,
        MIN(COALESCE(c.last_activity_at, c.created_at)) as oldest_at,
        MAX(COALESCE(c.last_activity_at, c.created_at)) as newest_at
      FROM conversations c
      JOIN users u ON u.id = c.assignee_id AND ${BOT_FILTER}
      WHERE c.account_id = $1
        AND c.status = 0
        AND c.assignee_id IS NOT NULL
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
      GROUP BY u.id, u.name
      ORDER BY COUNT(*) DESC
    `;

    const queueCountQuery = `
      SELECT COUNT(*) as cnt FROM conversations
      WHERE account_id = $1 AND status = 0 AND assignee_id IS NULL
    `;
    const stalledCountQuery = `
      SELECT COUNT(*) as cnt FROM conversations c
      WHERE c.account_id = $1 AND c.status = 0
        AND c.assignee_id IS NOT NULL
        AND ${BOT_FILTER_CONV}
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
    `;

    const [queueResult, stalledResult, operatorResult, queueCountResult, stalledCountResult] = await Promise.all([
      pool.query(queueQuery, [accountId, limit]),
      pool.query(stalledQuery, [accountId, limit]),
      pool.query(operatorQuery, [accountId]),
      pool.query(queueCountQuery, [accountId]),
      pool.query(stalledCountQuery, [accountId]),
    ]);

    const formatConv = (row) => ({
      ...row,
      hours_inactive: Math.round(parseFloat(row.hours_inactive)),
      days_inactive: Math.round(parseFloat(row.hours_inactive) / 24),
      chatwootUrl: `${CHATWOOT_BASE}/app/accounts/${accountId}/conversations/${row.display_id}`,
    });

    const queueTotal = parseInt(queueCountResult.rows[0].cnt);
    const stalledTotal = parseInt(stalledCountResult.rows[0].cnt);

    res.json({
      accountId,
      accountName,
      queue: queueResult.rows.map(formatConv),
      stalled: stalledResult.rows.map(formatConv),
      operators: operatorResult.rows,
      queueTotal,
      stalledTotal,
      queueShowing: queueResult.rows.length,
      stalledShowing: stalledResult.rows.length,
      hoursThreshold,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error in /api/units/:id/detail:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/operators ──────────────────────────────────────────
app.get('/api/operators', requireAuth, async (req, res) => {
  try {
    const hoursThreshold = parseInt(req.query.hours) || 48;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const accountWhere = buildAccountWhere(req.user, 'c');

    const query = `
      SELECT
        u.id as assignee_id,
        u.name as assignee_name,
        u.email as assignee_email,
        c.account_id,
        a.name as account_name,
        COUNT(*) as stalled_count,
        MIN(COALESCE(c.last_activity_at, c.created_at)) as oldest_at,
        EXTRACT(EPOCH FROM (NOW() - MIN(COALESCE(c.last_activity_at, c.created_at)))) / 86400 as max_days_inactive
      FROM conversations c
      JOIN users u ON u.id = c.assignee_id AND ${BOT_FILTER}
      JOIN accounts a ON a.id = c.account_id
      WHERE c.status = 0
        AND c.assignee_id IS NOT NULL
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
        AND ${accountWhere}
      GROUP BY u.id, u.name, u.email, c.account_id, a.name
      ORDER BY COUNT(*) DESC
      LIMIT $1
    `;

    const result = await pool.query(query, [limit]);
    const operators = result.rows.map(row => ({
      ...row,
      stalled_count: parseInt(row.stalled_count),
      max_days_inactive: Math.round(parseFloat(row.max_days_inactive)),
    }));

    res.json({
      operators,
      totalOperators: operators.length,
      hoursThreshold,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error in /api/operators:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/operators/:userId/conversations ────────────────────
app.get('/api/operators/:userId/conversations', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const accountId = parseInt(req.query.account_id);
    const hoursThreshold = parseInt(req.query.hours) || 48;
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);

    if (!accountId) return res.status(400).json({ error: 'account_id required' });

    // Check permission
    if (req.user.accounts && req.user.accounts.length > 0 && !req.user.accounts.includes(accountId)) {
      return res.status(403).json({ error: 'Sem permissão para esta unidade' });
    }

    const metaResult = await pool.query(
      `SELECT u.name as op_name, a.name as account_name
       FROM users u, accounts a WHERE u.id = $1 AND a.id = $2`,
      [userId, accountId]
    );
    if (metaResult.rows.length === 0) {
      return res.status(404).json({ error: 'Operator or account not found' });
    }
    const { op_name, account_name } = metaResult.rows[0];

    const convQuery = `
      SELECT
        c.id, c.display_id,
        COALESCE(c.last_activity_at, c.created_at) as last_activity_at,
        c.created_at,
        ct.name as contact_name,
        ct.phone_number as contact_phone,
        i.name as inbox_name,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_activity_at, c.created_at))) / 3600 as hours_inactive
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
      LEFT JOIN inboxes i ON i.id = c.inbox_id
      WHERE c.account_id = $1
        AND c.assignee_id = $2
        AND c.status = 0
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
      ORDER BY COALESCE(c.last_activity_at, c.created_at) ASC
      LIMIT $3
    `;

    const countQuery = `
      SELECT COUNT(*) as cnt FROM conversations c
      WHERE c.account_id = $1 AND c.assignee_id = $2 AND c.status = 0
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
    `;

    const [convResult, countResult] = await Promise.all([
      pool.query(convQuery, [accountId, userId, limit]),
      pool.query(countQuery, [accountId, userId]),
    ]);

    const total = parseInt(countResult.rows[0].cnt);

    const formatConv = (row) => ({
      ...row,
      hours_inactive: Math.round(parseFloat(row.hours_inactive)),
      days_inactive: Math.round(parseFloat(row.hours_inactive) / 24),
      chatwootUrl: `${CHATWOOT_BASE}/app/accounts/${accountId}/conversations/${row.display_id}`,
    });

    res.json({
      operatorName: op_name,
      accountName: account_name,
      accountId,
      conversations: convResult.rows.map(formatConv),
      total,
      showing: convResult.rows.length,
      hoursThreshold,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error in /api/operators/:userId/conversations:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Traffic light logic ─────────────────────────────────────────
function getStatus(queueCount, stalledCount) {
  if (stalledCount > 100 || queueCount > 50) return 'critical';
  if (stalledCount > 20 || queueCount > 15) return 'warning';
  return 'ok';
}

// ── Fallback ────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const token = req.cookies?.farol_token;
  const user = token ? verifyToken(token) : null;
  if (!user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Farol Operacional`);
  console.log(`  http://localhost:${PORT}\n`);
});

process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});
