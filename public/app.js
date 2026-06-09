// ══════════════════════════════════════════════════════════════
// Farol Operacional — Frontend Logic v2
// ══════════════════════════════════════════════════════════════

const CHATWOOT_BASE = 'https://chatclinics.5ef4kt.easypanel.host';

let currentData = null;
let currentDetailData = null;
let currentModalType = null; // 'unit' or 'operator'
let autoRefreshTimer = null;

// ── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadUserInfo();
  loadDashboard();

  document.getElementById('searchUnits').addEventListener('input', (e) => {
    filterUnitsTable(e.target.value);
  });

  document.getElementById('hoursFilter').addEventListener('change', () => {
    loadDashboard();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey && e.target.tagName !== 'INPUT') {
      loadDashboard();
    }
    if (e.key === 'Escape') {
      closeModal();
    }
  });

  startAutoRefresh();
});

// ── Auth helpers ────────────────────────────────────────────
async function loadUserInfo() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return window.location.href = '/login';
    const user = await res.json();
    const el = document.getElementById('userName');
    if (el) el.textContent = user.name || user.email;
  } catch {
    window.location.href = '/login';
  }
}

async function handleLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

function handleAuthError(res) {
  if (res.status === 401 || res.status === 403) {
    window.location.href = '/login';
    return true;
  }
  return false;
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => loadDashboard(), 5 * 60 * 1000);
}

function getHoursThreshold() {
  return document.getElementById('hoursFilter').value || '48';
}

// ── Load Dashboard ──────────────────────────────────────────
async function loadDashboard() {
  showState('loading');
  const hours = getHoursThreshold();

  try {
    const [unitsRes, opsRes] = await Promise.all([
      fetch(`/api/units?hours=${hours}`),
      fetch(`/api/operators?hours=${hours}`),
    ]);

    if (handleAuthError(unitsRes)) return;
    if (!unitsRes.ok) throw new Error(`API error: ${unitsRes.status}`);

    const unitsData = await unitsRes.json();
    const opsData = await opsRes.json();

    currentData = { ...unitsData, operators: opsData.operators };
    renderDashboard(currentData);
    showState('content');
    updateTimestamp(unitsData.timestamp);

    document.getElementById('hoursLabel').textContent = hours;
  } catch (err) {
    console.error('Dashboard load error:', err);
    showState('error', err.message);
  }
}

function showState(state, errorMsg) {
  document.getElementById('loadingState').classList.toggle('hidden', state !== 'loading');
  document.getElementById('errorState').classList.toggle('hidden', state !== 'error');
  document.getElementById('dashboardContent').classList.toggle('hidden', state !== 'content');
  if (errorMsg) document.getElementById('errorMessage').textContent = errorMsg;
}

function updateTimestamp(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const date = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  document.getElementById('lastUpdated').textContent = `${date} ${time}`;
  document.getElementById('lastUpdated').classList.remove('hidden');
}

// ── Render Dashboard ────────────────────────────────────────
function renderDashboard(data) {
  const { units, totals, operators } = data;

  // Summary cards
  document.getElementById('totalQueue').textContent = formatNumber(totals.totalQueue);
  document.getElementById('totalStalled').textContent = formatNumber(totals.totalStalled);
  document.getElementById('criticalUnits').textContent = totals.criticalUnits;
  document.getElementById('warningUnits').textContent = totals.warningUnits;
  document.getElementById('okUnits').textContent = totals.okUnits;
  document.getElementById('totalOperators').textContent = totals.totalOperatorsWithIssues;

  renderUnitsTable(units);
  renderOperatorsTable(operators);
}

