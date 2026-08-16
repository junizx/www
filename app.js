/* =============================================================
   PoupaPix — app.js
   Estrutura:
   1. Estado global e persistência (localStorage)
   2. Migração de dados / garantias de formato
   3. Motor financeiro (FinanceEngine)
   4. Navegação entre telas e views
   5. Tela de seleção / criação de usuário (avatar, etc.)
   6. Views do app shell: Início, Resumo, Ajustes
   7. Modais: Gasto, Entrada, Posso comprar?, Metas, Onboarding
   8. Utilitários (formatação, toast, escape html)
   ============================================================= */

const STORAGE_KEY = 'poupapix_users_data';
const ACTIVE_USER_KEY = 'poupapix_active_user_id';
const MAX_USERS = 4;

const SAVING_MODES = {
  mao_de_vaca: 0.55,
  equilibrado: 0.45,
};

const EXPENSE_CATEGORIES = ['Comida', 'Transporte', 'Lazer', 'Outros'];
const INCOME_SOURCES = ['Salário', 'Pix', 'Transferência', 'Outros'];

const THEME_KEY = 'poupapix_theme';
const PIX_KEY = 'ec26e2c4-7756-4c53-917e-dab82d32cefb';
const DISCORD_LINK = 'https://discord.gg/Fe7JfaxS8';

let usersData = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
let activeUserId = localStorage.getItem(ACTIVE_USER_KEY) || null;
let selectedAvatarBase64 = null;
let currentModal = null; // nome do modal aberto no momento

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  updateThemeButtons(localStorage.getItem(THEME_KEY) || 'dark');

  if (activeUserId && usersData.some(u => u.id === activeUserId)) {
    enterDashboard(activeUserId);
  } else {
    renderUsersList();
    showScreen('screen-select-user');
  }
});

/* =============================================================
   1-2. Persistência e migração de dados
   ============================================================= */

function saveToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(usersData));
}

function getActiveUser() {
  return usersData.find(u => u.id === activeUserId) || null;
}

// Garante que todo usuário tenha o formato de dados atual, migrando
// usuários criados por uma versão anterior do app (que usava
// balance/protected_reserve em vez do modelo de transações + settings).
function ensureFinanceShape(user) {
  if (!user.finance) user.finance = {};

  if (!user.finance.settings) {
    user.finance.settings = {
      saving_mode: 'equilibrado',
      custom_percent: 45,
      onboarding_done: false,
    };
  }
  if (user.finance.settings.onboarding_done === undefined) {
    user.finance.settings.onboarding_done = false;
  }

  if (!Array.isArray(user.finance.transactions)) {
    user.finance.transactions = [];
  }
  if (!Array.isArray(user.finance.goals)) {
    user.finance.goals = [];
  }

  // Migração leve de transações antigas (campo "title" -> "label",
  // entradas antigas sem "saving_percent" assumem o valor legado de 15%).
  user.finance.transactions.forEach(tx => {
    if (tx.title && !tx.label) tx.label = tx.title;
    if (tx.type === 'income' && tx.saving_percent === undefined) {
      tx.saving_percent = 0.15;
    }
  });

  delete user.finance.balance;
  delete user.finance.protected_reserve;
}

/* =============================================================
   3. Motor financeiro
   ============================================================= */

