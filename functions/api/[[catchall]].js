import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
import pg from 'pg';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import managersData from '../../managers.json';

const { Client } = pg;

const app = new Hono().basePath('/api');

// ── Constants ────────────────────────────────────────────────────
const EXCLUDED_ACCOUNTS = [38];
const BOT_FILTER = "u.email NOT LIKE '%@arvore.ia'";
const BOT_FILTER_CONV = `c.assignee_id NOT IN (SELECT id FROM users WHERE email LIKE '%@arvore.ia')`;

// ── Helpers ──────────────────────────────────────────────────────

function parseCookies(request) {
  const cookie = request.headers.get('Cookie') || '';
  return Object.fromEntries(
    cookie.split(';').filter(Boolean).map(c => {
      const idx = c.indexOf('=');
      if (idx === -1) return [c.trim(), ''];
      return [c.substring(0, idx).trim(), c.substring(idx + 1).trim()];
    })
  );
}

async function getDb(env) {
  const client = new Client({
    host: env.DB_HOST,
    port: parseInt(env.DB_PORT || '5432'),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: false,
  });
  await client.connect();
  return client;
}

async function createToken(payload, env) {
  const secret = new TextEncoder().encode(env.JWT_SECRET);
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('24h')
    .sign(secret);
}

async function verifyToken(token, env) {
  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    return payload;
  } catch {
    return null;
  }
}

function buildAccountWhere(user, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  if (!user.accounts || user.accounts.length === 0) {
    return `${prefix}account_id NOT IN (${EXCLUDED_ACCOUNTS.join(',')})`;
  }
  return `${prefix}account_id IN (${user.accounts.join(',')})`;
}

function getStatus(queueCount, stalledCount) {
  if (stalledCount > 100 || queueCount > 50) return 'critical';
  if (stalledCount > 20 || queueCount > 15) return 'warning';
  return 'ok';
}

// ── Auth helpers ─────────────────────────────────────────────────

async function chatwootAuth(email, password, env) {
  const base = env.CHATWOOT_BASE_URL || 'https://chatclinics.5ef4kt.easypanel.host';
  try {
    const res = await fetch(`${base}/auth/sign_in`, {
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
      id: String(data.id),
      name: data.name || email.split('@')[0],
      email: data.email || email,
      accounts, role, source: 'chatwoot',
    };
  } catch {
    return null;
  }
}

async function localAuth(email, password) {
  const managers = managersData.managers || [];
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
  };
}

// ── Auth middleware ───────────────────────────────────────────────

async function authMiddleware(c, next) {
  const cookies = parseCookies(c.req.raw);
  const token = cookies.farol_token;
  if (!token) return c.json({ error: 'Não autenticado' }, 401);
  const user = await verifyToken(token, c.env);
  if (!user) return c.json({ error: 'Sessão expirada' }, 401);
  c.set('user', user);
  await next();
}

// ══════════════════════════════════════════════════════════════════
// AUTH ENDPOINTS
// ══════════════════════════════════════════════════════════════════

app.post('/auth/login', async (c) => {
  const { email, password } = await c.req.json();
  if (!email || !password) {
    return c.json({ error: 'E-mail e senha são obrigatórios' }, 400);
  }

  let user = await chatwootAuth(email, password, c.env);
  if (!user) user = await localAuth(email, password);
  if (!user) return c.json({ error: 'Credenciais inválidas' }, 401);

  const token = await createToken({
    id: user.id, name: user.name, email: user.email,
    accounts: user.accounts, role: user.role, source: user.source,
  }, c.env);

  const isSecure = new URL(c.req.url).protocol === 'https:';
  return new Response(JSON.stringify({
    name: user.name, email: user.email, role: user.role,
    accountCount: user.accounts.length || 'all',
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `farol_token=${token}; HttpOnly; ${isSecure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=86400; Path=/`,
    },
  });
});

app.post('/auth/logout', (c) => {
  const isSecure = new URL(c.req.url).protocol === 'https:';
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `farol_token=; HttpOnly; ${isSecure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=0; Path=/`,
    },
  });
});