function renderUnitsTable(units) {
  const tbody = document.getElementById('unitsTableBody');
  tbody.innerHTML = units.map(u => {
    const statusDot = getStatusDot(u.status);
    const statusBadge = getStatusBadge(u.status);
    const queueClass = u.queue_count > 50 ? 'text-red-600 font-bold' : u.queue_count > 15 ? 'text-amber-600 font-semibold' : 'text-gray-600';
    const stalledClass = u.stalled_count > 100 ? 'text-red-600 font-bold' : u.stalled_count > 20 ? 'text-amber-600 font-semibold' : 'text-gray-600';

    return `
      <tr class="hover:bg-blue-50/40 transition-colors cursor-pointer group" data-unit-name="${u.account_name}" onclick="openDrilldown(${u.account_id})">
        <td class="px-4 py-2.5">
          <div class="flex items-center gap-1.5">
            ${statusDot}
            ${statusBadge}
          </div>
        </td>
        <td class="px-4 py-2.5">
          <span class="font-medium text-gray-900 text-xs">${escHtml(u.account_name)}</span>
        </td>
        <td class="px-4 py-2.5 text-right">
          <span class="${queueClass} text-xs">${formatNumber(u.queue_count)}</span>
        </td>
        <td class="px-4 py-2.5 text-right">
          <span class="${stalledClass} text-xs">${formatNumber(u.stalled_count)}</span>
        </td>
        <td class="px-4 py-2.5 text-right">
          <span class="text-gray-500 text-xs">${u.stalled_operators}</span>
        </td>
      </tr>
    `;
  }).join('');
}

function renderOperatorsTable(operators) {
  const tbody = document.getElementById('operatorsTableBody');
  if (!operators || operators.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-6 text-center text-gray-400 text-xs">Nenhum operador com conversas paradas</td></tr>';
    return;
  }
  tbody.innerHTML = operators.map((op, i) => {
    const severity = op.stalled_count > 100 ? 'critical' : op.stalled_count > 30 ? 'warning' : 'ok';
    const badge = getStatusBadge(severity);
    const barWidth = Math.min(100, (op.stalled_count / operators[0].stalled_count) * 100);
    const barColor = severity === 'critical' ? 'bg-red-500' : severity === 'warning' ? 'bg-amber-400' : 'bg-emerald-500';
    return `
      <tr class="hover:bg-blue-50/40 transition-colors cursor-pointer" onclick="openOperatorDrilldown(${op.assignee_id}, ${op.account_id}, '${escAttr(op.assignee_name)}')">
        <td class="px-4 py-2.5 text-xs text-gray-400 font-medium">${i + 1}</td>
        <td class="px-4 py-2.5">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-[10px] font-semibold text-gray-500">
              ${getInitials(op.assignee_name)}
            </div>
            <span class="font-medium text-gray-900 text-xs">${escHtml(op.assignee_name || 'Sem nome')}</span>
          </div>
        </td>
        <td class="px-4 py-2.5">
          <span class="text-xs text-gray-600">${escHtml(op.account_name)}</span>
        </td>
        <td class="px-4 py-2.5 text-right">
          <div class="flex items-center justify-end gap-1.5">
            ${badge}
            <span class="font-bold text-xs text-gray-900">${formatNumber(op.stalled_count)}</span>
          </div>
          <div class="mt-1 w-full bg-gray-100 rounded-full h-1 max-w-[100px] ml-auto">
            <div class="h-1 rounded-full ${barColor}" style="width: ${barWidth}%"></div>
          </div>
        </td>
        <td class="px-4 py-2.5 text-right">
          <span class="text-xs ${op.max_days_inactive > 30 ? 'text-red-600 font-semibold' : op.max_days_inactive > 7 ? 'text-amber-600' : 'text-gray-500'}">${op.max_days_inactive}d</span>
        </td>
      </tr>
    `;
  }).join('');
}

function removeAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function filterUnitsTable(query) {
  const rows = document.querySelectorAll('#unitsTableBody tr');
  const q = removeAccents(query.toLowerCase().trim());
  rows.forEach(row => {
    const name = removeAccents((row.dataset.unitName || '').toLowerCase());
    row.style.display = name.includes(q) ? '' : 'none';
  });
}

