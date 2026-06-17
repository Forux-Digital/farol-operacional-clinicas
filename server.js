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

// Tag orto (ortodontia) — excluir da contabilização
const ORTO_TAG_ID = 17;
const ORTO_FILTER = `NOT EXISTS (SELECT 1 FROM taggings tg WHERE tg.taggable_id = c.id AND tg.tag_id = ${ORTO_TAG_ID} AND tg.taggable_type = 'Conversation')`;

// Tag filter helper: when ?tag=ID is passed, only include conversations WITH that tag
function buildTagFilter(tagId) {
  if (!tagId) return '';
  const id = parseInt(tagId);
  if (isNaN(id)) return '';
  return `AND EXISTS (SELECT 1 FROM taggings tgf WHERE tgf.taggable_id = c.id AND tgf.tag_id = ${id} AND tgf.taggable_type = 'Conversation')`;
}

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

function saveManagers(managers) {
  const data = { _comment: "Gestores e líderes. accounts=[] = acesso global. mustChangePassword=true exige troca no 1º login.", managers };
  fs.writeFileSync(path.join(__dirname, 'managers.json'), JSON.stringify(data, null, 2));
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
      mustChangePassword: false,
    };
  } catch (err) {
    console.error('Chatwoot auth error:', err.message);
    return null;
  }
}

// ── Auth: SSO do hub GCI (valida a credencial devise, sem senha) ──
async function chatwootValidateSSO(cred) {
  try {
    const res = await fetch(`${CHATWOOT_BASE}/auth/validate_token`, {
      method: 'GET',
      headers: {
        'access-token': cred.access_token || '',
        'token-type': cred.token_type || 'Bearer',
        client: cred.client || '',
        uid: cred.uid || '',
      },
    });
    if (!res.ok) return null;
    const body = await res.json();
    // O /auth/validate_token devolve o usuário em `payload.data` (o /auth/sign_in usa `data`)
    // e a lista de contas em `accounts` (o sign_in usa `available_accounts`). Trata os dois.
    const data = (body.payload && body.payload.data) || body.data;
    if (!data || !data.email) return null;
    const accs = data.accounts || data.available_accounts || [];
    const accounts = accs
      .map(a => a.id)
      .filter(id => !EXCLUDED_ACCOUNTS.includes(id));
    const role = accs.some(a => a.role === 'administrator')
      ? 'admin' : 'agent';
    return {
      id: data.id,
      name: data.name || String(data.email).split('@')[0],
      email: data.email,
      accounts,
      role,
      source: 'chatwoot',
      mustChangePassword: false,
    };
  } catch (err) {
    console.error('Chatwoot SSO validate error:', err.message);
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
    accounts: manager.accounts,
    role: manager.role || 'manager',
    source: 'local',
    mustChangePassword: manager.mustChangePassword || false,
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
    mustChangePassword: user.mustChangePassword || false,
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
  if (!user.accounts || user.accounts.length === 0) {
    return EXCLUDED_ACCOUNTS;
  }
  return user.accounts;
}

function buildAccountWhere(user, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  if (!user.accounts || user.accounts.length === 0) {
    return `${prefix}account_id NOT IN (${EXCLUDED_ACCOUNTS.join(',')})`;
  }
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
  if (user) {
    // If user exists in managers.json, override accounts/role for consistent permissions
    const managers = loadManagers();
    const manager = managers.find(m => m.email.toLowerCase() === email.toLowerCase());
    if (manager) {
      user.accounts = manager.accounts;
      user.role = manager.role || user.role;
    }
  } else {
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
    maxAge: 24 * 60 * 60 * 1000,
  });

  res.json({
    name: user.name,
    email: user.email,
    role: user.role,
    accountCount: user.accounts.length || 'all',
    mustChangePassword: user.mustChangePassword || false,
  });
});

// SSO do hub GCI: cria a sessão a partir da credencial do Chatwoot (sem senha).
// Cookie SameSite=None p/ funcionar embedado (iframe cross-site no hub).
app.post('/api/auth/sso', async (req, res) => {
  const cred = (req.body && req.body.cred) || req.body || {};
  if (!cred.access_token || !cred.uid) {
    return res.status(400).json({ error: 'Credencial ausente' });
  }
  let user = await chatwootValidateSSO(cred);
  if (user) {
    const managers = loadManagers();
    const manager = managers.find(m => m.email.toLowerCase() === String(user.email).toLowerCase());
    if (manager) { user.accounts = manager.accounts; user.role = manager.role || user.role; }
  }
  if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });

  const token = createToken(user);
  // SameSite=None + Partitioned (CHIPS): com o bloqueio de cookies de terceiros do Chrome,
  // um Set-Cookie SameSite=None comum é descartado em iframe cross-site. Partitioned grava o
  // cookie no jar particionado por site de topo (gci.arvore.party) e ele é enviado nas
  // requisições do iframe — funciona inclusive em aba anônima. Set-Cookie manual porque o
  // res.cookie() do Express só suporta `partitioned` em versões recentes do pacote cookie.
  res.setHeader('Set-Cookie',
    `farol_token=${token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${24 * 60 * 60}`);
  res.json({ name: user.name, email: user.email, role: user.role });
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
    mustChangePassword: user.mustChangePassword || false,
  });
});