app.get('/auth/me', async (c) => {
  const cookies = parseCookies(c.req.raw);
  const token = cookies.farol_token;
  if (!token) return c.json({ error: 'Não autenticado' }, 401);
  const user = await verifyToken(token, c.env);
  if (!user) return c.json({ error: 'Sessão expirada' }, 401);
  return c.json({
    name: user.name, email: user.email, role: user.role,
    accountCount: user.accounts?.length || 'all',
  });
});

// ══════════════════════════════════════════════════════════════════
// HEALTH CHECK (no auth)
// ══════════════════════════════════════════════════════════════════

app.get('/health', async (c) => {
  let db;
  try {
    db = await getDb(c.env);
    const r = await db.query('SELECT NOW() as now');
    return c.json({ status: 'ok', dbTime: r.rows[0].now });
  } catch (err) {
    return c.json({ status: 'error', message: err.message }, 500);
  } finally {
    if (db) await db.end();
  }
});

// ══════════════════════════════════════════════════════════════════
// DATA ENDPOINTS (all require auth)
// ══════════════════════════════════════════════════════════════════

// ── GET /api/units ──────────────────────────────────────────────

app.get('/units', authMiddleware, async (c) => {
  let db;
  try {
    const user = c.get('user');
    const hoursThreshold = parseInt(c.req.query('hours')) || 48;
    const accountWhere = buildAccountWhere(user);
    const chatwootBase = c.env.CHATWOOT_BASE_URL || 'https://chatclinics.5ef4kt.easypanel.host';

    db = await getDb(c.env);
    const query = `
      WITH queue AS (
        SELECT account_id, COUNT(*) as cnt
        FROM conversations
        WHERE status = 0 AND assignee_id IS NULL AND ${accountWhere}
        GROUP BY account_id
      ),
      stalled AS (
        SELECT c.account_id, COUNT(*) as cnt
        FROM conversations c
        WHERE c.status = 0 AND c.assignee_id IS NOT NULL
          AND ${BOT_FILTER_CONV}
          AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
          AND ${buildAccountWhere(user, 'c')}
        GROUP BY c.account_id
      ),
      stalled_ops AS (
        SELECT c.account_id, COUNT(DISTINCT c.assignee_id) as cnt
        FROM conversations c
        WHERE c.status = 0 AND c.assignee_id IS NOT NULL
          AND ${BOT_FILTER_CONV}
          AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
          AND ${buildAccountWhere(user, 'c')}
        GROUP BY c.account_id
      ),
      oldest AS (
        SELECT c.account_id, MIN(COALESCE(c.last_activity_at, c.created_at)) as oldest_at
        FROM conversations c
        WHERE c.status = 0 AND c.assignee_id IS NOT NULL
          AND ${BOT_FILTER_CONV}
          AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
          AND ${buildAccountWhere(user, 'c')}
        GROUP BY c.account_id
      )
      SELECT
        a.id as account_id, a.name as account_name,
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

    const result = await db.query(query);
    const units = result.rows.map(row => ({
      ...row,
      chatwootUrl: `${chatwootBase}/app/accounts/${row.account_id}/dashboard`,
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

    return c.json({ units, totals, hoursThreshold, timestamp: new Date().toISOString() });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  } finally {
    if (db) await db.end();
  }
});

// ── GET /api/units/:id/detail ──────────────────────────────────

app.get('/units/:id/detail', authMiddleware, async (c) => {
  let db;
  try {
    const user = c.get('user');
    const accountId = parseInt(c.req.param('id'));
    const hoursThreshold = parseInt(c.req.query('hours')) || 48;
    const limit = Math.min(parseInt(c.req.query('limit')) || 200, 500);
    const chatwootBase = c.env.CHATWOOT_BASE_URL || 'https://chatclinics.5ef4kt.easypanel.host';

    // Permission check
    if (user.accounts && user.accounts.length > 0 && !user.accounts.includes(accountId)) {
      return c.json({ error: 'Sem permissão para esta unidade' }, 403);
    }

    db = await getDb(c.env);

    const accResult = await db.query('SELECT name FROM accounts WHERE id = $1', [accountId]);
    if (accResult.rows.length === 0) return c.json({ error: 'Account not found' }, 404);
    const accountName = accResult.rows[0].name;

    const queueQuery = `
      SELECT c.id, c.display_id,
        COALESCE(c.last_activity_at, c.created_at) as last_activity_at,
        c.created_at, ct.name as contact_name, ct.phone_number as contact_phone,
        i.name as inbox_name,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_activity_at, c.created_at))) / 3600 as hours_inactive
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
      LEFT JOIN inboxes i ON i.id = c.inbox_id
      WHERE c.account_id = $1 AND c.status = 0 AND c.assignee_id IS NULL
      ORDER BY COALESCE(c.last_activity_at, c.created_at) ASC LIMIT $2
    `;

    const stalledQuery = `
      SELECT c.id, c.display_id,
        COALESCE(c.last_activity_at, c.created_at) as last_activity_at,
        c.created_at, ct.name as contact_name, ct.phone_number as contact_phone,
        u.name as assignee_name, u.id as assignee_id, i.name as inbox_name,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_activity_at, c.created_at))) / 3600 as hours_inactive
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
      JOIN users u ON u.id = c.assignee_id AND ${BOT_FILTER}
      LEFT JOIN inboxes i ON i.id = c.inbox_id
      WHERE c.account_id = $1 AND c.status = 0 AND c.assignee_id IS NOT NULL
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
      ORDER BY COALESCE(c.last_activity_at, c.created_at) ASC LIMIT $2
    `;

    const operatorQuery = `
      SELECT u.id as assignee_id, u.name as assignee_name,
        COUNT(*) as stalled_count,
        MIN(COALESCE(c.last_activity_at, c.created_at)) as oldest_at,
        MAX(COALESCE(c.last_activity_at, c.created_at)) as newest_at
      FROM conversations c
      JOIN users u ON u.id = c.assignee_id AND ${BOT_FILTER}
      WHERE c.account_id = $1 AND c.status = 0 AND c.assignee_id IS NOT NULL
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
      GROUP BY u.id, u.name ORDER BY COUNT(*) DESC
    `;

    const queueCountQ = `SELECT COUNT(*) as cnt FROM conversations WHERE account_id = $1 AND status = 0 AND assignee_id IS NULL`;
    const stalledCountQ = `SELECT COUNT(*) as cnt FROM conversations c WHERE c.account_id = $1 AND c.status = 0
      AND c.assignee_id IS NOT NULL AND ${BOT_FILTER_CONV}
      AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'`;

    const [queueR, stalledR, operatorR, qcR, scR] = await Promise.all([
      db.query(queueQuery, [accountId, limit]),
      db.query(stalledQuery, [accountId, limit]),
      db.query(operatorQuery, [accountId]),
      db.query(queueCountQ, [accountId]),
      db.query(stalledCountQ, [accountId]),
    ]);

    const formatConv = (row) => ({
      ...row,
      hours_inactive: Math.round(parseFloat(row.hours_inactive)),
      days_inactive: Math.round(parseFloat(row.hours_inactive) / 24),
      chatwootUrl: `${chatwootBase}/app/accounts/${accountId}/conversations/${row.display_id}`,
    });

    return c.json({
      accountId, accountName,
      queue: queueR.rows.map(formatConv),
      stalled: stalledR.rows.map(formatConv),
      operators: operatorR.rows,
      queueTotal: parseInt(qcR.rows[0].cnt),
      stalledTotal: parseInt(scR.rows[0].cnt),
      queueShowing: queueR.rows.length,
      stalledShowing: stalledR.rows.length,
      hoursThreshold,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  } finally {
    if (db) await db.end();
  }
});

