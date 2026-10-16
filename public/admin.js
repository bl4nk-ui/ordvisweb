'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const statuses = { new: 'Yeni', contacted: 'Görüşülüyor', archived: 'Arşiv' };
  const dateFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', timeZone: 'Europe/Istanbul' });
  const fullDateFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' });
  let csrfToken = '';
  let leads = [];
  let selectedId = null;
  let authenticated = false;
  let loading = false;
  let authGeneration = 0;
  let leadCounts = null;
  let mfaEnabled = false;
  let mfaRequired = true;
  let backupCodes = [];
  let currentSection = 'requests';
  let securityLoading = false;
  let changingMfaDevice = false;
  let screenLockTimer;
  const drafts = new Map();

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
    mfaEnabled = false;
    mfaRequired = true;
    clearSecuritySecrets();
    drafts.clear();
    $('leads-list').replaceChildren();
    $('detail-content').replaceChildren();
    $('password').value = '';
    $('login-code').value = '';
    $('search').value = '';
    $('status-filter').value = 'all';
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
    $('requests-nav').title = restricted ? 'Önce iki aşamalı doğrulamayı tamamla' : '';
    $('mfa-required-notice').hidden = !restricted;
    $('assistant-card').hidden = restricted || backupCodes.length > 0;
    $('mfa-setup-panel').hidden = (mfaEnabled && !changingMfaDevice) || backupCodes.length > 0;
    $('mfa-enabled-panel').hidden = !mfaEnabled || changingMfaDevice || backupCodes.length > 0;
    $('setup-existing-code-field').hidden = !changingMfaDevice;
    $('setup-existing-code').required = changingMfaDevice;
    $('cancel-mfa-change').hidden = !changingMfaDevice;
    $('security-badge').textContent = mfaEnabled ? '◈ İki aşamalı koruma etkin' : '◈ Kurulumu tamamla';
    $('security-badge').classList.toggle('is-enabled', mfaEnabled);
    $('requests-nav').classList.toggle('active', currentSection === 'requests');
    $('security-nav').classList.toggle('active', currentSection === 'security');
    for (const [id, section] of [['requests-nav', 'requests'], ['mobile-requests-nav', 'requests'], ['security-nav', 'security'], ['mobile-security-nav', 'security']]) {
      if (currentSection === section) $(id).setAttribute('aria-current', 'page');
      else $(id).removeAttribute('aria-current');
    }
  }

  async function showRequests() {
    if (!authenticated || mfaRequired || !mfaEnabled || backupCodes.length) return;
    currentSection = 'requests';
    $('requests').hidden = false;
    $('security-section').hidden = true;
    updateSecurityNavigation();
    await refreshLeads();
  }

  async function showSecurity(focus = true) {
    if (!authenticated) return;
    currentSection = 'security';
    $('requests').hidden = true;
    $('security-section').hidden = false;
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

  function renderCounts(counts = leadCounts) {
    const fallback = {
      total: leads.length,
      new: leads.filter((lead) => lead.status === 'new').length,
      contacted: leads.filter((lead) => lead.status === 'contacted').length,
      archived: leads.filter((lead) => lead.status === 'archived').length,
    };
    leadCounts = {};
    for (const key of ['total', 'new', 'contacted', 'archived']) {
      const count = Number.isSafeInteger(counts?.[key]) && counts[key] >= 0 ? counts[key] : fallback[key];
      leadCounts[key] = count;
      $(`count-${key}`).textContent = String(count);
    }
    $('sidebar-count').textContent = $('count-new').textContent;
  }

  async function refreshLeads() {
    if (loading || !authenticated || mfaRequired || !mfaEnabled) return;
    const generation = authGeneration;
    loading = true;
    $('refresh-button').disabled = true;
    $('refresh-icon').classList.add('is-spinning');
    $('leads-list').setAttribute('aria-busy', 'true');
    message($('dashboard-message'));
    if (!leads.length) $('list-state').textContent = 'Talepler yükleniyor…';
    try {
      const result = await api('/api/admin/leads');
      if (generation !== authGeneration) return;
      if (!Array.isArray(result.leads)) throw new ApiError('Talepler okunamadı. Sayfayı yenileyip tekrar dene.', 0);
      leads = result.leads.filter((lead) => lead && typeof lead.id === 'string');
      leads.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
      renderCounts(result.counts);
      renderList();
      if (selectedId) {
        if (leads.some((lead) => lead.id === selectedId)) renderDetail();
        else closeDetail();
      }
      $('updated-time').textContent = `Son yenileme ${new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' }).format(new Date())}`;
    } catch (error) {
      if (generation !== authGeneration || handleAuthError(error)) return;
      message($('dashboard-message'), error.message);
      if (!leads.length) $('list-state').textContent = 'Talepler yüklenemedi. “Talepleri yenile” ile tekrar deneyebilirsin.';
    } finally {
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
      (filter === 'all' || lead.status === filter)
      && (!query || [lead.brand, lead.name, lead.email, lead.phone].some((value) => String(value || '').toLocaleLowerCase('tr-TR').includes(query)))
    ));
    $('visible-count').textContent = String(filtered.length);
    document.querySelectorAll('[data-stat]').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.stat === filter)));
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
      button.append(avatar, summary);
      button.addEventListener('click', () => selectLead(lead.id));
      item.append(button);
      fragment.append(item);
    }
    $('leads-list').replaceChildren(fragment);
    $('list-state').replaceChildren();
    if (!filtered.length) {
      $('list-state').append(
        el('strong', '', leads.length ? 'Bu filtrede talep yok.' : 'Yeni başlangıçlara hazır.'),
        el('span', '', leads.length ? 'Aramayı değiştir veya başka bir durum seç.' : 'Siteden gönderilen proje talepleri burada birikecek.'),
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

  function closeDetail() {
    const previousId = selectedId;
    selectedId = null;
    $('detail-content').hidden = true;
    $('detail-content').replaceChildren();
    $('detail-empty').hidden = false;
    $('detail-panel').setAttribute('aria-labelledby', 'detail-heading');
    renderList();
    const previousButton = Array.from($('leads-list').querySelectorAll('button')).find((button) => button.dataset.leadId === previousId);
    previousButton?.focus({ preventScroll: true });
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

  function renderDetail() {
    const lead = leads.find((entry) => entry.id === selectedId);
    if (!lead) return;
    const draft = drafts.get(lead.id) || { status: lead.status, notes: lead.notes || '' };
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

    const form = el('form', 'detail-editor');
    const statusLabel = el('label', '', 'Talep durumu');
    statusLabel.htmlFor = 'lead-status';
    const status = el('select');
    status.id = 'lead-status';
    for (const [value, text] of Object.entries(statuses)) {
      const option = el('option', '', text);
      option.value = value;
      option.selected = value === draft.status;
      status.append(option);
    }
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
    form.append(statusLabel, status, notesLabel, notes, draftNote, saveButton, statusMessage);
    const trackDraft = () => {
      const changed = status.value !== lead.status || notes.value !== (lead.notes || '');
      if (changed) drafts.set(lead.id, { status: status.value, notes: notes.value });
      else drafts.delete(lead.id);
      draftNote.textContent = changed ? 'Kaydedilmemiş değişikliklerin var.' : 'Notlar yalnızca stüdyo ekibine görünür.';
      saveButton.disabled = !changed;
      message(statusMessage);
    };
    status.addEventListener('change', trackDraft);
    notes.addEventListener('input', trackDraft);
    trackDraft();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saveButton.disabled) return;
      const generation = authGeneration;
      const payload = { status: status.value, notes: notes.value.trim() };
      saveButton.disabled = true;
      status.disabled = true;
      notes.disabled = true;
      form.setAttribute('aria-busy', 'true');
      saveButton.firstChild.textContent = 'Kaydediliyor…';
      message(statusMessage);
      try {
        await api(`/api/admin/leads/${encodeURIComponent(lead.id)}`, { method: 'PATCH', body: payload, csrf: true });
        if (generation !== authGeneration) return;
        const currentLead = leads.find((entry) => entry.id === lead.id) || lead;
        if (leadCounts && currentLead.status !== payload.status) {
          leadCounts[currentLead.status] = Math.max(0, (leadCounts[currentLead.status] || 0) - 1);
          leadCounts[payload.status] = (leadCounts[payload.status] || 0) + 1;
        }
        Object.assign(currentLead, payload);
        drafts.delete(lead.id);
        renderCounts();
        renderList();
        if (selectedId === lead.id) {
          renderDetail();
          const savedMessage = $('detail-content').querySelector('.detail-message');
          if (savedMessage) message(savedMessage, 'Kaydedildi. Bir sonraki iyi işe.', 'success');
        } else {
          message($('dashboard-message'), 'Talep güncellendi.', 'success');
        }
      } catch (error) {
        if (generation !== authGeneration || handleAuthError(error)) return;
        if (selectedId === lead.id) message(statusMessage, error.message);
        else message($('dashboard-message'), error.message);
        saveButton.disabled = false;
      } finally {
        status.disabled = false;
        notes.disabled = false;
        form.removeAttribute('aria-busy');
        saveButton.firstChild.textContent = 'Değişiklikleri kaydet';
      }
    });
    content.append(form);
    $('detail-empty').hidden = true;
    $('detail-content').hidden = false;
    $('detail-content').replaceChildren(content);
    $('detail-panel').setAttribute('aria-labelledby', 'selected-lead-heading');
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
    try {
      await api('/api/admin/logout', { method: 'POST', body: {}, csrf: true });
      showLogin();
      message($('login-message'), 'Güvenli çıkış yapıldı.', 'success');
      $('username').focus();
    } catch (error) {
      if (!handleAuthError(error)) message($(currentSection === 'security' ? 'security-message' : 'dashboard-message'), error.message);
    } finally {
      $('logout-button').disabled = false;
      $('mobile-logout').disabled = false;
      $('security-mobile-logout').disabled = false;
    }
  }

  $('logout-button').addEventListener('click', logout);
  $('mobile-logout').addEventListener('click', logout);
  $('security-mobile-logout').addEventListener('click', logout);
  $('requests-nav').addEventListener('click', showRequests);
  $('mobile-requests-nav').addEventListener('click', showRequests);
  $('security-nav').addEventListener('click', () => showSecurity());
  $('mobile-security-nav').addEventListener('click', () => showSecurity());
  $('refresh-button').addEventListener('click', refreshLeads);
  $('search').addEventListener('input', renderList);
  $('status-filter').addEventListener('change', renderList);
  document.querySelectorAll('[data-stat]').forEach((node) => node.addEventListener('click', () => {
    $('status-filter').value = node.dataset.stat;
    renderList();
  }));
  window.addEventListener('beforeunload', (event) => {
    if (!drafts.size && !backupCodes.length) return;
    event.preventDefault();
    event.returnValue = '';
  });

  api('/api/admin/session').then(showDashboard).catch((error) => {
    showLogin(error.status === 401 ? '' : error.message, error.code !== 'ADMIN_NOT_CONFIGURED');
  });
})();
