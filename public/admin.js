'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const statuses = { new: 'Yeni', contacted: 'Görüşülüyor', completed: 'Tamamlandı', archived: 'Eski arşiv' };
  const moneyFormat = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' });
  const dateFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', timeZone: 'Europe/Istanbul' });
  const fullDateFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' });
  let csrfToken = '';
  let leads = [];
  let selectedId = null;
  let authenticated = false;
  let loading = false;
  let authGeneration = 0;
  let leadCounts = null;
  let currentFolder = 'active';
  let leadsRequest = 0;
  let deleteLeadId = null;
  let deleting = false;
  let deleteRequest = 0;
  const savingLeads = new Set();
  const deletingLeads = new Set();
  let mfaEnabled = false;
  let mfaRequired = true;
  let backupCodes = [];
  let currentSection = 'requests';
  let securityLoading = false;
  let changingMfaDevice = false;
  let automationLoading = false;
  let automationRequest = 0;
  let automationReady = false;
  let screenLockTimer;
  const drafts = new Map();
  const projectCategories = { production: 'Prodüksiyon', drone: 'Drone', editing: 'Kurgu & efekt', digital: 'Dijital' };
  const stages = { inquiry: 'İlk talep', proposal: 'Teklif', waiting: 'Dönüş bekleniyor', scheduled: 'Planlandı', production: 'Üretimde', review: 'İncelemede', delivered: 'Teslim edildi' };
  let projects = [];
  let selectedProjectId = null;
  let portfolioRequest = 0;
  let trackingRequest = 0;
  let projectDirty = false;
  let projectEditorRequest = 0;
  const uploads = new Set();
  const shareLinks = new Map();
  const trackingDrafts = new Map();
  const deliveryLeadIds = new Map();

  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        method: options.method || 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.csrf ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch {
      throw new ApiError('Sunucuya ulaşılamadı. Bağlantını kontrol edip tekrar dene.', 0);
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(typeof result.error === 'string' ? result.error : 'İşlem tamamlanamadı. Tekrar dene.', response.status, result.code);
    if (authenticated) resetScreenLock();
    return result;
  }

  function message(target, value = '', kind = 'error') {
    target.textContent = value;
    target.classList.toggle('is-error', Boolean(value) && kind === 'error');
    target.classList.toggle('is-success', Boolean(value) && kind === 'success');
  }

  function el(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value ?? '');
    return node;
  }

  function readableDate(value, full = false) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Tarih bilgisi yok' : (full ? fullDateFormat : dateFormat).format(date);
  }

  function badge(status) {
    const node = el('span', 'status-badge', statuses[status] || 'Yeni');
    node.dataset.status = statuses[status] ? status : 'new';
    return node;
  }

  function showLogin(note = '', configured = true) {
    window.clearTimeout(screenLockTimer);
    authGeneration += 1;
    authenticated = false;
    csrfToken = '';
    leads = [];
    leadCounts = null;
    selectedId = null;
    leadsRequest += 1;
    loading = false;
    currentFolder = 'active';
    savingLeads.clear();
    deletingLeads.clear();
    clearDeleteDialog();
    mfaEnabled = false;
    mfaRequired = true;
    clearSecuritySecrets();
    clearAutomation();
    clearStudio();
    drafts.clear();
    $('leads-list').replaceChildren();
    $('detail-content').replaceChildren();
    $('detail-content').hidden = true;
    $('detail-empty').hidden = false;
    $('detail-panel').setAttribute('aria-labelledby', 'detail-heading');
    for (const id of ['count-active', 'count-new', 'count-contacted', 'count-completed', 'sidebar-count', 'completed-sidebar-count', 'visible-count', 'tracking-sidebar-count']) $(id).textContent = '0';
    $('tracking-sidebar-count').hidden = true;
    $('updated-time').textContent = '';
    $('user-name').textContent = 'Yönetici';
    $('user-initial').textContent = 'O';
    message($('dashboard-message'));
    $('list-state').replaceChildren();
    $('password').value = '';
    $('login-code').value = '';
    $('search').value = '';
    $('status-filter').value = 'all';
    $('archived-nav').hidden = true;
    $('mobile-archived-nav').hidden = true;
    $('initial-state').hidden = true;
    $('dashboard-view').hidden = true;
    $('login-view').hidden = false;
    $('setup-help').hidden = configured;
    $('login-button').disabled = !configured;
    $('username').disabled = !configured;
    $('password').disabled = !configured;
    $('login-code').disabled = !configured;
    message($('login-message'), note);
  }

  async function showDashboard(session) {
    if (typeof session.csrfToken !== 'string' || !session.csrfToken) {
      showLogin('Oturum bilgisi doğrulanamadı. Sayfayı yenileyip tekrar giriş yap.');
      return;
    }
    authGeneration += 1;
    csrfToken = session.csrfToken;
    authenticated = true;
    mfaEnabled = session.mfaEnabled === true;
    mfaRequired = session.mfaRequired === true || !mfaEnabled;
    resetScreenLock();
    clearSecuritySecrets();
    clearAutomation();
    const username = typeof session.username === 'string' ? session.username : 'Yönetici';
    $('user-name').textContent = username;
    $('user-initial').textContent = username.slice(0, 1).toLocaleUpperCase('tr-TR');
    $('password').value = '';
    $('login-code').value = '';
    $('initial-state').hidden = true;
    $('login-view').hidden = true;
    $('dashboard-view').hidden = false;
    $('today').textContent = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Istanbul' }).format(new Date());
    updateSecurityNavigation();
    if (mfaRequired) await showSecurity(false);
    else await showRequests();
  }

  function handleAuthError(error) {
    if (error.status !== 401) return false;
    showLogin('Oturumun sona erdi. Devam etmek için tekrar giriş yap.');
    $('username').focus();
    return true;
  }

  function resetScreenLock() {
    window.clearTimeout(screenLockTimer);
    const generation = authGeneration;
    screenLockTimer = window.setTimeout(() => {
      if (authenticated && generation === authGeneration) showLogin('Güvenliğin için panel kilitlendi. Devam etmek için tekrar giriş yap.');
    }, (mfaRequired ? 10 : 15) * 60 * 1000);
  }

  function clearSecuritySecrets() {
    backupCodes = [];
    changingMfaDevice = false;
    for (const id of ['setup-password', 'setup-existing-code', 'setup-code', 'mfa-secret', 'recovery-password', 'recovery-code']) $(id).value = '';
    $('backup-codes').replaceChildren();
    $('backup-panel').hidden = true;
    $('mfa-secret-step').hidden = true;
    $('mfa-setup-form').hidden = false;
    $('recovery-details').open = false;
    message($('copy-message'));
    message($('security-message'));
    message($('assistant-message'));
  }

  function updateSecurityNavigation() {
    const restricted = mfaRequired || !mfaEnabled;
    $('requests-nav').disabled = restricted || backupCodes.length > 0;
    $('mobile-requests-nav').disabled = restricted || backupCodes.length > 0;
    for (const id of ['completed-nav', 'mobile-completed-nav', 'archived-nav', 'mobile-archived-nav', 'tracking-nav', 'mobile-tracking-nav', 'portfolio-nav', 'mobile-portfolio-nav']) $(id).disabled = restricted || backupCodes.length > 0;
    $('automation-nav').disabled = restricted || backupCodes.length > 0;
    $('mobile-automation-nav').disabled = restricted || backupCodes.length > 0;
    $('requests-nav').title = restricted ? 'Önce iki aşamalı doğrulamayı tamamla' : '';
    $('automation-nav').title = restricted ? 'Önce iki aşamalı doğrulamayı tamamla' : '';
    $('mfa-required-notice').hidden = !restricted;
    $('assistant-card').hidden = restricted || backupCodes.length > 0;
    $('mfa-setup-panel').hidden = (mfaEnabled && !changingMfaDevice) || backupCodes.length > 0;
    $('mfa-enabled-panel').hidden = !mfaEnabled || changingMfaDevice || backupCodes.length > 0;
    $('setup-existing-code-field').hidden = !changingMfaDevice;
    $('setup-existing-code').required = changingMfaDevice;
    $('cancel-mfa-change').hidden = !changingMfaDevice;
    $('security-badge').textContent = mfaEnabled ? '◈ İki aşamalı koruma etkin' : '◈ Kurulumu tamamla';
    $('security-badge').classList.toggle('is-enabled', mfaEnabled);
    $('requests-nav').classList.toggle('active', currentSection === 'requests' && currentFolder === 'active');
    $('completed-nav').classList.toggle('active', currentSection === 'requests' && currentFolder === 'completed');
    $('archived-nav').classList.toggle('active', currentSection === 'requests' && currentFolder === 'archived');
    $('security-nav').classList.toggle('active', currentSection === 'security');
    $('automation-nav').classList.toggle('active', currentSection === 'automation');
    $('tracking-nav').classList.toggle('active', currentSection === 'tracking');
    $('portfolio-nav').classList.toggle('active', currentSection === 'portfolio');
    for (const [id, section, folder] of [['requests-nav', 'requests', 'active'], ['mobile-requests-nav', 'requests', 'active'], ['completed-nav', 'requests', 'completed'], ['mobile-completed-nav', 'requests', 'completed'], ['archived-nav', 'requests', 'archived'], ['mobile-archived-nav', 'requests', 'archived'], ['security-nav', 'security'], ['mobile-security-nav', 'security'], ['automation-nav', 'automation'], ['mobile-automation-nav', 'automation'], ['portfolio-nav', 'portfolio'], ['mobile-portfolio-nav', 'portfolio'], ['tracking-nav', 'tracking'], ['mobile-tracking-nav', 'tracking']]) {
      if (currentSection === section && (!folder || folder === currentFolder)) $(id).setAttribute('aria-current', 'page');
      else $(id).removeAttribute('aria-current');
    }
  }

  async function showRequests(folder = 'active') {
    if (!authenticated || mfaRequired || !mfaEnabled || backupCodes.length) return;
    const changed = currentFolder !== folder;
    currentFolder = ['active', 'completed', 'archived'].includes(folder) ? folder : 'active';
    clearDeleteDialog();
    if (changed) {
      $('status-filter').value = 'all';
      closeDetail(false);
    }
    currentSection = 'requests';
    $('requests').hidden = false;
    $('security-section').hidden = true;
    $('automation-section').hidden = true;
    $('portfolio-section').hidden = true;
    $('tracking-section').hidden = true;
    renderFolder();
    updateSecurityNavigation();
    await refreshLeads();
  }

  async function showSecurity(focus = true) {
    if (!authenticated) return;
    clearDeleteDialog();
    currentSection = 'security';
    $('requests').hidden = true;
    $('security-section').hidden = false;
    $('automation-section').hidden = true;
    $('portfolio-section').hidden = true;
    $('tracking-section').hidden = true;
    updateSecurityNavigation();
    if (focus) $('security-title').focus({ preventScroll: true });
    if (securityLoading) return;
    const generation = authGeneration;
    securityLoading = true;
    try {
      const result = await api('/api/admin/security');
      if (generation !== authGeneration) return;
      if (typeof result.mfaEnabled !== 'boolean') throw new ApiError('Güvenlik durumu okunamadı. Sayfayı yenileyip tekrar dene.', 0);
      mfaEnabled = result.mfaEnabled;
      mfaRequired = !mfaEnabled;
      $('recovery-count').textContent = Number.isSafeInteger(result.recoveryCodesRemaining) ? String(result.recoveryCodesRemaining) : '—';
      updateSecurityNavigation();
    } catch (error) {
      if (generation !== authGeneration || handleAuthError(error)) return;
      message($('security-message'), error.message);
    } finally { securityLoading = false; }
  }

  function securityError(error) {
    if (error.status === 401 && ['INVALID_CREDENTIALS', 'MFA_INVALID', 'AUTH_FAILED', 'INVALID_PASSWORD'].includes(error.code)) {
      message($('security-message'), error.message);
      return;
    }
    if (!handleAuthError(error)) message($('security-message'), error.message);
  }

  function clearAutomation() {
    automationRequest += 1;
    automationLoading = false;
    automationReady = false;
    $('automation-summaries').replaceChildren();
    $('automation-summary-count').textContent = '0';
    $('automation-enabled').checked = false;
    $('automation-enabled').disabled = true;
    $('automation-save').disabled = true;
    $('automation-refresh').disabled = false;
    $('automation-refresh-icon').classList.remove('is-spinning');
    $('automation-summaries').removeAttribute('aria-busy');
    $('automation-status').textContent = 'Durum yükleniyor…';
    $('automation-status').removeAttribute('data-status');
    $('automation-empty').hidden = false;
    $('automation-empty').textContent = 'Özetler yükleniyor…';
    $('automation-key-help').hidden = true;
    $('automation-retry-row').hidden = true;
    for (const id of ['automation-model', 'automation-pending', 'automation-last-run', 'automation-next-run', 'automation-retry-at']) $(id).textContent = '—';
    $('automation-failed').hidden = true;
    $('automation-failed').textContent = '';
    $('automation-last-error').hidden = true;
    $('automation-last-error').textContent = '';
    message($('automation-message'));
  }

  async function showAutomation() {
    if (!authenticated || mfaRequired || !mfaEnabled || backupCodes.length) return;
    clearDeleteDialog();
    currentSection = 'automation';
    $('requests').hidden = true;
    $('security-section').hidden = true;
    $('automation-section').hidden = false;
    $('portfolio-section').hidden = true;
    $('tracking-section').hidden = true;
    updateSecurityNavigation();
    $('automation-title').focus({ preventScroll: true });
    await loadAutomation();
  }

  function renderAutomation(result) {
    if (!result || typeof result.enabled !== 'boolean' || typeof result.configured !== 'boolean' || !Array.isArray(result.summaries)) {
      throw new ApiError('Otomasyon durumu okunamadı. Durumu yenileyip tekrar dene.', 0);
    }
    const labels = {
      disabled: 'Otomatik özetler kapalı', needs_key: 'API anahtarı bekleniyor', scheduled: 'Saatlik çalışma planlandı',
      running: 'Asistan talepleri inceliyor', waiting_retry: 'Yeniden deneme bekleniyor', error: 'Çalışma kontrol gerektiriyor',
    };
    $('automation-status').textContent = Object.hasOwn(labels, result.status) ? labels[result.status] : 'Durum bilgisi alınamadı';
    $('automation-status').dataset.status = Object.hasOwn(labels, result.status) ? result.status : 'error';
    $('automation-enabled').checked = result.enabled;
    $('automation-key-help').hidden = result.configured;
    $('automation-model').textContent = `Groq / ${typeof result.model === 'string' && result.model ? result.model : 'Model bilgisi yok'}`;
    $('automation-pending').textContent = Number.isSafeInteger(result.pendingCount) && result.pendingCount >= 0 ? String(result.pendingCount) : '—';
    $('automation-last-run').textContent = result.lastRunAt ? readableDate(result.lastRunAt, true) : 'Henüz çalışmadı';
    $('automation-next-run').textContent = result.nextRunAt ? readableDate(result.nextRunAt, true) : result.enabled ? 'Planlama bekleniyor' : 'Otomasyon kapalı';
    $('automation-retry-row').hidden = !result.retryAt;
    $('automation-retry-at').textContent = result.retryAt ? readableDate(result.retryAt, true) : '—';
    $('automation-failed').hidden = !(Number.isSafeInteger(result.failedCount) && result.failedCount > 0);
    $('automation-failed').textContent = result.failedCount > 0 ? `${result.failedCount} talep üç geçersiz yanıttan sonra otomatik sıradan ayrıldı. Asıl talepler gelen kutusunda korunuyor; açıklamalarını kontrol edin.` : '';
    $('automation-last-error').hidden = typeof result.lastError !== 'string' || !result.lastError;
    $('automation-last-error').textContent = typeof result.lastError === 'string' ? result.lastError : '';
    const summaries = result.summaries.filter((entry) => entry && typeof entry === 'object').slice(0, 100);
    const fragment = document.createDocumentFragment();
    for (const entry of summaries) {
      const item = el('li', 'automation-summary');
      const top = el('div', 'automation-summary-top');
      const name = typeof entry.name === 'string' && entry.name ? entry.name : 'İsimsiz talep';
      top.append(el('h3', '', name), el('span', 'automation-summary-date', readableDate(entry.createdAt, true)));
      item.append(top, el('p', 'automation-summary-text', typeof entry.summary === 'string' ? entry.summary : 'Özet bilgisi yok.'));
      const needs = Array.isArray(entry.needs) ? entry.needs.filter((need) => typeof need === 'string').slice(0, 10) : [];
      if (needs.length) {
        const list = el('ul', 'automation-needs');
        list.setAttribute('aria-label', 'Belirlenen ihtiyaçlar');
        list.append(...needs.map((need) => el('li', '', need)));
        item.append(list);
      }
      if (typeof entry.nextStep === 'string' && entry.nextStep) {
        const next = el('div', 'automation-next-step');
        next.append(el('strong', '', 'Önerilen sonraki adım'), el('p', '', entry.nextStep));
        item.append(next);
      }
      fragment.append(item);
    }
    $('automation-summaries').replaceChildren(fragment);
    $('automation-summary-count').textContent = String(summaries.length);
    $('automation-empty').hidden = summaries.length > 0;
    $('automation-empty').textContent = result.enabled
      ? (result.configured ? 'İlk özetler sıradaki saatlik çalışmadan sonra burada görünecek.' : 'API anahtarını terminalden eklediğinde otomatik özetler hazırlanabilecek.')
      : 'Henüz bir özet yok. Paylaşım tercihini kaydederek saatlik asistanı başlatabilirsin.';
    automationReady = true;
  }

  function setAutomationBusy(busy) {
    automationLoading = busy;
    $('automation-refresh').disabled = busy;
    $('automation-enabled').disabled = busy || !automationReady;
    $('automation-save').disabled = busy || !automationReady;
    $('automation-refresh-icon').classList.toggle('is-spinning', busy);
    $('automation-summaries').setAttribute('aria-busy', String(busy));
  }

  async function loadAutomation(enabled) {
    if (!authenticated || mfaRequired || !mfaEnabled || backupCodes.length || automationLoading) return;
    const generation = authGeneration;
    const request = ++automationRequest;
    const saving = typeof enabled === 'boolean';
    setAutomationBusy(true);
    message($('automation-message'));
    try {
      const result = await api('/api/admin/automation', saving ? { method: 'POST', csrf: true, body: { enabled } } : {});
      if (generation !== authGeneration || request !== automationRequest) return;
      renderAutomation(result);
      if (saving) message($('automation-message'), result.enabled
        ? (result.configured ? 'Saatlik asistan etkin. Sonraki çalışma zamanını aşağıdan takip edebilirsin.' : 'Paylaşım tercihin kaydedildi. API anahtarı eklenene kadar Groq çağrısı yapılmaz.')
        : 'Otomatik özetler kapatıldı. Yeni bir saatlik çalışma başlatılmayacak.', 'success');
    } catch (error) {
      if (generation !== authGeneration || request !== automationRequest || handleAuthError(error)) return;
      message($('automation-message'), error.message);
      if (!automationReady) $('automation-empty').textContent = 'Özetler yüklenemedi. Durumu yenileyerek tekrar deneyebilirsin.';
    } finally {
      if (generation === authGeneration && request === automationRequest) setAutomationBusy(false);
    }
  }

  $('automation-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (automationReady && !automationLoading) loadAutomation($('automation-enabled').checked);
  });
  $('automation-refresh').addEventListener('click', () => loadAutomation());

  function downloadFile(contents, name, type) {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const link = el('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showBackupCodes(result) {
    if (!Array.isArray(result.recoveryCodes) || result.recoveryCodes.length === 0 || !result.recoveryCodes.every((code) => typeof code === 'string' && code.length <= 64)) {
      throw new ApiError('Kurtarma kodları alınamadı. Güvenlik bölümünden yeni kodlar oluştur.', 0);
    }
    backupCodes = result.recoveryCodes.slice();
    $('recovery-count').textContent = String(backupCodes.length);
    if (typeof result.csrfToken === 'string' && result.csrfToken) csrfToken = result.csrfToken;
    $('backup-codes').replaceChildren(...backupCodes.map((code) => el('li', '', code)));
    $('backup-panel').hidden = false;
    $('mfa-secret').value = '';
    $('setup-code').value = '';
    $('mfa-secret-step').hidden = true;
    $('recovery-details').open = false;
    updateSecurityNavigation();
    $('backup-title').focus();
  }

  $('mfa-setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('mfa-setup-button').disabled) return;
    const generation = authGeneration;
    $('mfa-setup-button').disabled = true;
    message($('security-message'));
    try {
      const result = await api('/api/admin/mfa/setup', { method: 'POST', csrf: true, body: { password: $('setup-password').value, ...(changingMfaDevice ? { code: $('setup-existing-code').value.trim() } : {}) } });
      if (generation !== authGeneration) return;
      if (typeof result.secret !== 'string' || !/^[A-Z2-7]{16,128}$/.test(result.secret)) throw new ApiError('Kurulum anahtarı okunamadı. Tekrar dene.', 0);
      $('mfa-secret').value = result.secret;
      $('mfa-setup-form').hidden = true;
      $('mfa-secret-step').hidden = false;
      $('setup-code').focus();
    } catch (error) { if (generation === authGeneration) securityError(error); }
    finally { $('setup-password').value = ''; $('setup-existing-code').value = ''; $('mfa-setup-button').disabled = false; }
  });

  $('change-mfa-device').addEventListener('click', () => {
    clearSecuritySecrets();
    changingMfaDevice = true;
    updateSecurityNavigation();
    $('setup-password').focus();
  });

  $('cancel-mfa-change').addEventListener('click', () => {
    clearSecuritySecrets();
    updateSecurityNavigation();
    $('change-mfa-device').focus();
  });

  $('restart-mfa-setup').addEventListener('click', () => {
    $('mfa-secret').value = '';
    $('setup-code').value = '';
    $('mfa-secret-step').hidden = true;
    $('mfa-setup-form').hidden = false;
    message($('copy-message'));
    message($('security-message'));
    $('setup-password').focus();
  });

  $('copy-secret').addEventListener('click', async () => {
    if (!$('mfa-secret').value) return;
    try {
      await navigator.clipboard.writeText($('mfa-secret').value);
      message($('copy-message'), 'Kopyalandı. Authenticator uygulamana yapıştır.', 'success');
    } catch {
      $('mfa-secret').focus();
      $('mfa-secret').select();
      message($('copy-message'), 'Anahtarı seçtik. Ctrl+C veya cihazının kopyalama menüsünü kullan.', 'success');
    }
  });

  $('mfa-enable-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('mfa-enable-button').disabled) return;
    const generation = authGeneration;
    $('mfa-enable-button').disabled = true;
    message($('security-message'));
    try {
      const result = await api('/api/admin/mfa/enable', { method: 'POST', csrf: true, body: { code: $('setup-code').value.trim() } });
      if (generation !== authGeneration) return;
      mfaEnabled = true;
      mfaRequired = false;
      resetScreenLock();
      showBackupCodes(result);
      message($('security-message'), 'İki aşamalı doğrulama etkin. Şimdi kurtarma kodlarını güvenle sakla.', 'success');
    } catch (error) { if (generation === authGeneration) securityError(error); }
    finally { $('setup-code').value = ''; $('mfa-enable-button').disabled = false; }
  });

  $('recovery-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('recovery-button').disabled) return;
    const generation = authGeneration;
    $('recovery-button').disabled = true;
    message($('security-message'));
    try {
      const result = await api('/api/admin/mfa/recovery-codes', { method: 'POST', csrf: true, body: { password: $('recovery-password').value, code: $('recovery-code').value.trim() } });
      if (generation !== authGeneration) return;
      showBackupCodes(result);
      message($('security-message'), 'Eski kurtarma kodları geçersiz oldu. Yeni kodlarını güvenle sakla.', 'success');
    } catch (error) { if (generation === authGeneration) securityError(error); }
    finally { $('recovery-password').value = ''; $('recovery-code').value = ''; $('recovery-button').disabled = false; }
  });

  $('download-codes').addEventListener('click', () => {
    if (!backupCodes.length) return;
    downloadFile(`Ordvis Creative — tek kullanımlık kurtarma kodları\n\nHer kod yalnızca bir kez kullanılabilir. Kimseyle paylaşma.\n\n${backupCodes.join('\n')}\n`, 'ordvis-kurtarma-kodlari.txt', 'text/plain;charset=utf-8');
  });

  $('confirm-codes').addEventListener('click', async () => {
    clearSecuritySecrets();
    updateSecurityNavigation();
    message($('security-message'), 'Hesabın hazır. Artık taleplerini güvenle yönetebilirsin.', 'success');
    await showSecurity(false);
  });

  $('assistant-export-button').addEventListener('click', async () => {
    if (!authenticated || mfaRequired || !mfaEnabled || $('assistant-export-button').disabled) return;
    const generation = authGeneration;
    $('assistant-export-button').disabled = true;
    message($('assistant-message'));
    try {
      const result = await api('/api/admin/assistant-export');
      if (generation !== authGeneration) return;
      const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul' }).format(new Date());
      downloadFile(JSON.stringify(result, null, 2), `ordvis-asistan-ozeti-${date}.json`, 'application/json;charset=utf-8');
      message($('assistant-message'), 'Özet indirildi. İçeriğini gözden geçir; paylaşmak istediğinde dosyayı bu sohbete ekle.', 'success');
    } catch (error) {
      if (generation !== authGeneration || handleAuthError(error)) return;
      message($('assistant-message'), error.message);
    } finally { $('assistant-export-button').disabled = false; }
  });

  function renderCounts(counts = null) {
    const fallback = {
      total: leads.length,
      new: leads.filter((lead) => lead.status === 'new').length,
      contacted: leads.filter((lead) => lead.status === 'contacted').length,
      completed: leads.filter((lead) => lead.status === 'completed').length,
      archived: leads.filter((lead) => lead.status === 'archived').length,
    };
    leadCounts = {};
    for (const key of ['total', 'new', 'contacted', 'completed', 'archived']) {
      const count = Number.isSafeInteger(counts?.[key]) && counts[key] >= 0 ? counts[key] : fallback[key];
      leadCounts[key] = count;
      if (['new', 'contacted', 'completed'].includes(key)) $(`count-${key}`).textContent = String(count);
    }
    $('count-active').textContent = String(leadCounts.new + leadCounts.contacted);
    $('sidebar-count').textContent = $('count-new').textContent;
    $('completed-sidebar-count').textContent = String(leadCounts.completed);
    renderTrackingCount(leads);
    for (const id of ['archived-nav', 'mobile-archived-nav']) $(id).hidden = leadCounts.archived === 0 && currentFolder !== 'archived';
  }

  function belongsToFolder(lead) {
    return currentFolder === 'active' ? ['new', 'contacted'].includes(lead.status) : lead.status === currentFolder;
  }

  function renderFolder() {
    const folders = {
      active: { eyebrow: 'YENİ BİR HİKÂYENİN İLK ADIMI', title: 'Gelen ', emphasis: 'fikirler.', description: 'Yeni ve görüşülen talepler burada. Tamamlanan işler kendi klasöründe.', list: 'Proje talepleri', label: 'GELEN KUTUSU' },
      completed: { eyebrow: 'BİRLİKTE ÜRETTİK. İZ BIRAKTIK.', title: 'Tamamlanan ', emphasis: 'işler.', description: 'Teslim edilen projeler ve aldığın ödemeler tek bir yerde.', list: 'Tamamlanan işler', label: 'İŞ DOSYASI' },
      archived: { eyebrow: 'STÜDYONUN ÖNCEKİ KAYITLARI', title: 'Eski ', emphasis: 'arşiv.', description: 'Önceden arşivlediğin talepler burada korunuyor. Bu kayıtlar tamamlanmış iş sayılmaz.', list: 'Eski arşiv', label: 'ÖNCEKİ KAYITLAR' },
    };
    const folder = folders[currentFolder];
    $('folder-eyebrow').textContent = folder.eyebrow;
    $('dashboard-title').replaceChildren(document.createTextNode(folder.title), el('em', '', folder.emphasis));
    $('folder-description').textContent = folder.description;
    $('folder-list-title').textContent = folder.list;
    $('folder-label').textContent = folder.label;
    $('status-filter-field').hidden = currentFolder !== 'active';
    $('leads-list').setAttribute('aria-label', folder.list);
    renderList();
  }

  async function refreshLeads() {
    if (!authenticated || mfaRequired || !mfaEnabled) return;
    const generation = authGeneration;
    const request = ++leadsRequest;
    loading = true;
    $('refresh-button').disabled = true;
    $('refresh-icon').classList.add('is-spinning');
    $('leads-list').setAttribute('aria-busy', 'true');
    message($('dashboard-message'));
    if (!leads.length) $('list-state').textContent = 'Talepler yükleniyor…';
    try {
      const result = await api('/api/admin/leads');
      if (generation !== authGeneration || request !== leadsRequest) return;
      if (!Array.isArray(result.leads)) throw new ApiError('Talepler okunamadı. Sayfayı yenileyip tekrar dene.', 0);
      leads = result.leads.filter((lead) => lead && typeof lead.id === 'string');
      leads.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
      renderCounts(result.counts);
      renderList();
      if (selectedId) {
        if (leads.some((lead) => lead.id === selectedId && belongsToFolder(lead))) renderDetail();
        else closeDetail(false);
      }
      $('updated-time').textContent = `Son yenileme ${new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' }).format(new Date())}`;
    } catch (error) {
      if (generation !== authGeneration || request !== leadsRequest || handleAuthError(error)) return;
      message($('dashboard-message'), error.message);
      if (!leads.length) $('list-state').textContent = 'Talepler yüklenemedi. “Talepleri yenile” ile tekrar deneyebilirsin.';
    } finally {
      if (generation !== authGeneration || request !== leadsRequest) return;
      loading = false;
      $('refresh-button').disabled = false;
      $('refresh-icon').classList.remove('is-spinning');
      $('leads-list').removeAttribute('aria-busy');
    }
  }

  function renderList() {
    const query = $('search').value.trim().toLocaleLowerCase('tr-TR');
    const filter = $('status-filter').value;
    const filtered = leads.filter((lead) => (
      belongsToFolder(lead) && (currentFolder !== 'active' || filter === 'all' || lead.status === filter)
      && (!query || [lead.brand, lead.name, lead.email, lead.phone].some((value) => String(value || '').toLocaleLowerCase('tr-TR').includes(query)))
    )).sort((a, b) => (Date.parse(currentFolder === 'completed' ? b.completedAt : b.createdAt) || 0) - (Date.parse(currentFolder === 'completed' ? a.completedAt : a.createdAt) || 0));
    $('visible-count').textContent = String(filtered.length);
    document.querySelectorAll('[data-stat]').forEach((node) => node.setAttribute('aria-pressed', String(currentFolder === 'completed' ? node.dataset.stat === 'completed' : currentFolder === 'active' && node.dataset.stat === filter)));
    const fragment = document.createDocumentFragment();
    for (const lead of filtered) {
      const item = el('li');
      const button = el('button', 'lead-button');
      button.type = 'button';
      button.dataset.leadId = lead.id;
      button.setAttribute('aria-pressed', String(lead.id === selectedId));
      button.setAttribute('aria-controls', 'detail-panel');
      const brand = String(lead.brand || 'İsimsiz marka');
      const avatar = el('span', 'lead-avatar', brand.trim().slice(0, 2).toLocaleUpperCase('tr-TR'));
      avatar.setAttribute('aria-hidden', 'true');
      const summary = el('span', 'lead-summary');
      const top = el('span', 'lead-top');
      top.append(el('strong', 'lead-brand', brand), el('span', 'lead-date', readableDate(lead.createdAt)));
      const bottom = el('span', 'lead-bottom');
      bottom.append(el('span', 'lead-plan', lead.plan || 'Birlikte karar verelim'), badge(lead.status));
      summary.append(top, el('span', 'lead-person', lead.name || lead.email || lead.phone || 'İletişim detayı belirtilmedi'), bottom);
      if (currentFolder === 'completed' && Number.isSafeInteger(lead.paymentReceivedCents)) summary.append(el('span', 'lead-payment', `${moneyFormat.format(lead.paymentReceivedCents / 100)} tahsil edildi`));
      button.append(avatar, summary);
      button.addEventListener('click', () => selectLead(lead.id));
      item.append(button);
      fragment.append(item);
    }
    $('leads-list').replaceChildren(fragment);
    $('list-state').replaceChildren();
    if (!filtered.length) {
      const inFolder = leads.some(belongsToFolder);
      $('list-state').append(
        el('strong', '', query || inFolder ? 'Bu filtrede talep yok.' : currentFolder === 'completed' ? 'İyi işler burada birikecek.' : currentFolder === 'archived' ? 'Eski arşiv artık boş.' : 'Yeni başlangıçlara hazır.'),
        el('span', '', query || inFolder ? 'Aramayı değiştir veya başka bir durum seç.' : currentFolder === 'completed' ? 'Bir talebi tamamlayıp alınan ödemeyi kaydettiğinde burada görünür.' : currentFolder === 'archived' ? 'Yeni ve tamamlanan işler kendi klasörlerinde.' : 'Siteden gönderilen proje talepleri burada birikecek.'),
      );
    }
  }

  function selectLead(id) {
    selectedId = id;
    renderList();
    renderDetail();
    if (window.matchMedia('(max-width: 950px)').matches) {
      $('detail-panel').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    }
    const heading = $('selected-lead-heading');
    heading?.focus({ preventScroll: true });
  }

  function closeDetail(focus = true) {
    const previousId = selectedId;
    selectedId = null;
    $('detail-content').hidden = true;
    $('detail-content').replaceChildren();
    $('detail-empty').hidden = false;
    $('detail-panel').setAttribute('aria-labelledby', 'detail-heading');
    renderList();
    const previousButton = Array.from($('leads-list').querySelectorAll('button')).find((button) => button.dataset.leadId === previousId);
    if (focus) previousButton?.focus({ preventScroll: true });
  }

  function contactRow(symbol, value, href) {
    const row = el('div', 'contact-row');
    const icon = el('span', 'contact-symbol', symbol);
    icon.setAttribute('aria-hidden', 'true');
    const text = el(href ? 'a' : 'span', '', value || 'Belirtilmedi');
    if (href) text.href = href;
    row.append(icon, text);
    return row;
  }

  function paymentCents(value) {
    const match = /^(0|[1-9]\d{0,8})(?:[.,](\d{1,2}))?$/.exec(String(value).trim());
    if (!match) return null;
    const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
    return Number.isSafeInteger(amount) && amount > 0 && amount <= 99999999999 ? amount : null;
  }

  function paymentValue(lead) {
    return Number.isSafeInteger(lead.paymentReceivedCents) ? (lead.paymentReceivedCents / 100).toFixed(2) : '';
  }

  function invalidateLeadLoad() {
    leadsRequest += 1;
    loading = false;
    $('refresh-button').disabled = false;
    $('refresh-icon').classList.remove('is-spinning');
    $('leads-list').removeAttribute('aria-busy');
  }

  function renderDetail() {
    const lead = leads.find((entry) => entry.id === selectedId);
    if (!lead) return;
    const draft = drafts.get(lead.id) || { status: lead.status, notes: lead.notes || '', paymentReceived: paymentValue(lead) };
    const content = document.createDocumentFragment();
    const topline = el('div', 'detail-topline');
    topline.append(el('span', 'detail-label', 'PROJE / DETAY'));
    const close = el('button', 'detail-back', 'Kapat ×');
    close.type = 'button';
    close.addEventListener('click', closeDetail);
    topline.append(close);
    const title = el('h2', 'detail-title', lead.brand || 'İsimsiz marka');
    title.id = 'selected-lead-heading';
    title.tabIndex = -1;
    const contacts = el('div', 'detail-contact');
    const email = String(lead.email || '');
    const phone = String(lead.phone || '');
    const phoneTarget = phone.replace(/[^+0-9]/g, '');
    contacts.append(
      contactRow('○', lead.name),
      contactRow('@', email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `mailto:${encodeURIComponent(email)}` : null),
      contactRow('↗', phone, /^\+?\d{7,15}$/.test(phoneTarget) ? `tel:${phoneTarget}` : null),
    );
    content.append(topline, title, el('p', 'detail-date', readableDate(lead.createdAt, true)), badge(lead.status), contacts);
    content.append(el('h3', 'detail-section-label', 'İLGİLENDİĞİ PAKET'), el('span', 'detail-plan', lead.plan || 'Birlikte karar verelim'));
    content.append(el('h3', 'detail-section-label', 'AKLINDAKİ PROJE'), el('p', 'detail-brief', lead.brief || 'Proje özeti belirtilmedi.'));
    if (lead.briefDetails && typeof lead.briefDetails === 'object') {
      const briefDetails = el('dl', 'brief-detail-list');
      for (const [key, label] of [['service', 'Hizmet'], ['goal', 'Hedef'], ['location', 'Lokasyon'], ['deadline', 'Hedef tarih'], ['budgetRange', 'Bütçe aralığı']]) {
        if (!lead.briefDetails[key]) continue;
        const row = el('div');
        row.append(el('dt', '', label), el('dd', '', key === 'service' ? projectCategories[lead.briefDetails[key]] || lead.briefDetails[key] : lead.briefDetails[key]));
        briefDetails.append(row);
      }
      if (briefDetails.childNodes.length) content.append(briefDetails);
    }
    if (Number.isSafeInteger(lead.paymentReceivedCents) && lead.paymentReceivedCents > 0) {
      const receipt = el('div', 'payment-record');
      receipt.append(el('span', '', 'ALINAN ÖDEME'), el('strong', '', moneyFormat.format(lead.paymentReceivedCents / 100)));
      if (lead.completedAt) receipt.append(el('span', '', `İlk tamamlanma: ${readableDate(lead.completedAt, true)}`));
      if (lead.status !== 'completed' && lead.completedAt) receipt.append(el('p', '', 'İş yeniden açıldı. Önceki ödeme kaydı korunuyor.'));
      content.append(receipt);
    }

    const form = el('form', 'detail-editor');
    const statusLabel = el('label', '', 'Talep durumu');
    statusLabel.htmlFor = 'lead-status';
    const status = el('select');
    status.id = 'lead-status';
    for (const [value, text] of Object.entries(statuses)) {
      if (value === 'archived' && lead.status !== 'archived') continue;
      const option = el('option', '', text);
      option.value = value;
      option.selected = value === draft.status;
      status.append(option);
    }
    const paymentField = el('div', 'payment-field');
    const paymentLabel = el('label', '', 'Alınan toplam ödeme (TL)');
    paymentLabel.htmlFor = 'lead-payment';
    const payment = el('input');
    payment.id = 'lead-payment';
    payment.type = 'text';
    payment.inputMode = 'decimal';
    payment.maxLength = 12;
    payment.autocomplete = 'off';
    payment.placeholder = 'Örn. 12500,50';
    payment.value = draft.paymentReceived ?? paymentValue(lead);
    payment.setAttribute('aria-describedby', 'lead-payment-help');
    const paymentHelp = el('p', 'field-help', 'İşi tamamlamak için aldığın toplam ödemeyi gir. Binlik ayırıcı kullanma; kuruş için virgül veya nokta kullanabilirsin. Bu tutar önceki kaydın yerini alır.');
    paymentHelp.id = 'lead-payment-help';
    paymentField.append(paymentLabel, payment, paymentHelp);
    const notesLabel = el('label', '', 'Stüdyo notları');
    notesLabel.htmlFor = 'lead-notes';
    const notes = el('textarea');
    notes.id = 'lead-notes';
    notes.rows = 4;
    notes.maxLength = 4000;
    notes.placeholder = 'İlk görüşme, beklentiler, sonraki adım…';
    notes.value = draft.notes;
    const draftNote = el('p', 'draft-note');
    const saveButton = el('button', 'button primary', 'Değişiklikleri kaydet');
    saveButton.type = 'submit';
    const arrow = el('span', '', '↗');
    arrow.setAttribute('aria-hidden', 'true');
    saveButton.append(arrow);
    const statusMessage = el('p', 'message detail-message');
    statusMessage.setAttribute('role', 'status');
    form.append(statusLabel, status, paymentField, notesLabel, notes, draftNote, saveButton, statusMessage);
    const trackDraft = () => {
      paymentField.hidden = status.value !== 'completed';
      payment.required = status.value === 'completed';
      payment.setCustomValidity(payment.required && payment.value && paymentCents(payment.value) === null ? 'Sıfırdan büyük bir TL tutarı gir. Örnek: 12500,50. En fazla 999999999,99 TL.' : '');
      const changed = status.value !== lead.status || notes.value !== (lead.notes || '') || (status.value === 'completed' && paymentCents(payment.value) !== lead.paymentReceivedCents);
      if (changed) drafts.set(lead.id, { status: status.value, notes: notes.value, paymentReceived: payment.value });
      else drafts.delete(lead.id);
      draftNote.textContent = changed ? 'Kaydedilmemiş değişikliklerin var.' : 'Notlar yalnızca stüdyo ekibine görünür.';
      saveButton.disabled = !changed || savingLeads.has(lead.id) || deletingLeads.has(lead.id);
      message(statusMessage);
    };
    status.addEventListener('change', trackDraft);
    notes.addEventListener('input', trackDraft);
    payment.addEventListener('input', trackDraft);
    trackDraft();
    const deleteButton = el('button', 'button danger-outline', 'Talebi kalıcı olarak sil');
    deleteButton.type = 'button';
    deleteButton.disabled = savingLeads.has(lead.id) || deletingLeads.has(lead.id);
    deleteButton.addEventListener('click', () => openDeleteDialog(lead));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saveButton.disabled || deletingLeads.has(lead.id) || !form.reportValidity()) return;
      const generation = authGeneration;
      const payload = { status: status.value, notes: notes.value.trim(), ...(status.value === 'completed' ? { paymentReceived: payment.value.trim() } : {}) };
      savingLeads.add(lead.id);
      invalidateLeadLoad();
      saveButton.disabled = true;
      status.disabled = true;
      notes.disabled = true;
      payment.disabled = true;
      deleteButton.disabled = true;
      form.setAttribute('aria-busy', 'true');
      saveButton.firstChild.textContent = 'Kaydediliyor…';
      message(statusMessage);
      try {
        const result = await api(`/api/admin/leads/${encodeURIComponent(lead.id)}`, { method: 'PATCH', body: payload, csrf: true });
        if (generation !== authGeneration) return;
        if (!result.lead || result.lead.id !== lead.id) throw new ApiError('Güncel kayıt okunamadı. Talepleri yenile.', 0);
        invalidateLeadLoad();
        const index = leads.findIndex((entry) => entry.id === lead.id);
        if (index >= 0) leads[index] = result.lead;
        if (generation === authGeneration) savingLeads.delete(lead.id);
        drafts.delete(lead.id);
        renderCounts();
        renderList();
        if (selectedId === lead.id) {
          if (belongsToFolder(result.lead)) {
            renderDetail();
            const savedMessage = $('detail-content').querySelector('.detail-message');
            if (savedMessage) message(savedMessage, 'Kaydedildi. Bir sonraki iyi işe.', 'success');
          } else {
            closeDetail(false);
            message($('dashboard-message'), payload.status === 'completed' ? 'İş ve ödeme kaydedildi. Tamamlanan işler klasöründe seni bekliyor.' : 'Talep yeniden açıldı. Proje talepleri klasörüne taşındı.', 'success');
          }
        } else {
          message($('dashboard-message'), 'Talep güncellendi.', 'success');
        }
      } catch (error) {
        if (generation !== authGeneration || handleAuthError(error)) return;
        savingLeads.delete(lead.id);
        if (selectedId === lead.id) {
          renderDetail();
          const currentMessage = $('detail-content').querySelector('.detail-message');
          if (currentMessage) message(currentMessage, error.message);
        }
        else message($('dashboard-message'), error.message);
      } finally {
        if (generation === authGeneration) savingLeads.delete(lead.id);
        status.disabled = false;
        notes.disabled = false;
        payment.disabled = false;
        deleteButton.disabled = false;
        form.removeAttribute('aria-busy');
        saveButton.firstChild.textContent = 'Değişiklikleri kaydet';
      }
    });
    if (savingLeads.has(lead.id) || deletingLeads.has(lead.id)) {
      status.disabled = true;
      payment.disabled = true;
      notes.disabled = true;
      saveButton.disabled = true;
      form.setAttribute('aria-busy', 'true');
    }
    const deleteArea = el('div', 'detail-delete');
    deleteArea.append(deleteButton, el('p', 'field-help', 'Kaydı saklamak için durumu “Tamamlandı” yap. Silme işlemi kalıcıdır.'));
    content.append(form, trackingEditor(lead), deliveryEditor(lead), deleteArea);
    $('detail-empty').hidden = true;
    $('detail-content').hidden = false;
    $('detail-content').replaceChildren(content);
    $('detail-panel').setAttribute('aria-labelledby', 'selected-lead-heading');
  }

  function clearDeleteDialog() {
    deleteRequest += 1;
    deleteLeadId = null;
    deleting = false;
    if ($('delete-dialog').open) $('delete-dialog').close();
    $('delete-lead-name').textContent = '';
    $('delete-confirmation').value = '';
    $('delete-confirmation').disabled = false;
    $('delete-confirm').disabled = true;
    $('delete-confirm').textContent = 'Kalıcı olarak sil';
    $('delete-cancel').disabled = false;
    $('delete-form').removeAttribute('aria-busy');
    message($('delete-message'));
  }

  function openDeleteDialog(lead) {
    if (!authenticated || mfaRequired || !mfaEnabled || savingLeads.has(lead.id) || deletingLeads.has(lead.id)) return;
    clearDeleteDialog();
    deleteLeadId = lead.id;
    $('delete-lead-name').textContent = `${lead.brand || 'İsimsiz marka'} / ${lead.name || 'İsimsiz kişi'}`;
    $('delete-dialog').showModal();
    $('delete-cancel').focus();
  }

  $('delete-cancel').addEventListener('click', clearDeleteDialog);
  $('delete-dialog').addEventListener('cancel', (event) => { event.preventDefault(); clearDeleteDialog(); });
  $('delete-confirmation').addEventListener('input', () => {
    $('delete-confirm').disabled = deleting || $('delete-confirmation').value.trim().toLocaleUpperCase('tr-TR') !== 'SİL';
  });
  $('delete-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (deleting || !deleteLeadId || $('delete-confirmation').value.trim().toLocaleUpperCase('tr-TR') !== 'SİL' || !authenticated || mfaRequired || !mfaEnabled) return;
    const id = deleteLeadId;
    const generation = authGeneration;
    const request = deleteRequest;
    deleting = true;
    deletingLeads.add(id);
    if (selectedId === id) renderDetail();
    invalidateLeadLoad();
    $('delete-confirm').disabled = true;
    $('delete-confirm').textContent = 'Siliniyor…';
    $('delete-confirmation').disabled = true;
    $('delete-form').setAttribute('aria-busy', 'true');
    message($('delete-message'));
    try {
      await api(`/api/admin/leads/${encodeURIComponent(id)}`, { method: 'DELETE', csrf: true, body: { confirmation: 'SİL' } });
      if (generation !== authGeneration) return;
      invalidateLeadLoad();
      leads = leads.filter((lead) => lead.id !== id);
      drafts.delete(id);
      trackingDrafts.delete(id);
      for (const [deliveryId, leadId] of deliveryLeadIds) if (leadId === id) { shareLinks.delete(deliveryId); deliveryLeadIds.delete(deliveryId); }
      deletingLeads.delete(id);
      renderCounts();
      if (selectedId === id) closeDetail(false);
      else renderList();
      clearAutomation();
      if (currentSection === 'automation') void loadAutomation();
      if (request === deleteRequest) clearDeleteDialog();
      message($('dashboard-message'), 'Talep ve ilişkili kayıtları kalıcı olarak silindi.', 'success');
    } catch (error) {
      if (generation !== authGeneration || handleAuthError(error)) return;
      if (request === deleteRequest) message($('delete-message'), error.message);
      else message($('dashboard-message'), error.message);
    } finally {
      if (generation === authGeneration) deletingLeads.delete(id);
      if (generation === authGeneration && selectedId === id) renderDetail();
      if (generation === authGeneration && request === deleteRequest) {
        deleting = false;
        $('delete-confirmation').disabled = false;
        $('delete-confirm').disabled = $('delete-confirmation').value.trim().toLocaleUpperCase('tr-TR') !== 'SİL';
        $('delete-confirm').textContent = 'Kalıcı olarak sil';
        $('delete-form').removeAttribute('aria-busy');
      }
    }
  });

  function clearStudio() {
    portfolioRequest += 1;
    trackingRequest += 1;
    for (const upload of uploads) upload.abort();
    uploads.clear();
    projects = [];
    selectedProjectId = null;
    projectDirty = false;
    projectEditorRequest += 1;
    trackingDrafts.clear();
    shareLinks.clear();
    deliveryLeadIds.clear();
    for (const id of ['project-list', 'project-editor', 'tracking-summary', 'tracking-reminders', 'tracking-board']) $(id).replaceChildren();
    for (const id of ['portfolio-message', 'tracking-message']) message($(id));
  }

  function studioAllowed() { return authenticated && !mfaRequired && mfaEnabled && !backupCodes.length; }

  function showStudioSection(section) {
    if (!studioAllowed()) return false;
    clearDeleteDialog();
    currentSection = section;
    for (const [id, name] of [['requests', 'requests'], ['security-section', 'security'], ['automation-section', 'automation'], ['portfolio-section', 'portfolio'], ['tracking-section', 'tracking']]) $(id).hidden = section !== name;
    updateSecurityNavigation();
    $(`${section}-title`).focus({ preventScroll: true });
    return true;
  }

  function field(label, id, { tag = 'input', type = 'text', value = '', required = false, maxLength, placeholder = '', options } = {}) {
    const wrapper = el('div', 'studio-field');
    const caption = el('label', '', label);
    caption.htmlFor = id;
    const control = el(tag);
    control.id = id;
    control.name = id;
    if (tag === 'input') control.type = type;
    if (tag === 'textarea') control.rows = 3;
    if (maxLength) control.maxLength = maxLength;
    control.required = required;
    if (placeholder) control.placeholder = placeholder;
    if (options) for (const [key, text] of Object.entries(options)) {
      const option = el('option', '', text); option.value = key; control.append(option);
    }
    control.value = value ?? '';
    wrapper.append(caption, control);
    return { wrapper, control };
  }

  function localMediaUrl(value, prefix = '/api/admin/') {
    if (typeof value !== 'string' || !value.startsWith(prefix)) return null;
    try { const url = new URL(value, location.origin); return url.origin === location.origin ? url.href : null; } catch { return null; }
  }

  function fileSize(value) {
    return Number.isFinite(value) ? value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(value / 1024))} KB` : '';
  }

  function fileType(file) {
    const known = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'application/pdf'];
    if (known.includes(file.type)) return file.type;
    const extension = file.name.split('.').pop().toLowerCase();
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf' }[extension] || '';
  }

  function uploadFile(path, file, allowed, target) {
    const type = fileType(file);
    const max = type.startsWith('image/') ? 8 * 1024 * 1024 : 100 * 1024 * 1024;
    if (!allowed.includes(type)) return Promise.reject(new ApiError('Bu dosya türü desteklenmiyor. Belirtilen biçimlerden birini seç.', 400));
    if (!file.size || file.size > max) return Promise.reject(new ApiError(`Dosya boş olamaz ve ${max === 8 * 1024 * 1024 ? '8' : '100'} MB sınırını aşamaz.`, 400));
    const generation = authGeneration;
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      uploads.add(request);
      request.open('POST', path);
      request.timeout = 5 * 60 * 1000;
      request.setRequestHeader('Content-Type', type);
      request.setRequestHeader('Accept', 'application/json');
      request.setRequestHeader('X-CSRF-Token', csrfToken);
      const fail = (text) => { uploads.delete(request); reject(new ApiError(text, 0)); };
      request.upload.addEventListener('progress', (event) => {
        if (generation !== authGeneration) return;
        message(target, event.lengthComputable ? `%${Math.round(event.loaded / event.total * 100)} yüklendi${event.loaded === event.total ? ' · Dosya kontrol ediliyor…' : '…'}` : 'Dosya yükleniyor…', 'success');
      });
      request.addEventListener('load', () => {
        uploads.delete(request);
        let result;
        try { result = JSON.parse(request.responseText); } catch { result = {}; }
        if (request.status < 200 || request.status >= 300) reject(new ApiError(result.error || 'Dosya yüklenemedi.', request.status, result.code));
        else { if (generation === authGeneration && authenticated) resetScreenLock(); resolve(result); }
      });
      request.addEventListener('error', () => fail('Dosya yüklenemedi. Bağlantını kontrol edip tekrar dene.'));
      request.addEventListener('timeout', () => fail('Yükleme süresi doldu. Daha küçük bir dosyayla tekrar dene.'));
      request.addEventListener('abort', () => fail('Dosya yüklemesi iptal edildi.'));
      message(target, 'Dosya yükleniyor…', 'success');
      request.send(file);
    });
  }

  async function showPortfolio() {
    if (!showStudioSection('portfolio')) return;
    await loadProjects();
  }

  async function loadProjects() {
    if (!studioAllowed()) return;
    const generation = authGeneration;
    const request = ++portfolioRequest;
    $('portfolio-refresh').disabled = true;
    message($('portfolio-message'));
    try {
      const result = await api('/api/admin/projects');
      if (generation !== authGeneration || request !== portfolioRequest) return;
      if (!Array.isArray(result.projects)) throw new ApiError('Projeler okunamadı. Yenileyip tekrar dene.', 0);
      projects = result.projects.filter((project) => project && typeof project.id === 'string');
      renderProjects();
      if (!projectDirty) renderProjectEditor(projects.find((project) => project.id === selectedProjectId) || null);
    } catch (error) {
      if (generation !== authGeneration || request !== portfolioRequest || handleAuthError(error)) return;
      message($('portfolio-message'), error.message);
    } finally { if (generation === authGeneration && request === portfolioRequest) $('portfolio-refresh').disabled = false; }
  }

  function renderProjects() {
    $('project-list').replaceChildren();
    $('portfolio-list-state').textContent = projects.length ? `${projects.length} proje · ${projects.filter((project) => project.published).length} yayında` : 'Vitrinin hazır. İlk gerçek projen için “Yeni proje ekle” ile başla.';
    for (const project of projects) {
      const item = el('li');
      const button = el('button', 'project-admin-item');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(project.id === selectedProjectId));
      const line = el('span');
      line.append(el('strong', '', project.title), el('span', 'project-publish-state', project.published ? 'Yayında' : 'Taslak'));
      button.append(line, el('small', '', projectCategories[project.category] || project.category));
      button.addEventListener('click', () => {
        if (projectDirty && !window.confirm('Kaydedilmemiş proje değişikliklerini bırakıp diğer projeye geçilsin mi?')) return;
        selectedProjectId = project.id; projectDirty = false; renderProjects(); renderProjectEditor(project);
        if (window.matchMedia('(max-width: 950px)').matches) $('project-editor').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
      });
      item.append(button); $('project-list').append(item);
    }
  }

  function renderProjectEditor(project) {
    const editorRequest = ++projectEditorRequest;
    const editor = $('project-editor');
    editor.replaceChildren();
    editor.append(el('span', 'eyebrow', project ? 'PROJE / DÜZENLE' : 'YENİ BİR İMZA'), el('h2', '', project ? project.title : 'İlk bakıştan son kareye.'));
    editor.append(el('p', 'field-help', 'İçeriği kaydet, kapak ve videoları yükle. Yayına al seçeneğini açtığında proje portfolyo sayfanda görünür. Dosyalar doğrudan kendi sunucunda tutulur.'));
    const form = el('form', 'project-form studio-form');
    const controls = {};
    for (const [name, label, config] of [
      ['title', 'Proje adı', { required: true, maxLength: 160 }],
      ['category', 'Hizmet', { tag: 'select', required: true, options: projectCategories }],
      ['clientName', 'Müşteri / marka (isteğe bağlı)', { maxLength: 120 }],
      ['slug', 'Sayfa adresi (boşsa otomatik)', { maxLength: 100, placeholder: 'ornek-proje' }],
      ['summary', 'Kısa proje özeti', { tag: 'textarea', required: true, maxLength: 600 }],
      ['challenge', 'İhtiyaç / çıkış noktası', { tag: 'textarea', maxLength: 3000 }],
      ['approach', 'Yaratıcı yaklaşım', { tag: 'textarea', maxLength: 3000 }],
      ['result', 'Sonuç', { tag: 'textarea', maxLength: 3000 }],
    ]) {
      const input = field(label, `project-${name}`, { ...config, value: project?.[name] || (name === 'category' ? 'production' : '') });
      controls[name] = input.control; form.append(input.wrapper);
    }
    const publishLabel = el('label', 'studio-checkbox');
    const published = el('input'); published.id = 'project-published'; published.type = 'checkbox'; published.checked = project?.published === true;
    publishLabel.append(published, el('span', '', 'Projeyi portfolyoda yayına al'));
    const status = el('p', 'message'); status.setAttribute('role', 'status');
    const save = el('button', 'button primary', project ? 'Projeyi kaydet ↗' : 'Taslağı oluştur ↗'); save.type = 'submit';
    form.append(publishLabel, save, status);
    form.addEventListener('input', () => { projectDirty = true; message(status); });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (save.disabled || !form.reportValidity()) return;
      const generation = authGeneration;
      const payload = Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value.trim()])); payload.published = published.checked;
      if (!payload.slug) delete payload.slug;
      save.disabled = true;
      for (const control of form.elements) control.disabled = true;
      message(status, 'Proje kaydediliyor…', 'success');
      try {
        const result = await api(project ? `/api/admin/projects/${encodeURIComponent(project.id)}` : '/api/admin/projects', { method: project ? 'PATCH' : 'POST', body: payload, csrf: true });
        if (generation !== authGeneration) return;
        if (!result.project?.id) throw new ApiError('Kaydedilen proje okunamadı. Listeyi yenile.', 0);
        const index = projects.findIndex((entry) => entry.id === result.project.id);
        if (index < 0) projects.unshift(result.project); else projects[index] = result.project;
        if (editorRequest === projectEditorRequest) { selectedProjectId = result.project.id; projectDirty = false; renderProjectEditor(result.project); }
        renderProjects();
        message($('portfolio-message'), result.project.published ? 'Proje yayında. Portfolyo sayfanda görüntüleyebilirsin.' : 'Taslak kaydedildi. Görsellerini ve videolarını aşağıdan ekleyebilirsin.', 'success');
      } catch (error) { if (generation === authGeneration && !handleAuthError(error)) message(status, error.message); }
      finally { if (generation === authGeneration) for (const control of form.elements) control.disabled = false; }
    });
    editor.append(form);
    if (!project) return;
    if (project.published) {
      const link = el('a', 'button secondary', 'Yayındaki projeyi aç ↗'); link.href = `/isler/${encodeURIComponent(project.slug)}`; link.target = '_blank'; link.rel = 'noopener'; editor.append(link);
    }
    const mediaSection = el('section', 'project-media-section');
    mediaSection.append(el('h3', '', 'Kapağın. Filmin. Farkın.'), el('p', 'field-help', 'Görseller: JPG, PNG veya WebP · en fazla 8 MB. Videolar: MP4 veya WebM · en fazla 100 MB. Önce ve sonra alanlarına iki görsel veya iki video ekleyince karşılaştırma görünür. Yeni dosya, aynı alandaki eski dosyanın yerini alır.'));
    for (const [role, label] of [['cover', 'Proje kapağı'], ['video', 'Ana proje videosu'], ['before', 'Önce / ham görüntü'], ['after', 'Sonra / son kurgu']]) mediaSection.append(projectMediaControl(project, role, label));
    editor.append(mediaSection);
    const danger = el('details', 'studio-danger'); danger.append(el('summary', '', 'Projeyi kalıcı olarak sil'));
    const deleteForm = el('form', 'studio-form');
    deleteForm.append(el('p', 'field-help', 'Proje ve tüm dosyaları silinir. Sayfayı yayından kaldırmak için yukarıdaki yayın seçeneğini kapatabilirsin.'));
    const confirmation = field('Kalıcı silmek için SİL yaz', 'project-delete-confirmation', { required: true, maxLength: 3 });
    const remove = el('button', 'button danger-outline', 'Projeyi ve dosyalarını sil'); remove.type = 'submit'; remove.disabled = true;
    const deleteMessage = el('p', 'message'); deleteMessage.setAttribute('role', 'status');
    confirmation.control.addEventListener('input', () => { remove.disabled = confirmation.control.value !== 'SİL'; });
    deleteForm.append(confirmation.wrapper, remove, deleteMessage);
    deleteForm.addEventListener('submit', async (event) => {
      event.preventDefault(); if (remove.disabled || confirmation.control.value !== 'SİL') return;
      const generation = authGeneration; remove.disabled = true;
      try {
        await api(`/api/admin/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE', csrf: true, body: { confirmation: 'SİL' } });
        if (generation !== authGeneration) return;
        projects = projects.filter((entry) => entry.id !== project.id);
        if (editorRequest === projectEditorRequest) { selectedProjectId = null; projectDirty = false; renderProjectEditor(null); }
        renderProjects(); message($('portfolio-message'), 'Proje ve dosyaları silindi.', 'success');
      } catch (error) { if (generation === authGeneration && !handleAuthError(error)) message(deleteMessage, error.message); }
      finally { if (generation === authGeneration) remove.disabled = false; }
    });
    danger.append(deleteForm); editor.append(danger);
  }

  function projectMediaControl(project, role, label) {
    const container = el('div', 'project-media-control');
    const heading = el('h4', '', label);
    const path = `/api/admin/projects/${encodeURIComponent(project.id)}/media/${role}`;
    const media = project.media?.[role];
    if (media) {
      const url = localMediaUrl(typeof media === 'string' ? media : media.url || path);
      if (url) {
        if (role === 'cover') { const image = el('img', 'project-cover-preview'); image.src = url; image.alt = `${project.title} proje kapağı`; image.loading = 'lazy'; container.append(image); }
        else { const preview = el('a', 'media-preview-link', `${label} dosyasını aç ↗`); preview.href = url; preview.target = '_blank'; preview.rel = 'noopener'; container.append(preview); }
      }
    }
    const selection = field(label + ' dosyası', `project-media-${role}`, { type: 'file' });
    const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
    const videoTypes = ['video/mp4', 'video/webm'];
    const allowedTypes = role === 'cover' ? imageTypes : role === 'video' ? videoTypes : [...imageTypes, ...videoTypes];
    selection.control.accept = allowedTypes.join(',');
    const upload = el('button', 'button secondary', media ? 'Dosyayı değiştir ↑' : 'Dosyayı yükle ↑'); upload.type = 'button'; upload.disabled = true;
    const status = el('p', 'message'); status.setAttribute('role', 'status');
    selection.control.addEventListener('change', () => { upload.disabled = !selection.control.files.length; message(status); });
    upload.addEventListener('click', async () => {
      const file = selection.control.files[0]; if (!file || upload.disabled) return;
      const generation = authGeneration; upload.disabled = true; selection.control.disabled = true;
      try {
        const result = await uploadFile(path, file, allowedTypes, status);
        if (generation !== authGeneration) return;
        const updated = result.project;
        if (updated?.id) { const index = projects.findIndex((entry) => entry.id === updated.id); if (index >= 0) projects[index] = updated; renderProjects(); }
        message(status, 'Dosya kaydedildi.', 'success'); selection.control.value = '';
        if (!projectDirty && selectedProjectId === project.id && updated) renderProjectEditor(updated);
      } catch (error) { if (generation === authGeneration && !handleAuthError(error)) message(status, error.message); }
      finally { if (generation === authGeneration) { selection.control.disabled = false; upload.disabled = !selection.control.files.length; } }
    });
    container.prepend(heading); container.append(selection.wrapper, upload, status);
    if (media) {
      const remove = el('button', 'text-button', 'Bu dosyayı kaldır'); remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!window.confirm(`${label} dosyası kalıcı olarak kaldırılsın mı?`)) return;
        const generation = authGeneration; remove.disabled = true;
        try {
          const result = await api(path, { method: 'DELETE', csrf: true, body: { confirmation: 'SİL' } });
          if (generation !== authGeneration) return;
          if (result.project) { const index = projects.findIndex((entry) => entry.id === project.id); if (index >= 0) projects[index] = result.project; if (!projectDirty && selectedProjectId === project.id) renderProjectEditor(result.project); }
          message(status, 'Dosya kaldırıldı.', 'success');
        } catch (error) { if (generation === authGeneration && !handleAuthError(error)) message(status, error.message); }
        finally { if (generation === authGeneration) remove.disabled = false; }
      }); container.append(remove);
    }
    return container;
  }

  function trackingOf(lead) {
    return { stage: 'inquiry', nextActionAt: null, nextActionNote: '', agreedAmountCents: null, paymentDueDate: null, receivedAmountCents: lead.paymentReceivedCents || 0, remainingCents: 0, ...lead.tracking };
  }

  function renderTrackingCount(entries) {
    const count = entries.filter((lead) => trackingOf(lead).actionOverdue || trackingOf(lead).paymentOverdue).length;
    $('tracking-sidebar-count').textContent = String(count);
    $('tracking-sidebar-count').hidden = count === 0;
  }

  function localDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function decimalAmount(value) { return Number.isSafeInteger(value) ? (value / 100).toFixed(2) : ''; }

  function trackingEditor(lead) {
    const tracking = trackingOf(lead);
    const values = trackingDrafts.get(lead.id) || { stage: tracking.stage, nextActionAt: localDateTime(tracking.nextActionAt), nextActionNote: tracking.nextActionNote || '', agreedAmount: decimalAmount(tracking.agreedAmountCents), receivedAmount: decimalAmount(tracking.receivedAmountCents) || '0.00', paymentDueDate: tracking.paymentDueDate || '' };
    const section = el('details', 'lead-studio-block');
    section.append(el('summary', '', 'İş takibi ve ödeme ↗'));
    const form = el('form', 'studio-form tracking-form');
    const controls = {};
    for (const [name, label, config] of [
      ['stage', 'İşin aşaması', { tag: 'select', options: stages }],
      ['nextActionAt', 'Sonraki takip zamanı', { type: 'datetime-local' }],
      ['nextActionNote', 'Sonraki adım / hatırlatma', { tag: 'textarea', maxLength: 1000, placeholder: 'Teklifi görüş, çekim tarihini netleştir…' }],
      ['agreedAmount', 'Anlaşılan toplam (TL)', { maxLength: 12, placeholder: 'Henüz belli değilse boş bırak' }],
      ['receivedAmount', 'Alınan toplam ödeme (TL)', { required: true, maxLength: 12 }],
      ['paymentDueDate', 'Kalan ödeme tarihi', { type: 'date' }],
    ]) {
      const input = field(label, `tracking-${name}`, { ...config, value: values[name] }); controls[name] = input.control;
      if (name.endsWith('Amount')) input.control.inputMode = 'decimal';
      form.append(input.wrapper);
    }
    const balance = el('p', 'tracking-balance', tracking.agreedAmountCents === null ? 'Anlaşılan tutarı girdiğinde kalan ödemeyi burada göreceksin.' : `${moneyFormat.format(tracking.remainingCents / 100)} kalan ödeme`);
    const help = el('p', 'field-help', 'Tutarlar toplam kayıttır; yeni ödeme eklerken aldığın güncel toplamı gir. Bu işlem müşteriye bildirim göndermez. Takip zamanı tarayıcının yerel saatine göredir. İşi tamamlamak için yukarıdaki talep durumunu değiştir.');
    const save = el('button', 'button secondary', 'Takibi kaydet ↗'); save.type = 'submit';
    const status = el('p', 'message'); status.setAttribute('role', 'status');
    form.addEventListener('input', () => { trackingDrafts.set(lead.id, Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value]))); message(status); });
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (save.disabled || !form.reportValidity()) return;
      const received = controls.receivedAmount.value.trim(); const agreed = controls.agreedAmount.value.trim();
      if (!/^(0|[1-9]\d{0,8})(?:[.,]\d{1,2})?$/.test(received) || (agreed && !/^(0|[1-9]\d{0,8})(?:[.,]\d{1,2})?$/.test(agreed))) { message(status, 'Tutarı binlik ayırıcı olmadan gir. Örnek: 12500,50.'); return; }
      const date = controls.nextActionAt.value ? new Date(controls.nextActionAt.value) : null;
      if (date && Number.isNaN(date.getTime())) { message(status, 'Geçerli bir takip zamanı seç.'); return; }
      const generation = authGeneration;
      save.disabled = true;
      try {
        const result = await api(`/api/admin/leads/${encodeURIComponent(lead.id)}/tracking`, { method: 'PATCH', csrf: true, body: { stage: controls.stage.value, nextActionAt: date ? date.toISOString() : null, nextActionNote: controls.nextActionNote.value.trim(), agreedAmount: agreed || null, receivedAmount: received, paymentDueDate: controls.paymentDueDate.value || null } });
        if (generation !== authGeneration) return;
        const index = leads.findIndex((entry) => entry.id === lead.id);
        if (index >= 0) leads[index] = result.lead ? { ...leads[index], ...result.lead, tracking: result.tracking || result.lead.tracking } : { ...leads[index], tracking: result.tracking };
        trackingDrafts.delete(lead.id); renderList(); renderTrackingCount(leads);
        if (selectedId === lead.id) {
          renderDetail();
          const updatedEditor = $('detail-content').querySelector('.lead-studio-block');
          if (updatedEditor) { updatedEditor.open = true; message(updatedEditor.querySelector('.message'), 'İş takibi ve ödeme bilgileri kaydedildi.', 'success'); }
        }
      } catch (error) { if (generation === authGeneration && !handleAuthError(error)) message(status, error.message); }
      finally { if (generation === authGeneration) save.disabled = false; }
    });
    form.append(balance, help, save, status); section.append(form); return section;
  }

  async function showTracking() {
    if (!showStudioSection('tracking')) return;
    await loadTracking();
  }

  async function loadTracking() {
    if (!studioAllowed()) return;
    const generation = authGeneration; const request = ++trackingRequest;
    $('tracking-refresh').disabled = true; message($('tracking-message'));
    try {
      const result = await api('/api/admin/tracking');
      if (generation !== authGeneration || request !== trackingRequest) return;
      if (!Array.isArray(result.leads)) throw new ApiError('İş takibi okunamadı.', 0);
      renderTracking(result.leads);
    } catch (error) { if (generation === authGeneration && request === trackingRequest && !handleAuthError(error)) message($('tracking-message'), error.message); }
    finally { if (generation === authGeneration && request === trackingRequest) $('tracking-refresh').disabled = false; }
  }

  function renderTracking(allLeads) {
    renderTrackingCount(allLeads);
    const active = allLeads.filter((lead) => lead.status !== 'completed' && lead.status !== 'archived');
    const due = allLeads.filter((lead) => trackingOf(lead).actionOverdue || trackingOf(lead).paymentOverdue);
    const balance = allLeads.reduce((sum, lead) => sum + (trackingOf(lead).remainingCents || 0), 0);
    $('tracking-summary').replaceChildren();
    for (const [label, value, note] of [['AKTİF İŞ', String(active.length), 'Gelen fikirlerden son teslimlere'], ['TAKİP ZAMANI GELEN', String(due.length), 'Görüşme veya ödeme hatırlatması'], ['KALAN ÖDEME', moneyFormat.format(balance / 100), 'Tamamlananlar dahil, tutarı kayıtlı tüm işler']]) {
      const card = el('div', 'studio-card tracking-metric'); card.append(el('span', 'eyebrow', label), el('strong', '', value), el('span', '', note)); $('tracking-summary').append(card);
    }
    const reminders = $('tracking-reminders'); reminders.replaceChildren(el('h2', '', 'Bugünün dikkat isteyenleri.'));
    if (!due.length) reminders.append(el('p', 'field-help', 'Zamanı gelen bir takip görünmüyor. Taleplerdeki “İş takibi ve ödeme” alanından sonraki adımı planlayabilirsin.'));
    const list = el('ul', 'tracking-reminder-list');
    for (const lead of due.sort((a, b) => (Date.parse(trackingOf(a).nextActionAt) || Infinity) - (Date.parse(trackingOf(b).nextActionAt) || Infinity))) {
      const item = el('li'); const button = el('button', 'tracking-reminder'); button.type = 'button';
      const tracking = trackingOf(lead); button.append(el('strong', '', lead.brand || lead.name), el('span', '', [tracking.actionOverdue ? `Takip: ${tracking.nextActionAt ? readableDate(tracking.nextActionAt, true) : 'zamanı geldi'}` : '', tracking.paymentOverdue ? `${moneyFormat.format(tracking.remainingCents / 100)} ödeme bekliyor` : ''].filter(Boolean).join(' · ')), el('small', '', tracking.nextActionNote || 'Talebe git ve sonraki adımı planla.'));
      button.addEventListener('click', () => openTrackedLead(lead)); item.append(button); list.append(item);
    }
    reminders.append(list);
    const board = $('tracking-board'); board.replaceChildren();
    for (const [stage, title] of Object.entries(stages)) {
      const column = el('section', 'tracking-column');
      const entries = active.filter((lead) => trackingOf(lead).stage === stage);
      const heading = el('h2', '', title); heading.append(el('span', '', entries.length)); column.append(heading);
      if (!entries.length) column.append(el('p', 'tracking-column-empty', 'Bu aşama hazır.'));
      for (const lead of entries) {
        const card = el('button', 'tracking-lead-card'); card.type = 'button';
        const tracking = trackingOf(lead); card.append(el('strong', '', lead.brand || 'İsimsiz marka'), el('span', '', lead.name || 'Proje talebi'));
        if (tracking.nextActionAt) card.append(el('small', tracking.actionOverdue ? 'attention-text' : '', `↗ ${readableDate(tracking.nextActionAt, true)}`));
        if (tracking.nextActionNote) card.append(el('span', 'tracking-card-note', tracking.nextActionNote));
        if (tracking.agreedAmountCents !== null) card.append(el('small', '', `${moneyFormat.format(tracking.remainingCents / 100)} kalan`));
        card.addEventListener('click', () => openTrackedLead(lead)); column.append(card);
      }
      board.append(column);
    }
  }

  async function openTrackedLead(lead) {
    const generation = authGeneration;
    await showRequests(lead.status === 'completed' ? 'completed' : lead.status === 'archived' ? 'archived' : 'active');
    if (generation !== authGeneration) return;
    selectLead(lead.id);
    const tracking = $('detail-content').querySelector('.lead-studio-block'); if (tracking) tracking.open = true;
  }

  function deliveryEditor(lead) {
    const section = el('details', 'lead-studio-block delivery-editor');
    section.append(el('summary', '', 'Müşteriye özel teslim ve onay ↗'));
    section.append(el('p', 'field-help', 'Dosyalarını özel bir bağlantıyla paylaş. Müşterin revizyon notu bırakabilir veya mevcut sürümü onaylayabilir. Müşteri onayı işi otomatik tamamlamaz.'));
    const list = el('div', 'delivery-list'); const messageNode = el('p', 'message'); messageNode.setAttribute('role', 'status');
    const refresh = el('button', 'button secondary', 'Teslimleri yenile ↻'); refresh.type = 'button';
    const generation = authGeneration;
    let loaded = false; let loadSequence = 0;
    const load = async () => {
      const sequence = ++loadSequence;
      refresh.disabled = true;
      try {
        const result = await api(`/api/admin/leads/${encodeURIComponent(lead.id)}/deliveries`);
        if (generation !== authGeneration || sequence !== loadSequence || !section.isConnected) return;
        if (!Array.isArray(result.deliveries)) throw new ApiError('Teslimler okunamadı.', 0);
        list.replaceChildren();
        if (!result.deliveries.length) list.append(el('p', 'field-help', 'Henüz özel teslim bağlantısı yok. İlk bağlantıyı aşağıdan oluştur.'));
        for (const delivery of result.deliveries) { deliveryLeadIds.set(delivery.id, lead.id); list.append(deliveryCard(delivery, load)); }
        loaded = true;
      } catch (error) { if (generation === authGeneration && !handleAuthError(error)) message(messageNode, error.message); }
      finally { if (generation === authGeneration) refresh.disabled = false; }
    };
    section.addEventListener('toggle', () => { if (section.open && !loaded) void load(); });
    refresh.addEventListener('click', load);
    const form = el('form', 'studio-form delivery-create'); form.append(el('h3', '', 'Yeni özel teslim oluştur'));
    const title = field('Teslim başlığı', `delivery-title-${lead.id}`, { required: true, maxLength: 150, value: (lead.brand ? `${lead.brand} — proje teslimi` : 'Proje teslimi').slice(0, 150) });
    const description = field('Müşteriye notun', `delivery-description-${lead.id}`, { tag: 'textarea', maxLength: 2000, placeholder: 'Bu sürümde neler var? Müşterin neyi kontrol etmeli?' });
    const expires = field('Bağlantı geçerliliği', `delivery-expiry-${lead.id}`, { tag: 'select', value: '7', options: { 7: '7 gün', 14: '14 gün', 30: '30 gün' } });
    const acknowledge = el('label', 'studio-checkbox'); const confirm = el('input'); confirm.type = 'checkbox'; confirm.required = true; confirm.id = `delivery-confirm-${lead.id}`;
    acknowledge.append(confirm, el('span', '', 'Yeni bağlantı oluşturulduğunda bu talebin önceki teslim bağlantılarının kapanacağını biliyorum. Yeni teslim boş başlayacak.'));
    const create = el('button', 'button secondary', 'Özel bağlantı oluştur ↗'); create.type = 'submit';
    form.append(title.wrapper, description.wrapper, expires.wrapper, acknowledge, create);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (create.disabled || !form.reportValidity()) return;
      create.disabled = true; message(messageNode);
      try {
        const result = await api(`/api/admin/leads/${encodeURIComponent(lead.id)}/deliveries`, { method: 'POST', csrf: true, body: { title: title.control.value.trim(), description: description.control.value.trim(), expiresInDays: Number(expires.control.value) } });
        if (generation !== authGeneration) return;
        if (result.delivery?.id && typeof result.sharePath === 'string' && /^\/teslim#[a-f0-9]{64}$/.test(result.sharePath)) shareLinks.set(result.delivery.id, new URL(result.sharePath, location.origin).href);
        confirm.checked = false; await load(); message(messageNode, 'Özel bağlantı oluşturuldu. Aşağıdaki bağlantıyı şimdi güvenle kopyala ve müşterinle kendin paylaş.', 'success');
      } catch (error) { if (generation === authGeneration && !handleAuthError(error)) message(messageNode, error.message); }
      finally { if (generation === authGeneration) create.disabled = false; }
    });
    section.append(refresh, messageNode, list, form); return section;
  }

  function deliveryCard(delivery, reload) {
    const card = el('section', 'delivery-card');
    const statusNames = { pending: 'İnceleme bekliyor', revision_requested: 'Revizyon istendi', approved: 'Müşteri onayladı' };
    const expired = Date.parse(delivery.expiresAt) <= Date.now(); const inactive = Boolean(delivery.revokedAt) || expired;
    card.append(el('h3', '', delivery.title), el('span', 'delivery-status', delivery.revokedAt ? 'Bağlantı kapatıldı' : expired ? 'Bağlantı süresi doldu' : statusNames[delivery.status] || 'İnceleme bekliyor'), el('p', 'field-help', `Sürüm ${delivery.version} · Son geçerlilik: ${readableDate(delivery.expiresAt, true)}`));
    if (delivery.description) card.append(el('p', 'delivery-note', delivery.description));
    const status = el('p', 'message'); status.setAttribute('role', 'status');
    const share = shareLinks.get(delivery.id);
    if (share && !inactive) {
      const fieldset = el('div', 'delivery-share'); const label = el('label', '', 'Özel müşteri bağlantısı'); const input = el('input'); input.type = 'text'; input.readOnly = true; input.value = share; input.id = `share-${delivery.id}`; label.htmlFor = input.id;
      const copy = el('button', 'button secondary', 'Bağlantıyı kopyala'); copy.type = 'button';
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(share); message(status, 'Bağlantı kopyalandı.', 'success'); } catch { input.focus(); input.select(); message(status, 'Bağlantı seçildi. Ctrl+C veya telefonunun kopyalama menüsünü kullan.', 'success'); } });
      fieldset.append(label, input, copy, el('p', 'field-help', 'Bu bağlantı yalnızca mevcut oturumunda gösterilir. Bağlantıya sahip olan kişi teslimi görebilir; müşterinle özel olarak paylaş.')); card.append(fieldset);
    } else if (!inactive) card.append(el('p', 'field-help', 'Güvenlik için özel bağlantı tekrar gösterilmez. Kaybettiysen yeni teslim oluştur; önceki bağlantı kapanır.'));
    const list = el('ul', 'delivery-files');
    for (const [index, asset] of (delivery.files || []).entries()) {
      const row = el('li'); const url = localMediaUrl(asset.url);
      const label = `${asset.mimeType?.startsWith('video/') ? 'Video' : asset.mimeType === 'application/pdf' ? 'PDF' : 'Görsel'} ${index + 1} · ${fileSize(asset.size)}`;
      const link = el(url ? 'a' : 'span', '', label + (url ? ' ↗' : '')); if (url) { link.href = url; link.target = '_blank'; link.rel = 'noopener'; }
      row.append(link);
      if (!inactive) {
        const remove = el('button', 'text-button', 'Kaldır'); remove.type = 'button';
        remove.addEventListener('click', async () => {
          if (!window.confirm('Bu dosya kaldırılsın mı? Müşteri onayı sıfırlanacak ve yeni sürüm oluşacak.')) return;
          const generation = authGeneration; remove.disabled = true;
          try { await api(`/api/admin/deliveries/${encodeURIComponent(delivery.id)}/files/${encodeURIComponent(asset.id)}`, { method: 'DELETE', csrf: true, body: {} }); if (generation === authGeneration) await reload(); }
          catch (error) { if (generation === authGeneration && !handleAuthError(error)) message(status, error.message); }
          finally { if (generation === authGeneration) remove.disabled = false; }
        }); row.append(remove);
      }
      list.append(row);
    }
    if (!list.childNodes.length) card.append(el('p', 'field-help', 'Henüz dosya eklenmedi. Müşterin dosya eklendiğinde inceleyebilir.')); else card.append(list);
    if (!inactive) {
      const selection = field('Teslim dosyası ekle', `delivery-file-${delivery.id}`, { type: 'file' }); selection.control.accept = 'video/mp4,video/webm,application/pdf,image/jpeg,image/png,image/webp';
      const upload = el('button', 'button secondary', 'Dosyayı yükle ↑'); upload.type = 'button'; upload.disabled = true;
      selection.control.addEventListener('change', () => { upload.disabled = !selection.control.files.length; });
      upload.addEventListener('click', async () => {
        const file = selection.control.files[0]; if (!file || upload.disabled) return;
        const generation = authGeneration; upload.disabled = true; selection.control.disabled = true;
        try { await uploadFile(`/api/admin/deliveries/${encodeURIComponent(delivery.id)}/files`, file, ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'application/pdf'], status); if (generation === authGeneration) await reload(); }
        catch (error) { if (generation === authGeneration && !handleAuthError(error)) message(status, error.message); }
        finally { if (generation === authGeneration) { upload.disabled = false; selection.control.disabled = false; } }
      });
      card.append(selection.wrapper, upload, el('p', 'field-help', 'Görseller en fazla 8 MB; MP4, WebM ve PDF en fazla 100 MB. Dosya eklemek yeni sürüm oluşturur ve önceki onayı sıfırlar.'));
    }
    if (delivery.feedback?.length) {
      const history = el('details', 'delivery-feedback'); history.append(el('summary', '', `Müşteri geri bildirimleri (${delivery.feedback.length})`)); const entries = el('ol');
      for (const entry of delivery.feedback) { const item = el('li'); item.append(el('strong', '', entry.action === 'approve' ? '✓ Sürüm onaylandı' : '↗ Revizyon isteği'), el('small', '', `Sürüm ${entry.version} · ${readableDate(entry.createdAt, true)}`), el('p', '', entry.message || 'Ek not bırakılmadı.')); entries.append(item); }
      history.append(entries); card.append(history);
    }
    if (!inactive) {
      const revoke = el('button', 'button danger-outline', 'Bu bağlantıyı kapat'); revoke.type = 'button';
      revoke.addEventListener('click', async () => {
        if (!window.confirm('Bu özel teslim bağlantısı kapatılsın mı? Müşterin artık bu bağlantıyla dosyalara erişemez.')) return;
        const generation = authGeneration; revoke.disabled = true;
        try { await api(`/api/admin/deliveries/${encodeURIComponent(delivery.id)}/revoke`, { method: 'POST', csrf: true, body: {} }); if (generation === authGeneration) { shareLinks.delete(delivery.id); await reload(); } }
        catch (error) { if (generation === authGeneration && !handleAuthError(error)) message(status, error.message); }
        finally { if (generation === authGeneration) revoke.disabled = false; }
      }); card.append(revoke);
    }
    card.append(status); return card;
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('login-button').disabled) return;
    const username = $('username').value.trim();
    const password = $('password').value;
    $('login-button').disabled = true;
    $('login-form').setAttribute('aria-busy', 'true');
    message($('login-message'));
    try {
      const code = $('login-code').value.trim();
      const session = await api('/api/admin/login', { method: 'POST', body: { username, password, ...(code ? { code } : {}) } });
      await showDashboard(session);
    } catch (error) {
      if (error.code !== 'MFA_CODE_REQUIRED') $('password').value = '';
      if (error.code === 'ADMIN_NOT_CONFIGURED') showLogin(error.message, false);
      else {
        message($('login-message'), error.message);
        if (['MFA_CODE_REQUIRED', 'MFA_INVALID'].includes(error.code)) {
          $('login-code').value = '';
          $('login-code').focus();
        } else $('password').focus();
      }
    } finally {
      $('login-button').disabled = !$('setup-help').hidden;
      $('login-form').removeAttribute('aria-busy');
    }
  });

  async function logout() {
    $('logout-button').disabled = true;
    $('mobile-logout').disabled = true;
    $('security-mobile-logout').disabled = true;
    $('automation-mobile-logout').disabled = true;
    $('portfolio-mobile-logout').disabled = true;
    $('tracking-mobile-logout').disabled = true;
    try {
      await api('/api/admin/logout', { method: 'POST', body: {}, csrf: true });
      showLogin();
      message($('login-message'), 'Güvenli çıkış yapıldı.', 'success');
      $('username').focus();
    } catch (error) {
      if (!handleAuthError(error)) message($(({ security: 'security-message', automation: 'automation-message', portfolio: 'portfolio-message', tracking: 'tracking-message' })[currentSection] || 'dashboard-message'), error.message);
    } finally {
      $('logout-button').disabled = false;
      $('mobile-logout').disabled = false;
      $('security-mobile-logout').disabled = false;
      $('automation-mobile-logout').disabled = false;
      $('portfolio-mobile-logout').disabled = false;
      $('tracking-mobile-logout').disabled = false;
    }
  }

  $('logout-button').addEventListener('click', logout);
  $('mobile-logout').addEventListener('click', logout);
  $('security-mobile-logout').addEventListener('click', logout);
  $('automation-mobile-logout').addEventListener('click', logout);
  $('portfolio-mobile-logout').addEventListener('click', logout);
  $('tracking-mobile-logout').addEventListener('click', logout);
  for (const id of ['portfolio-nav', 'mobile-portfolio-nav']) $(id).addEventListener('click', showPortfolio);
  for (const id of ['tracking-nav', 'mobile-tracking-nav']) $(id).addEventListener('click', showTracking);
  $('portfolio-refresh').addEventListener('click', loadProjects);
  $('tracking-refresh').addEventListener('click', loadTracking);
  $('project-new').addEventListener('click', () => {
    if (projectDirty && !window.confirm('Kaydedilmemiş proje değişikliklerini bırakıp yeni bir proje açılsın mı?')) return;
    selectedProjectId = null; projectDirty = false; renderProjects(); renderProjectEditor(null);
    $('project-title').focus({ preventScroll: true });
  });
  $('requests-nav').addEventListener('click', () => showRequests('active'));
  $('mobile-requests-nav').addEventListener('click', () => showRequests('active'));
  $('completed-nav').addEventListener('click', () => showRequests('completed'));
  $('mobile-completed-nav').addEventListener('click', () => showRequests('completed'));
  $('archived-nav').addEventListener('click', () => showRequests('archived'));
  $('mobile-archived-nav').addEventListener('click', () => showRequests('archived'));
  $('security-nav').addEventListener('click', () => showSecurity());
  $('mobile-security-nav').addEventListener('click', () => showSecurity());
  $('automation-nav').addEventListener('click', showAutomation);
  $('mobile-automation-nav').addEventListener('click', showAutomation);
  $('refresh-button').addEventListener('click', refreshLeads);
  $('search').addEventListener('input', renderList);
  $('status-filter').addEventListener('change', renderList);
  document.querySelectorAll('[data-stat]').forEach((node) => node.addEventListener('click', () => {
    const completed = node.dataset.stat === 'completed';
    if (currentFolder !== (completed ? 'completed' : 'active')) {
      void showRequests(completed ? 'completed' : 'active');
    }
    $('status-filter').value = completed ? 'all' : node.dataset.stat;
    renderList();
  }));
  window.addEventListener('beforeunload', (event) => {
    if (!drafts.size && !backupCodes.length && !projectDirty && !trackingDrafts.size && !uploads.size) return;
    event.preventDefault();
    event.returnValue = '';
  });

  api('/api/admin/session').then(showDashboard).catch((error) => {
    showLogin(error.status === 401 ? '' : error.message, error.code !== 'ADMIN_NOT_CONFIGURED');
  });
})();