// ── GET /api/operators ──────────────────────────────────────────

app.get('/operators', authMiddleware, async (c) => {
  let db;
  try {
    const user = c.get('user');
    const hoursThreshold = parseInt(c.req.query('hours')) || 48;
    const limit = Math.min(parseInt(c.req.query('limit')) || 50, 200);
    const accountWhere = buildAccountWhere(user, 'c');

    db = await getDb(c.env);
    const query = `
      SELECT u.id as assignee_id, u.name as assignee_name, u.email as assignee_email,
        c.account_id, a.name as account_name,
        COUNT(*) as stalled_count,
        MIN(COALESCE(c.last_activity_at, c.created_at)) as oldest_at,
        EXTRACT(EPOCH FROM (NOW() - MIN(COALESCE(c.last_activity_at, c.created_at)))) / 86400 as max_days_inactive
      FROM conversations c
      JOIN users u ON u.id = c.assignee_id AND ${BOT_FILTER}
      JOIN accounts a ON a.id = c.account_id
      WHERE c.status = 0 AND c.assignee_id IS NOT NULL
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
        AND ${accountWhere}
      GROUP BY u.id, u.name, u.email, c.account_id, a.name
      ORDER BY COUNT(*) DESC LIMIT $1
    `;

    const result = await db.query(query, [limit]);
    const operators = result.rows.map(row => ({
      ...row,
      stalled_count: parseInt(row.stalled_count),
      max_days_inactive: Math.round(parseFloat(row.max_days_inactive)),
    }));

    return c.json({ operators, totalOperators: operators.length, hoursThreshold, timestamp: new Date().toISOString() });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  } finally {
    if (db) await db.end();
  }
});