const FinanceEngine = {
  getSavingPercent(user) {
    const s = user.finance.settings;
    if (s.saving_mode === 'personalizado') {
      return (s.custom_percent || 45) / 100;
    }
    return SAVING_MODES[s.saving_mode] ?? 0.45;
  },

  getTotalIncome(user) {
    return user.finance.transactions
      .filter(t => t.type === 'income')
      .reduce((sum, t) => sum + t.amount, 0);
  },

  getTotalProtected(user) {
    return user.finance.transactions
      .filter(t => t.type === 'income')
      .reduce((sum, t) => sum + t.amount * (t.saving_percent ?? 0.45), 0);
  },

  getTotalExpense(user) {
    return user.finance.transactions
      .filter(t => t.type === 'expense' || t.type === 'goal_contribution')
      .reduce((sum, t) => sum + t.amount, 0);
  },

  getFreeMoney(user) {
    return this.getTotalIncome(user) - this.getTotalProtected(user) - this.getTotalExpense(user);
  },

  getDaysRemainingInMonth() {
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return Math.max(1, lastDay - now.getDate() + 1);
  },

  getDailyLimit(user) {
    const free = this.getFreeMoney(user);
    if (free <= 0) return 0;
    return free / this.getDaysRemainingInMonth();
  },

  canAfford(user, amount) {
    if (!amount || amount <= 0) {
      return { allowed: false, level: 'danger', message: 'Informe um valor válido.' };
    }
    const daily = this.getDailyLimit(user);
    const free = this.getFreeMoney(user);

    if (amount <= daily) {
      return {
        allowed: true,
        level: 'good',
        message: 'Esse valor cabe tranquilamente no seu limite de hoje. Pode comprar!',
      };
    } else if (amount <= free) {
      return {
        allowed: true,
        level: 'warning',
        message: 'Cabe no seu dinheiro livre, mas passa do limite diário. Tente gastar menos nos próximos dias para compensar.',
      };
    }
    return {
      allowed: false,
      level: 'danger',
      message: 'Essa compra ultrapassa todo o seu dinheiro livre disponível. Melhor esperar ou economizar mais antes de comprar.',
    };
  },

  addIncome(user, amount, source, note) {
    user.finance.transactions.unshift({
      id: 'tx_' + Date.now(),
      type: 'income',
      amount,
      label: source,
      note: note || '',
      saving_percent: this.getSavingPercent(user),
      date: new Date().toISOString(),
    });
    saveToStorage();
  },

  addExpense(user, amount, category, note) {
    user.finance.transactions.unshift({
      id: 'tx_' + Date.now(),
      type: 'expense',
      amount,
      label: category,
      note: note || '',
      date: new Date().toISOString(),
    });
    saveToStorage();
  },

  addGoal(user, name, targetAmount) {
    user.finance.goals.push({
      id: 'goal_' + Date.now(),
      name,
      target_amount: targetAmount,
      saved_amount: 0,
      created: new Date().toISOString(),
    });
    saveToStorage();
  },

  contributeGoal(user, goalId, amount) {
    const goal = user.finance.goals.find(g => g.id === goalId);
    if (!goal) return;
    goal.saved_amount += amount;
    user.finance.transactions.unshift({
      id: 'tx_' + Date.now(),
      type: 'goal_contribution',
      amount,
      label: goal.name,
      goal_id: goalId,
      date: new Date().toISOString(),
    });
    saveToStorage();
  },
};

/* =============================================================
   4. Navegação entre telas (screens) e views (dentro do app shell)
   ============================================================= */

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(screen => {
    screen.classList.remove('active');
  });
  document.getElementById(screenId).classList.add('active');

  if (screenId === 'screen-create-user') {
    document.getElementById('username-input').value = '';
    document.getElementById('avatar-file-input').value = '';
    resetAvatarPreview();
    hideToast();
  }
}

function switchView(viewName) {
  document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + viewName).classList.add('active');

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  const user = getActiveUser();
  if (!user) return;

  if (viewName === 'home') renderHomeView(user);
  else if (viewName === 'summary') renderSummaryView(user);
  else if (viewName === 'settings') renderSettingsView(user);
}

function refreshCurrentView() {
  const activeViewEl = document.querySelector('.app-view.active');
  if (!activeViewEl) return;
  const viewName = activeViewEl.id.replace('view-', '');
  switchView(viewName);
}

/* =============================================================
   5. Seleção / criação de usuário
   ============================================================= */

function handleImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showToast('Escolha uma imagem válida!', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    selectedAvatarBase64 = e.target.result;
    const imgPreview = document.getElementById('avatar-img-preview');
    const defaultIcon = document.getElementById('avatar-default-icon');
    imgPreview.src = selectedAvatarBase64;
    imgPreview.classList.remove('hidden');
    defaultIcon.classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

function resetAvatarPreview() {
  selectedAvatarBase64 = null;
  const imgPreview = document.getElementById('avatar-img-preview');
  const defaultIcon = document.getElementById('avatar-default-icon');
  imgPreview.src = '';
  imgPreview.classList.add('hidden');
  defaultIcon.classList.remove('hidden');
}

function renderUsersList() {
  const usersListContainer = document.getElementById('users-list');
  const btnCreate = document.getElementById('btn-open-create');
  const limitWarning = document.getElementById('limit-warning');

  usersListContainer.innerHTML = '';

  usersData.forEach((user) => {
    const card = document.createElement('div');
    card.className = 'user-card';

    card.onclick = (e) => {
      if (!e.target.classList.contains('btn-delete-user')) {
        enterDashboard(user.id);
      }
    };

    const avatarHtml = user.avatar
      ? `<img src="${user.avatar}" class="user-avatar" alt="${escapeHtml(user.name)}">`
      : `<span class="user-avatar">👤</span>`;

    card.innerHTML = `
      <div class="user-card-info">
        ${avatarHtml}
        <span class="user-name">${escapeHtml(user.name)}</span>
      </div>
      <div class="user-card-actions">
        <span class="user-action">Entrar</span>
        <button class="btn-delete-user" onclick="deleteUser(event, '${user.id}', '${escapeHtml(user.name)}')">🗑️</button>
      </div>
    `;

    usersListContainer.appendChild(card);
  });

  if (usersData.length >= MAX_USERS) {
    btnCreate.classList.add('hidden');
    limitWarning.classList.remove('hidden');
  } else {
    btnCreate.classList.remove('hidden');
    limitWarning.classList.add('hidden');
  }
}

function handleCreateUser() {
  const input = document.getElementById('username-input');
  const name = input.value.trim();

  if (name === '') {
    showToast('Por favor, digite seu nome!', 'error');
    return;
  }
  if (usersData.length >= MAX_USERS) {
    showToast('Limite máximo de 4 usuários atingido!', 'error');
    return;
  }

  const newUser = {
    id: 'user_' + Date.now(),
    name,
    avatar: selectedAvatarBase64,
    created_at: new Date().toISOString(),
    finance: {
      settings: { saving_mode: 'equilibrado', custom_percent: 45, onboarding_done: false },
      transactions: [],
      goals: [],
    },
  };

  usersData.push(newUser);
  saveToStorage();
  showToast('Usuário criado com sucesso! ✓', 'success');

  setTimeout(() => {
    renderUsersList();
    showScreen('screen-select-user');
  }, 800);
}

function deleteUser(event, userId, userName) {
  event.stopPropagation();
  const confirmDelete = confirm(`Tem certeza que deseja excluir o usuário "${userName}"? Todos os dados dele serão apagados.`);
  if (!confirmDelete) return;

  usersData = usersData.filter(u => u.id !== userId);
  if (activeUserId === userId) {
    activeUserId = null;
    localStorage.removeItem(ACTIVE_USER_KEY);
  }
  saveToStorage();
  renderUsersList();
}

function enterDashboard(userId) {
  activeUserId = userId;
  localStorage.setItem(ACTIVE_USER_KEY, userId);

  const user = getActiveUser();
  if (!user) return;
  ensureFinanceShape(user);
  saveToStorage();

  renderShellHeader(user);
  switchView('home');
  showScreen('screen-app-shell');

  if (!user.finance.settings.onboarding_done) {
    openOnboardingModal();
  }
}

function logoutUser() {
  activeUserId = null;
  localStorage.removeItem(ACTIVE_USER_KEY);
  renderUsersList();
  showScreen('screen-select-user');
}

function renderShellHeader(user) {
  document.getElementById('dash-username').innerText = user.name;
  const avatarContainer = document.getElementById('dash-avatar-container');
  avatarContainer.innerHTML = user.avatar
    ? `<img src="${user.avatar}" class="user-avatar" alt="${escapeHtml(user.name)}">`
    : `<span class="user-avatar">👤</span>`;
}

/* =============================================================
   6. Views do app shell
   ============================================================= */

function renderHomeView(user) {
  const daily = FinanceEngine.getDailyLimit(user);
  const free = FinanceEngine.getFreeMoney(user);
  const protectedAmount = FinanceEngine.getTotalProtected(user);
  const isNegative = free < 0;

  const dailyEl = document.getElementById('home-daily-limit');
  dailyEl.innerText = formatCurrency(daily);
  dailyEl.classList.toggle('negative', isNegative);

  const freeEl = document.getElementById('home-free-money');
  freeEl.innerText = formatCurrency(free);
  freeEl.classList.toggle('text-red', isNegative);
  freeEl.classList.toggle('text-white', !isNegative);

  document.getElementById('home-protected').innerText = formatCurrency(protectedAmount);

  renderTransactionsList('home-transactions-list', user.finance.transactions.slice(0, 3));
}

function renderSummaryView(user) {
  document.getElementById('summary-income').innerText = formatCurrency(FinanceEngine.getTotalIncome(user));
  document.getElementById('summary-expense').innerText = formatCurrency(FinanceEngine.getTotalExpense(user));
  document.getElementById('summary-protected').innerText = formatCurrency(FinanceEngine.getTotalProtected(user));

  renderTransactionsList('summary-transactions-list', user.finance.transactions);
}

function renderTransactionsList(containerId, transactions) {
  const container = document.getElementById(containerId);

  if (!transactions || transactions.length === 0) {
    container.innerHTML = `<p class="empty-state">Nenhuma movimentação registrada ainda.</p>`;
    return;
  }

  container.innerHTML = '';
  transactions.forEach(tx => container.appendChild(buildTransactionItem(tx)));
}

function buildTransactionItem(tx) {
  const item = document.createElement('div');
  item.className = 'transaction-item';

  let sign = '+';
  let amountClass = 'tx-income';
  let icon = '💰';
  let title = tx.label || '';

  if (tx.type === 'expense') {
    sign = '-';
    amountClass = 'tx-expense';
    icon = expenseIcon(tx.label);
  } else if (tx.type === 'goal_contribution') {
    sign = '-';
    amountClass = 'tx-goal';
    icon = '🎯';
    title = 'Meta: ' + title;
  }

  item.innerHTML = `
    <span class="tx-icon">${icon}</span>
    <div class="tx-info">
      <span class="tx-title">${escapeHtml(title)}</span>
      <span class="tx-date">${formatTxDate(tx.date)}</span>
    </div>
    <span class="tx-amount ${amountClass}">${sign} ${formatCurrency(tx.amount)}</span>
  `;
  return item;
}

function expenseIcon(category) {
  switch (category) {
    case 'Comida': return '🍔';
    case 'Transporte': return '🚌';
    case 'Lazer': return '🎮';
    default: return '📦';
  }
}

function formatTxDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/* --- Ajustes --- */

function renderSettingsView(user) {
  document.getElementById('settings-name-input').value = user.name;
  document.getElementById('settings-name-input').onblur = () => saveSettingsName(user.id);

  const avatarImg = document.getElementById('settings-avatar-img-preview');
  const avatarIcon = document.getElementById('settings-avatar-default-icon');
  if (user.avatar) {
    avatarImg.src = user.avatar;
    avatarImg.classList.remove('hidden');
    avatarIcon.classList.add('hidden');
  } else {
    avatarImg.classList.add('hidden');
    avatarIcon.classList.remove('hidden');
  }

  renderSavingModeOptions(user);
}

function saveSettingsName(userId) {
  const user = usersData.find(u => u.id === userId);
  if (!user) return;
  const newName = document.getElementById('settings-name-input').value.trim();
  if (newName === '') return;
  user.name = newName;
  saveToStorage();
  renderShellHeader(user);
}

function handleSettingsAvatarUpload(event) {
  const file = event.target.files[0];
  if (!file || !file.type.startsWith('image/')) {
    showToast('Escolha uma imagem válida!', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = function (e) {
    const user = getActiveUser();
    if (!user) return;
    user.avatar = e.target.result;
    saveToStorage();
    renderShellHeader(user);
    renderSettingsView(user);
  };
  reader.readAsDataURL(file);
}

const MODE_INFO = {
  mao_de_vaca: { title: 'Mão de Vaca (55%)', desc: 'Guarda 55% de cada entrada. Para quem quer economizar rápido.' },
  equilibrado: { title: 'Equilibrado (45%)', desc: 'Guarda 45% de cada entrada. Bom equilíbrio entre poupar e viver.' },
  personalizado: { title: 'Personalizado', desc: 'Escolha você mesmo o percentual guardado a cada entrada.' },
};

function renderSavingModeOptions(user) {
  const container = document.getElementById('settings-mode-options');
  container.innerHTML = '';

  const currentMode = user.finance.settings.saving_mode;

  Object.keys(MODE_INFO).forEach(mode => {
    const info = MODE_INFO[mode];
    const el = document.createElement('div');
    el.className = 'mode-option' + (mode === currentMode ? ' selected' : '');
    el.innerHTML = `
      <span class="mode-option-title">${mode === currentMode ? '✅ ' : ''}${info.title}</span>
      <span class="mode-option-desc">${info.desc}</span>
    `;
    el.onclick = () => {
      user.finance.settings.saving_mode = mode;
      saveToStorage();
      renderSettingsView(user);
    };
    container.appendChild(el);
  });

  const customWrapper = document.getElementById('settings-custom-wrapper');
  const slider = document.getElementById('settings-custom-slider');
  const label = document.getElementById('settings-custom-label');

  if (currentMode === 'personalizado') {
    customWrapper.classList.remove('hidden');
    slider.value = user.finance.settings.custom_percent || 45;
    label.innerText = `Reservar ${slider.value}% de cada entrada`;
    slider.oninput = () => {
      user.finance.settings.custom_percent = parseInt(slider.value, 10);
      label.innerText = `Reservar ${slider.value}% de cada entrada`;
      saveToStorage();
    };
  } else {
    customWrapper.classList.add('hidden');
  }
}

function exportBackup() {
  const user = getActiveUser();
  if (!user) return;
  const blob = new Blob([JSON.stringify(user, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `poupapix_backup_${user.name.replace(/\s+/g, '_')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Backup baixado!', 'success');
}

function confirmResetUserData() {
  const user = getActiveUser();
  if (!user) return;
  const ok = confirm('Isso vai apagar todas as suas entradas, gastos e metas (seu perfil continua). Deseja continuar?');
  if (!ok) return;

  user.finance.transactions = [];
  user.finance.goals = [];
  user.finance.settings = { saving_mode: 'equilibrado', custom_percent: 45, onboarding_done: true };
  saveToStorage();
  showToast('Dados resetados.', 'success');
  switchView('home');
}

/* =============================================================
   7. Modais
   ============================================================= */

function openModal(name, title) {
  currentModal = name;
  document.getElementById('modal-title').innerText = title;
  document.getElementById('modal-root').classList.remove('hidden');
}

function closeModal() {
  currentModal = null;
  document.getElementById('modal-root').classList.add('hidden');
  document.getElementById('modal-body').innerHTML = '';
}

/* --- Registrar Gasto --- */

function openAddExpenseModal() {
  openModal('add_expense', 'Registrar Gasto');
  const body = document.getElementById('modal-body');

  let selectedCategory = EXPENSE_CATEGORIES[0];

  body.innerHTML = `
    <div>
      <span class="field-label">Valor gasto</span>
      <input type="number" id="expense-amount" class="modal-amount-input" placeholder="0,00" min="0" step="0.01" inputmode="decimal">
    </div>
    <div>
      <span class="field-label">Categoria</span>
      <div id="expense-category-grid" class="pill-grid" style="margin-top:8px;"></div>
    </div>
    <div>
      <span class="field-label">Observação (opcional)</span>
      <input type="text" id="expense-note" placeholder="Ex: almoço com amigos">
    </div>
    <button class="btn-primary" id="expense-save-btn">Salvar gasto</button>
  `;

  const grid = document.getElementById('expense-category-grid');
  EXPENSE_CATEGORIES.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'pill-btn' + (cat === selectedCategory ? ' selected' : '');
    btn.innerText = `${expenseIcon(cat)} ${cat}`;
    btn.onclick = () => {
      selectedCategory = cat;
      grid.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    };
    grid.appendChild(btn);
  });

  document.getElementById('expense-save-btn').onclick = () => {
    const user = getActiveUser();
    const amount = parseFloat(document.getElementById('expense-amount').value);
    if (!amount || amount <= 0) {
      showToast('Informe um valor válido.', 'error');
      return;
    }
    const note = document.getElementById('expense-note').value.trim();
    FinanceEngine.addExpense(user, amount, selectedCategory, note);
    showToast('Gasto registrado!', 'success');
    closeModal();
    refreshCurrentView();
  };
}

/* --- Adicionar Dinheiro --- */

function openAddIncomeModal() {
  openModal('add_income', 'Adicionar Dinheiro');
  const body = document.getElementById('modal-body');
  const user = getActiveUser();

  let selectedSource = INCOME_SOURCES[0];

  body.innerHTML = `
    <div>
      <span class="field-label">Valor recebido</span>
      <input type="number" id="income-amount" class="modal-amount-input" placeholder="0,00" min="0" step="0.01" inputmode="decimal">
    </div>
    <div>
      <span class="field-label">Origem</span>
      <div id="income-source-grid" class="pill-grid" style="margin-top:8px;"></div>
    </div>
    <div>
      <span class="field-label">Observação (opcional)</span>
      <input type="text" id="income-note" placeholder="">
    </div>
    <div class="preview-box" id="income-preview"></div>
    <button class="btn-primary" id="income-save-btn">Salvar entrada</button>
  `;

  const grid = document.getElementById('income-source-grid');
  INCOME_SOURCES.forEach(src => {
    const btn = document.createElement('button');
    btn.className = 'pill-btn' + (src === selectedSource ? ' selected' : '');
    btn.innerText = src;
    btn.onclick = () => {
      selectedSource = src;
      grid.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    };
    grid.appendChild(btn);
  });

  const amountInput = document.getElementById('income-amount');
  const updatePreview = () => {
    const amount = parseFloat(amountInput.value) || 0;
    const pct = FinanceEngine.getSavingPercent(user);
    const protectedAmount = amount * pct;
    const freeAmount = amount - protectedAmount;
    document.getElementById('income-preview').innerText =
      `Dessa entrada, ${formatCurrency(protectedAmount)} vão para a reserva (${Math.round(pct * 100)}%) e ${formatCurrency(freeAmount)} ficam livres pra gastar.`;
  };
  amountInput.oninput = updatePreview;
  updatePreview();

  document.getElementById('income-save-btn').onclick = () => {
    const amount = parseFloat(amountInput.value);
    if (!amount || amount <= 0) {
      showToast('Informe um valor válido.', 'error');
      return;
    }
    const note = document.getElementById('income-note').value.trim();
    FinanceEngine.addIncome(user, amount, selectedSource, note);
    showToast('Entrada registrada!', 'success');
    closeModal();
    refreshCurrentView();
  };
}

/* --- Posso comprar? --- */

function openCanIBuyModal() {
  openModal('can_i_buy', 'Posso comprar?');
  const body = document.getElementById('modal-body');
  const user = getActiveUser();

  body.innerHTML = `
    <div>
      <span class="field-label">Quanto custa o que você quer comprar?</span>
      <input type="number" id="can-i-buy-amount" class="modal-amount-input" placeholder="0,00" min="0" step="0.01" inputmode="decimal">
    </div>
    <button class="btn-primary" id="can-i-buy-check-btn">Verificar</button>
    <div id="can-i-buy-result" class="result-box"></div>
  `;

  const check = () => {
    const amount = parseFloat(document.getElementById('can-i-buy-amount').value);
    const result = FinanceEngine.canAfford(user, amount);
    const box = document.getElementById('can-i-buy-result');
    box.className = 'result-box visible ' + result.level;

    const icon = result.level === 'good' ? '✅' : result.level === 'warning' ? '⚠️' : '❌';
    const heading = result.allowed ? 'Pode comprar' : 'Melhor não comprar';

    box.innerHTML = `
      <span class="result-title">${icon} ${heading}</span>
      <span class="result-message">${result.message}</span>
    `;
  };

  document.getElementById('can-i-buy-check-btn').onclick = check;
  document.getElementById('can-i-buy-amount').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') check();
  });
}

/* --- Metas --- */

function openGoalsModal() {
  openModal('goals', 'Metas');
  const body = document.getElementById('modal-body');
  const user = getActiveUser();

  body.innerHTML = `
    <button class="btn-primary" id="new-goal-btn">🎯 Nova meta</button>
    <div id="goals-list"></div>
  `;

  document.getElementById('new-goal-btn').onclick = openAddGoalModal;

  const list = document.getElementById('goals-list');
  if (user.finance.goals.length === 0) {
    list.innerHTML = `<p class="empty-state">Você ainda não tem metas. Crie uma para economizar com propósito.</p>`;
    return;
  }

  list.style.display = 'flex';
  list.style.flexDirection = 'column';
  list.style.gap = '12px';
  list.style.marginTop = '16px';

  user.finance.goals.forEach(goal => {
    const pct = goal.target_amount > 0
      ? Math.min(100, (goal.saved_amount / goal.target_amount) * 100)
      : 0;

    const card = document.createElement('div');
    card.className = 'goal-card';
    card.innerHTML = `
      <span class="goal-name">${escapeHtml(goal.name)}</span>
      <div class="goal-progress-bg"><div class="goal-progress-fill" style="width:${pct}%"></div></div>
      <span class="goal-progress-text">${formatCurrency(goal.saved_amount)} de ${formatCurrency(goal.target_amount)} (${pct.toFixed(0)}%)</span>
      <button class="pill-btn goal-contribute-btn">💵 Contribuir</button>
    `;
    card.querySelector('.goal-contribute-btn').onclick = () => openContributeGoalModal(goal.id, goal.name);
    list.appendChild(card);
  });
}

function openAddGoalModal() {
  openModal('add_goal', 'Nova Meta');
  const body = document.getElementById('modal-body');

  body.innerHTML = `
    <div>
      <span class="field-label">Nome da meta</span>
      <input type="text" id="goal-name" placeholder="Ex: Viagem, Notebook novo...">
    </div>
    <div>
      <span class="field-label">Valor alvo</span>
      <input type="number" id="goal-amount" class="modal-amount-input" placeholder="0,00" min="0" step="0.01" inputmode="decimal">
    </div>
    <button class="btn-primary" id="goal-save-btn">Criar meta</button>
  `;

  document.getElementById('goal-save-btn').onclick = () => {
    const user = getActiveUser();
    const name = document.getElementById('goal-name').value.trim();
    const amount = parseFloat(document.getElementById('goal-amount').value);
    if (name === '' || !amount || amount <= 0) {
      showToast('Preencha o nome e um valor alvo válido.', 'error');
      return;
    }
    FinanceEngine.addGoal(user, name, amount);
    showToast('Meta criada!', 'success');
    openGoalsModal();
  };
}

function openContributeGoalModal(goalId, goalName) {
  openModal('contribute_goal', 'Contribuir');
  const body = document.getElementById('modal-body');

  body.innerHTML = `
    <p class="field-label">Contribuir para: <strong style="color:#FFFFFF;">${escapeHtml(goalName)}</strong></p>
    <div>
      <span class="field-label">Valor a guardar</span>
      <input type="number" id="contribute-amount" class="modal-amount-input" placeholder="0,00" min="0" step="0.01" inputmode="decimal">
    </div>
    <p class="settings-hint">Esse valor sai do seu dinheiro livre disponível.</p>
    <button class="btn-primary" id="contribute-save-btn">Confirmar</button>
  `;

  document.getElementById('contribute-save-btn').onclick = () => {
    const user = getActiveUser();
    const amount = parseFloat(document.getElementById('contribute-amount').value);
    if (!amount || amount <= 0) {
      showToast('Informe um valor válido.', 'error');
      return;
    }
    FinanceEngine.contributeGoal(user, goalId, amount);
    showToast('Contribuição registrada!', 'success');
    openGoalsModal();
  };
}

/* --- Sobre --- */

function openAboutModal() {
  openModal('about', 'Sobre');
  const body = document.getElementById('modal-body');

  body.innerHTML = `
    <div class="about-hero">
      <div class="about-icon">🐷</div>
      <h3>PoupaPix</h3>
      <p class="settings-hint">Quanto posso gastar hoje sem deixar de economizar?</p>
    </div>

    <p class="about-text">
      O PoupaPix é um app de finanças pessoais simples, rápido e 100% offline.
      Ele existe pra responder uma pergunta só, todo dia: quanto você pode gastar
      hoje sem comprometer o que já decidiu guardar?
    </p>

    <div class="settings-card">
      <span class="settings-card-title">O que o app faz</span>
      <ul class="about-list">
        <li>💸 Registra gastos por categoria (Comida, Transporte, Lazer, Outros)</li>
        <li>➕ Registra entradas por origem (Salário, Pix, Transferência, Outros)</li>
        <li>🐷 Reserva automática — modo Mão de Vaca, Equilibrado ou Personalizado</li>
        <li>📈 Calcula sozinho seu limite de gasto diário</li>
        <li>📊 Resumo com extrato completo, sem gráficos</li>
        <li>🎯 Metas de economia com acompanhamento de progresso</li>
        <li>🤔 "Posso comprar?" avalia se uma compra cabe no seu planejamento</li>
        <li>🌙 Tema claro e escuro</li>
        <li>👥 Suporta até ${MAX_USERS} perfis no mesmo aparelho</li>
      </ul>
    </div>

    <div class="settings-card">
      <span class="settings-card-title">Privacidade</span>
      <p class="settings-hint">
        Todos os seus dados ficam salvos apenas neste navegador (localStorage).
        Não existe conta, servidor, nem coleta de dados — se você limpar os dados
        do navegador ou trocar de aparelho, use o backup em Ajustes pra não perder nada.
      </p>
    </div>

    <div class="settings-card">
      <span class="settings-card-title">Contato</span>
      <button class="btn-secondary-full" onclick="copyPixKey()">💚 Copiar chave Pix</button>
      <a class="btn-secondary-full btn-link" href="${DISCORD_LINK}" target="_blank" rel="noopener noreferrer">💬 Entrar no Discord</a>
    </div>

    <p class="settings-version">PoupaPix v0.2 (Web) — feito com 💚</p>
  `;
}

/* --- Onboarding (primeira vez que o usuário entra) --- */

function openOnboardingModal() {
  openModal('onboarding', 'Bem-vindo(a)! 💚');
  document.querySelector('.modal-close').classList.add('hidden');

  const body = document.getElementById('modal-body');
  const user = getActiveUser();
  let selectedMode = 'equilibrado';

  body.innerHTML = `
    <p class="settings-hint">Vamos te ajudar a responder, todo dia: quanto você pode gastar hoje sem deixar de economizar?</p>
    <span class="field-label" style="margin-top:8px;">Escolha seu modo de economia</span>
    <div id="onboarding-mode-options" class="settings-mode-options"></div>
    <div id="onboarding-custom-wrapper" class="settings-custom-wrapper hidden">
      <input type="range" id="onboarding-custom-slider" min="5" max="90" step="1" value="45">
      <span id="onboarding-custom-label" class="settings-custom-label"></span>
    </div>
    <button class="btn-primary" id="onboarding-start-btn">Começar</button>
  `;

  const optionsContainer = document.getElementById('onboarding-mode-options');
  const customWrapper = document.getElementById('onboarding-custom-wrapper');
  const slider = document.getElementById('onboarding-custom-slider');
  const label = document.getElementById('onboarding-custom-label');

  function renderOptions() {
    optionsContainer.innerHTML = '';
    Object.keys(MODE_INFO).forEach(mode => {
      const info = MODE_INFO[mode];
      const el = document.createElement('div');
      el.className = 'mode-option' + (mode === selectedMode ? ' selected' : '');
      el.innerHTML = `
        <span class="mode-option-title">${mode === selectedMode ? '✅ ' : ''}${info.title}</span>
        <span class="mode-option-desc">${info.desc}</span>
      `;
      el.onclick = () => {
        selectedMode = mode;
        renderOptions();
        customWrapper.classList.toggle('hidden', selectedMode !== 'personalizado');
      };
      optionsContainer.appendChild(el);
    });
  }
  renderOptions();

  label.innerText = `Reservar ${slider.value}% de cada entrada`;
  slider.oninput = () => { label.innerText = `Reservar ${slider.value}% de cada entrada`; };

  document.getElementById('onboarding-start-btn').onclick = () => {
    let percent = 45;
    if (selectedMode === 'mao_de_vaca') percent = 55;
    else if (selectedMode === 'personalizado') percent = parseInt(slider.value, 10);

    user.finance.settings.saving_mode = selectedMode;
    user.finance.settings.custom_percent = percent;
    user.finance.settings.onboarding_done = true;
    saveToStorage();

    document.querySelector('.modal-close').classList.remove('hidden');
    closeModal();
    refreshCurrentView();
  };
}

/* =============================================================
   8. Tema claro/escuro, Pix e Discord
   ============================================================= */

function updateThemeButtons(theme) {
  const icon = theme === 'light' ? '🌙' : '☀️';
  document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
    btn.innerText = icon;
  });
}

function applyTheme(theme) {
  document.documentElement.classList.toggle('theme-light', theme === 'light');
  localStorage.setItem(THEME_KEY, theme);
  updateThemeButtons(theme);
}

function toggleTheme() {
  const current = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

function copyPixKey() {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(PIX_KEY)
      .then(() => showToast('Chave Pix copiada! 💚', 'success'))
      .catch(() => showToast('Não foi possível copiar. Chave: ' + PIX_KEY, 'error'));
  } else {
    showToast('Chave Pix: ' + PIX_KEY, 'success');
  }
}

/* =============================================================
   9. Utilitários
   ============================================================= */

function formatCurrency(value) {
  return (value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function showToast(message, type) {
  const toast = document.getElementById('toast-message');
  toast.innerText = message;
  toast.className = `toast ${type}`;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(hideToast, 2200);
}

function hideToast() {
  const toast = document.getElementById('toast-message');
  toast.className = 'toast hidden';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.innerText = text;
  return div.innerHTML;
}