// ── Password change ─────────────────────────────────────────────
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Nova senha deve ter pelo menos 6 caracteres' });
  }
  if (req.user.source !== 'local') {
    return res.status(400).json({ error: 'Altere sua senha diretamente no Chatwoot' });
  }

  const managers = loadManagers();
  const idx = managers.findIndex(m => m.email.toLowerCase() === req.user.email.toLowerCase());
  if (idx === -1) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  const valid = await bcrypt.compare(currentPassword, managers[idx].passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Senha atual incorreta' });
  }

  managers[idx].passwordHash = await bcrypt.hash(newPassword, 10);
  managers[idx].mustChangePassword = false;
  saveManagers(managers);

  const user = {
    id: req.user.id,
    name: req.user.name,
    email: req.user.email,
    accounts: req.user.accounts,
    role: req.user.role,
    source: 'local',
    mustChangePassword: false,
  };

  const token = createToken(user);
  res.cookie('farol_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  });

  res.json({ ok: true });
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
  index: false,
}));

// ══════════════════════════════════════════════════════════════════
// DATA API ENDPOINTS (all require auth)
// ══════════════════════════════════════════════════════════════════

// ── GET /api/tags ───────────────────────────────────────────────
app.get('/api/tags', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.id, t.name, COUNT(tg.id)::int as usage_count
      FROM tags t
      JOIN taggings tg ON tg.tag_id = t.id AND tg.taggable_type = 'Conversation'
      GROUP BY t.id, t.name
      ORDER BY usage_count DESC
    `);
    res.json({ tags: result.rows });
  } catch (err) {
    console.error('Error in /api/tags:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/units ──────────────────────────────────────────────
app.get('/api/units', requireAuth, async (req, res) => {
  try {
    const hoursThreshold = parseInt(req.query.hours) || 48;
    const tagFilter = buildTagFilter(req.query.tag);
    const accountWhere = buildAccountWhere(req.user, 'c');

    const query = `
      WITH queue AS (
        SELECT c.account_id, COUNT(*) as cnt
        FROM conversations c
        WHERE c.status = 0
          AND c.assignee_id IS NULL
          AND ${accountWhere}
          AND ${ORTO_FILTER}
          ${tagFilter}
        GROUP BY c.account_id
      ),
      stalled AS (
        SELECT c.account_id, COUNT(*) as cnt
        FROM conversations c
        WHERE c.status = 0
          AND c.assignee_id IS NOT NULL
          AND ${BOT_FILTER_CONV}
          AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
          AND ${accountWhere}
          AND ${ORTO_FILTER}
          ${tagFilter}
        GROUP BY c.account_id
      ),
      stalled_ops AS (
        SELECT c.account_id, COUNT(DISTINCT c.assignee_id) as cnt
        FROM conversations c
        WHERE c.status = 0
          AND c.assignee_id IS NOT NULL
          AND ${BOT_FILTER_CONV}
          AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
          AND ${accountWhere}
          AND ${ORTO_FILTER}
          ${tagFilter}
        GROUP BY c.account_id
      ),
      oldest AS (
        SELECT c.account_id, MIN(COALESCE(c.last_activity_at, c.created_at)) as oldest_at
        FROM conversations c
        WHERE c.status = 0
          AND c.assignee_id IS NOT NULL
          AND ${BOT_FILTER_CONV}
          AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
          AND ${accountWhere}
          AND ${ORTO_FILTER}
          ${tagFilter}
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
      WHERE ${buildAccountWhere(req.user).replace('account_id', 'a.id')}
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
    const tagFilter = buildTagFilter(req.query.tag);
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);

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
        AND ${ORTO_FILTER}
        ${tagFilter}
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
        AND ${ORTO_FILTER}
        ${tagFilter}
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
        AND ${ORTO_FILTER}
        ${tagFilter}
      GROUP BY u.id, u.name
      ORDER BY COUNT(*) DESC
    `;

    const queueCountQuery = `
      SELECT COUNT(*) as cnt FROM conversations c
      WHERE c.account_id = $1 AND c.status = 0 AND c.assignee_id IS NULL
      AND ${ORTO_FILTER}
      ${tagFilter}
    `;
    const stalledCountQuery = `
      SELECT COUNT(*) as cnt FROM conversations c
      WHERE c.account_id = $1 AND c.status = 0
        AND c.assignee_id IS NOT NULL
        AND ${BOT_FILTER_CONV}
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
        AND ${ORTO_FILTER}
        ${tagFilter}
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
    const tagFilter = buildTagFilter(req.query.tag);
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
        AND ${ORTO_FILTER}
        ${tagFilter}
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
    const tagFilter = buildTagFilter(req.query.tag);
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);

    if (!accountId) return res.status(400).json({ error: 'account_id required' });

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
        AND ${ORTO_FILTER}
        ${tagFilter}
      ORDER BY COALESCE(c.last_activity_at, c.created_at) ASC
      LIMIT $3
    `;

    const countQuery = `
      SELECT COUNT(*) as cnt FROM conversations c
      WHERE c.account_id = $1 AND c.assignee_id = $2 AND c.status = 0
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
        AND ${ORTO_FILTER}
        ${tagFilter}
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