// ── GET /api/operators/:userId/conversations ────────────────────

app.get('/operators/:userId/conversations', authMiddleware, async (c) => {
  let db;
  try {
    const user = c.get('user');
    const userId = parseInt(c.req.param('userId'));
    const accountId = parseInt(c.req.query('account_id'));
    const hoursThreshold = parseInt(c.req.query('hours')) || 48;
    const limit = Math.min(parseInt(c.req.query('limit')) || 200, 500);
    const chatwootBase = c.env.CHATWOOT_BASE_URL || 'https://chatclinics.5ef4kt.easypanel.host';

    if (!accountId) return c.json({ error: 'account_id required' }, 400);

    // Permission check
    if (user.accounts && user.accounts.length > 0 && !user.accounts.includes(accountId)) {
      return c.json({ error: 'Sem permissão para esta unidade' }, 403);
    }

    db = await getDb(c.env);

    const metaResult = await db.query(
      'SELECT u.name as op_name, a.name as account_name FROM users u, accounts a WHERE u.id = $1 AND a.id = $2',
      [userId, accountId]
    );
    if (metaResult.rows.length === 0) return c.json({ error: 'Operator or account not found' }, 404);
    const { op_name, account_name } = metaResult.rows[0];

    const convQuery = `
      SELECT c.id, c.display_id,
        COALESCE(c.last_activity_at, c.created_at) as last_activity_at,
        c.created_at, ct.name as contact_name, ct.phone_number as contact_phone,
        i.name as inbox_name,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_activity_at, c.created_at))) / 3600 as hours_inactive
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
      LEFT JOIN inboxes i ON i.id = c.inbox_id
      WHERE c.account_id = $1 AND c.assignee_id = $2 AND c.status = 0
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
      ORDER BY COALESCE(c.last_activity_at, c.created_at) ASC LIMIT $3
    `;
    const countQuery = `
      SELECT COUNT(*) as cnt FROM conversations c
      WHERE c.account_id = $1 AND c.assignee_id = $2 AND c.status = 0
        AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '${hoursThreshold} hours'
    `;

    const [convR, countR] = await Promise.all([
      db.query(convQuery, [accountId, userId, limit]),
      db.query(countQuery, [accountId, userId]),
    ]);

    const formatConv = (row) => ({
      ...row,
      hours_inactive: Math.round(parseFloat(row.hours_inactive)),
      days_inactive: Math.round(parseFloat(row.hours_inactive) / 24),
      chatwootUrl: `${chatwootBase}/app/accounts/${accountId}/conversations/${row.display_id}`,
    });

    return c.json({
      operatorName: op_name, accountName: account_name, accountId,
      conversations: convR.rows.map(formatConv),
      total: parseInt(countR.rows[0].cnt),
      showing: convR.rows.length,
      hoursThreshold,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  } finally {
    if (db) await db.end();
  }
});

// ══════════════════════════════════════════════════════════════════

export const onRequest = handle(app);