// ── Tabs ────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('viewUnits').classList.toggle('hidden', tab !== 'units');
  document.getElementById('viewOperators').classList.toggle('hidden', tab !== 'operators');
  document.getElementById('tabUnits').className = `px-3 py-2 text-xs transition-all ${tab === 'units' ? 'tab-active' : 'tab-inactive'}`;
  document.getElementById('tabOperators').className = `px-3 py-2 text-xs transition-all ${tab === 'operators' ? 'tab-active' : 'tab-inactive'}`;
}

// ── Unit Drill-down Modal ──────────────────────────────────
async function openDrilldown(accountId) {
  currentModalType = 'unit';
  const modal = document.getElementById('drilldownModal');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Show loading, show summary/tabs bar
  document.getElementById('modalLoading').classList.remove('hidden');
  document.getElementById('modalStalled').classList.add('hidden');
  document.getElementById('modalQueue').classList.add('hidden');
  document.getElementById('modalOps').classList.add('hidden');
  document.getElementById('modalSummaryBar').classList.remove('hidden');
  document.getElementById('modalTabsBar').classList.remove('hidden');

  const hours = getHoursThreshold();

  try {
    const res = await fetch(`/api/units/${accountId}/detail?hours=${hours}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    currentDetailData = await res.json();

    const d = currentDetailData;

    // Header — sem IDs
    document.getElementById('modalTitle').textContent = d.accountName;
    document.getElementById('modalSubtitle').textContent = `${formatNumber(d.stalledTotal)} paradas, ${formatNumber(d.queueTotal)} na fila`;
    document.getElementById('modalChatwootLink').href = `${CHATWOOT_BASE}/app/accounts/${d.accountId}/dashboard`;

    // Summary
    document.getElementById('modalQueueCount').textContent = formatNumber(d.queueTotal);
    document.getElementById('modalStalledCount').textContent = formatNumber(d.stalledTotal);
    document.getElementById('modalOperatorCount').textContent = d.operators.length;

    // Render content
    renderModalStalled(d.stalled);
    renderModalQueue(d.queue);
    renderModalOps(d.operators, d.accountId);

    // Hide loading, show default tab
    document.getElementById('modalLoading').classList.add('hidden');
    switchModalTab('stalled');
  } catch (err) {
    console.error('Drilldown error:', err);
    document.getElementById('modalLoading').innerHTML = `
      <div class="text-center text-red-500 py-6">
        <p class="font-medium text-sm">Erro ao carregar</p>
        <p class="text-xs mt-1">${escHtml(err.message)}</p>
      </div>
    `;
  }
}

// ── Operator Drill-down ────────────────────────────────────
async function openOperatorDrilldown(userId, accountId, operatorName) {
  currentModalType = 'operator';
  const modal = document.getElementById('drilldownModal');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Hide summary/tabs bar for operator view, show loading
  document.getElementById('modalSummaryBar').classList.add('hidden');
  document.getElementById('modalTabsBar').classList.add('hidden');
  document.getElementById('modalLoading').classList.remove('hidden');
  document.getElementById('modalStalled').classList.add('hidden');
  document.getElementById('modalQueue').classList.add('hidden');
  document.getElementById('modalOps').classList.add('hidden');

  const hours = getHoursThreshold();

  try {
    const res = await fetch(`/api/operators/${userId}/conversations?account_id=${accountId}&hours=${hours}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();

    // Header
    document.getElementById('modalTitle').textContent = data.operatorName;
    document.getElementById('modalSubtitle').textContent = `${data.accountName} — ${formatNumber(data.total)} conversas paradas`;
    document.getElementById('modalChatwootLink').href = `${CHATWOOT_BASE}/app/accounts/${accountId}/dashboard`;

    // Render conversations directly (no tabs for operator view)
    const container = document.getElementById('modalStalled');
    if (data.conversations.length === 0) {
      container.innerHTML = emptyState('Nenhuma conversa parada');
    } else {
      container.innerHTML = data.conversations.map(c => conversationCard(c, false)).join('')
        + (data.showing < data.total ? `<div class="text-center py-2 text-[11px] text-gray-400">Mostrando ${data.showing} de ${formatNumber(data.total)} conversas</div>` : '');
    }

    document.getElementById('modalLoading').classList.add('hidden');
    container.classList.remove('hidden');
  } catch (err) {
    console.error('Operator drilldown error:', err);
    document.getElementById('modalLoading').innerHTML = `
      <div class="text-center text-red-500 py-6">
        <p class="font-medium text-sm">Erro ao carregar</p>
        <p class="text-xs mt-1">${escHtml(err.message)}</p>
      </div>
    `;
  }
}

function closeModal() {
  document.getElementById('drilldownModal').classList.add('hidden');
  document.body.style.overflow = '';
  currentDetailData = null;
  currentModalType = null;
}

function switchModalTab(tab) {
  document.getElementById('modalStalled').classList.toggle('hidden', tab !== 'stalled');
  document.getElementById('modalQueue').classList.toggle('hidden', tab !== 'queue');
  document.getElementById('modalOps').classList.toggle('hidden', tab !== 'ops');

  document.getElementById('modalTabStalled').className = `px-3 py-2 text-xs transition-all ${tab === 'stalled' ? 'tab-active' : 'tab-inactive'}`;
  document.getElementById('modalTabQueue').className = `px-3 py-2 text-xs transition-all ${tab === 'queue' ? 'tab-active' : 'tab-inactive'}`;
  document.getElementById('modalTabOps').className = `px-3 py-2 text-xs transition-all ${tab === 'ops' ? 'tab-active' : 'tab-inactive'}`;
}

function renderModalStalled(conversations) {
  const container = document.getElementById('modalStalled');
  if (!conversations.length) {
    container.innerHTML = emptyState('Nenhuma conversa parada com operador');
    return;
  }
  const d = currentDetailData;
  const truncated = d && d.stalledShowing < d.stalledTotal;
  container.innerHTML = conversations.map(c => conversationCard(c, true)).join('')
    + (truncated ? `<div class="text-center py-2 text-[11px] text-gray-400">Mostrando ${d.stalledShowing} de ${formatNumber(d.stalledTotal)} conversas</div>` : '');
}

function renderModalQueue(conversations) {
  const container = document.getElementById('modalQueue');
  if (!conversations.length) {
    container.innerHTML = emptyState('Nenhuma conversa na fila');
    return;
  }
  const d = currentDetailData;
  const truncated = d && d.queueShowing < d.queueTotal;
  container.innerHTML = conversations.map(c => conversationCard(c, false)).join('')
    + (truncated ? `<div class="text-center py-2 text-[11px] text-gray-400">Mostrando ${d.queueShowing} de ${formatNumber(d.queueTotal)} conversas</div>` : '');
}

function renderModalOps(operators, accountId) {
  const container = document.getElementById('modalOps');
  if (!operators.length) {
    container.innerHTML = emptyState('Nenhum operador com conversas paradas');
    return;
  }
  container.innerHTML = `
    <div class="space-y-1.5">
      ${operators.map((op) => {
        const barWidth = Math.min(100, (op.stalled_count / operators[0].stalled_count) * 100);
        const severity = op.stalled_count > 100 ? 'bg-red-500' : op.stalled_count > 30 ? 'bg-amber-400' : 'bg-emerald-500';
        return `
          <div class="bg-gray-50 rounded-md p-3 border border-gray-100 cursor-pointer hover:border-blue-200 hover:bg-blue-50/30 transition-all" onclick="openOperatorDrilldown(${op.assignee_id}, ${accountId}, '${escAttr(op.assignee_name)}')">
            <div class="flex items-center justify-between mb-1.5">
              <div class="flex items-center gap-2">
                <div class="w-6 h-6 rounded-full bg-white border border-gray-200 flex items-center justify-center text-[10px] font-semibold text-gray-500">
                  ${getInitials(op.assignee_name)}
                </div>
                <span class="font-medium text-xs text-gray-900">${escHtml(op.assignee_name || 'Sem nome')}</span>
              </div>
              <div class="text-right">
                <span class="text-sm font-bold text-gray-900">${op.stalled_count}</span>
                <span class="text-[10px] text-gray-400 ml-0.5">conversas</span>
              </div>
            </div>
            <div class="w-full bg-gray-200 rounded-full h-1.5">
              <div class="h-1.5 rounded-full ${severity} transition-all" style="width: ${barWidth}%"></div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function conversationCard(c, showAssignee) {
  const timeBadge = getTimeBadge(c.hours_inactive);
  const assigneeHtml = showAssignee && c.assignee_name
    ? `<span class="text-[11px] text-gray-400">• ${escHtml(c.assignee_name)}</span>`
    : '';

  return `
    <a href="${c.chatwootUrl}" target="_blank" class="block bg-white border border-gray-100 rounded-md px-3 py-2.5 hover:border-blue-200 hover:shadow-sm transition-all group">
      <div class="flex items-center justify-between">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 mb-0.5">
            <span class="text-[10px] font-mono text-gray-400">#${c.display_id}</span>
            ${timeBadge}
          </div>
          <div class="font-medium text-xs text-gray-900 truncate">${escHtml(c.contact_name || 'Contato sem nome')}</div>
          <div class="flex items-center gap-1.5 mt-0.5">
            ${c.contact_phone ? `<span class="text-[11px] text-gray-400">${escHtml(c.contact_phone)}</span>` : ''}
            ${assigneeHtml}
          </div>
        </div>
        <svg class="w-3.5 h-3.5 text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 ml-2" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/>
        </svg>
      </div>
    </a>
  `;
}

// ── Helpers ──────────────────────────────────────────────────
function getStatusDot(status) {
  if (status === 'critical') return '<span class="w-2 h-2 rounded-full bg-red-500 pulse-critical flex-shrink-0"></span>';
  if (status === 'warning') return '<span class="w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0"></span>';
  return '<span class="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0"></span>';
}

function getStatusBadge(status) {
  if (status === 'critical') return '<span class="px-1.5 py-0.5 text-[10px] font-medium bg-red-100 text-red-700 rounded-full leading-none">Crítico</span>';
  if (status === 'warning') return '<span class="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-100 text-yellow-700 rounded-full leading-none">Atenção</span>';
  return '<span class="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-100 text-emerald-700 rounded-full leading-none">OK</span>';
}

function getTimeBadge(hours) {
  if (hours >= 168) {
    const days = Math.round(hours / 24);
    return `<span class="px-1 py-0.5 text-[10px] font-medium bg-red-100 text-red-700 rounded leading-none">${days}d</span>`;
  }
  if (hours >= 72) {
    const days = Math.round(hours / 24);
    return `<span class="px-1 py-0.5 text-[10px] font-medium bg-orange-100 text-orange-700 rounded leading-none">${days}d</span>`;
  }
  if (hours >= 48) {
    return `<span class="px-1 py-0.5 text-[10px] font-medium bg-yellow-100 text-yellow-700 rounded leading-none">${hours}h</span>`;
  }
  return `<span class="px-1 py-0.5 text-[10px] font-medium bg-gray-100 text-gray-500 rounded leading-none">${hours}h</span>`;
}

function emptyState(message) {
  return `
    <div class="flex flex-col items-center justify-center py-10 text-center">
      <svg class="w-10 h-10 text-gray-200 mb-2" fill="none" stroke="currentColor" stroke-width="1" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      <p class="text-xs text-gray-400">${message}</p>
    </div>
  `;
}

function formatNumber(n) {
  if (n === undefined || n === null) return '-';
  return n.toLocaleString('pt-BR');
}

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function escHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escAttr(str) {
  if (!str) return '';
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
