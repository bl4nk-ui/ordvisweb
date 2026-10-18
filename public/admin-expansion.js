'use strict';

// All privileged requests use the panel's session lifecycle and CSRF helper.
window.OrdvisAdminExpansion = (ctx) => {
  const { $, el, field, message, api, moneyFormat, readableDate } = ctx;
  const sectionNames = { team: 'Ekip hesapları', clients: 'Müşteriler', reviews: 'Müşteri yorumları', activity: 'İşlem geçmişi', trash: 'Çöp kutusu' };
  const ownerSections = new Set(['team', 'activity']);
  let account = {}; let mine = false; let serial = 0; let team = [];
  const sections = new Map(); const nav = new Map();
  const passwordButtons = new Map();
  const sectionToken = new Map();
  const safe = (generation, node) => generation === ctx.generation() && (!node || node.isConnected);
  const button = (text, action, style = 'button secondary') => { const node = el('button', style, text); node.type = 'button'; if (action) node.addEventListener('click', action); return node; };
  const notice = () => { const node = el('p', 'message'); node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); return node; };
  const check = (title, checked = false) => { const label = el('label', 'studio-checkbox'); const control = el('input'); control.type = 'checkbox'; control.checked = checked; label.append(control, el('span', '', title)); return { wrapper: label, control }; };
  const input = (form, title, name, config = {}) => { const entry = field(title, `exp-${name}-${++serial}`, config); entry.control.name = name; form.append(entry.wrapper); return entry.control; };
  const amount = (cents) => (Number(cents || 0) / 100).toFixed(2);
  const labels = { project_created: 'Portfolyo projesi oluşturuldu', project_updated: 'Portfolyo projesi güncellendi', project_deleted: 'Portfolyo projesi kalıcı silindi', project_media_uploaded: 'Portfolyo dosyası yüklendi', project_media_deleted: 'Portfolyo dosyası kalıcı silindi', lead_tracking_updated: 'İş aşaması veya ödeme bilgileri güncellendi', delivery: 'Proje teslimi', delivery_link_created: 'Özel teslim erişimi oluşturuldu', delivery_link_revoked: 'Teslim erişimi kapatıldı', delivery_file_added: 'Teslim dosyası yüklendi', delivery_file_deleted: 'Teslim dosyası kalıcı silindi', delivery_approved: 'Müşteri teslimi onayladı', delivery_revision_requested: 'Müşteri revizyon istedi', customer_review_submitted: 'Müşteri yorumu alındı', pending: 'Bekliyor', approved: 'Onaylandı', rejected: 'Kabul edilmedi', draft: 'Taslak', sent: 'İletildi', accepted: 'Kabul edildi', lead: 'Proje talebi', project: 'Portfolyo projesi', projectMedia: 'Portfolyo dosyası', deliveryAsset: 'Teslim dosyası', client: 'Müşteri', quote: 'Teklif', account: 'Ekip hesabı', review: 'Müşteri yorumu', project_operations_updated: 'Proje kapsamı veya sorumlusu güncellendi', quote_created: 'Teklif taslağı oluşturuldu', quote_draft: 'Teklif taslağı güncellendi', quote_sent: 'Teklif iletildi olarak işaretlendi', quote_accepted: 'Teklif kabul edildi', quote_rejected: 'Teklif kabul edilmedi', client_created: 'Müşteri eklendi', client_updated: 'Müşteri güncellendi', client_deleted: 'Müşteri kaldırıldı', client_logo_uploaded: 'Müşteri logosu yüklendi', review_approved: 'Müşteri yorumu yayınlandı', review_pending: 'Müşteri yorumu beklemeye alındı', review_rejected: 'Müşteri yorumu yayından kaldırıldı', team_account_created: 'Ekip hesabı oluşturuldu', team_account_updated: 'Ekip hesabı güncellendi', lead_completed: 'Proje tamamlandı', lead_updated: 'Proje talebi güncellendi', lead_deleted: 'Proje talebi kalıcı silindi', trash_created: 'Kayıt çöp kutusuna taşındı', trash_restored: 'Kayıt geri yüklendi', trash_purged: 'Kayıt kalıcı silindi' };
  const human = (value) => labels[value] || String(value || '').replaceAll('_', ' ');

  async function action(control, target, work, success) {
    const generation = ctx.generation(); control.disabled = true; message(target);
    try { const result = await work(); if (!safe(generation, target)) return; if (success) await success(result); }
    catch (error) { if (safe(generation, target) && !ctx.handleAuthError(error)) message(target, error.message); }
    finally { if (safe(generation, control)) control.disabled = false; }
  }

  function attachPasswordToggles() {
    for (const [control] of passwordButtons) if (!control.isConnected) { control.type = 'password'; control.value = ''; passwordButtons.delete(control); }
    for (const control of document.querySelectorAll('input[type=password]')) {
      if (passwordButtons.has(control)) continue;
      const wrapper = el('div', 'password-control'); control.before(wrapper); wrapper.append(control);
      const toggle = button('Göster', () => { const showing = control.type === 'password'; control.type = showing ? 'text' : 'password'; toggle.textContent = showing ? 'Gizle' : 'Göster'; toggle.setAttribute('aria-pressed', String(showing)); toggle.setAttribute('aria-label', showing ? 'Şifreyi gizle' : 'Şifreyi göster'); }, 'password-toggle');
      toggle.setAttribute('aria-label', 'Şifreyi göster'); toggle.setAttribute('aria-pressed', 'false'); toggle.setAttribute('aria-controls', control.id);
      wrapper.append(toggle); passwordButtons.set(control, toggle);
    }
  }
  function remaskPasswords() { for (const [control, toggle] of passwordButtons) { control.type = 'password'; control.value = ''; toggle.textContent = 'Göster'; toggle.setAttribute('aria-pressed', 'false'); toggle.setAttribute('aria-label', 'Şifreyi göster'); } }
  const observer = new MutationObserver(attachPasswordToggles); observer.observe(document.body, { childList: true, subtree: true }); attachPasswordToggles();

  for (const [name, title] of Object.entries(sectionNames)) {
    const desktop = button(title, () => show(name), 'sidebar-item'); desktop.id = `${name}-nav`; $('security-nav').before(desktop);
    const mobile = button(title, () => show(name)); mobile.id = `mobile-${name}-nav`; document.querySelector('.mobile-studio-nav').append(mobile);
    nav.set(name, [desktop, mobile]);
    const section = el('section', 'studio-section expansion-section'); section.id = `${name}-section`; section.hidden = true; section.setAttribute('aria-labelledby', `${name}-title`);
    const heading = el('div', 'page-heading'); const text = el('div'); text.append(el('span', 'eyebrow', 'ORDVIS / STÜDYO')); const h = el('h1', '', title); h.id = `${name}-title`; h.tabIndex = -1; text.append(h); heading.append(text, button('Yenile ↻', () => show(name))); const status = notice(); status.id = `${name}-message`; const body = el('div', 'expansion-body'); body.id = `${name}-body`; section.append(heading, status, body); $('requests').before(section); sections.set(name, section);
  }

  const passwordCard = el('section', 'security-card password-change-card'); passwordCard.id = 'password-change-card';
  passwordCard.append(el('span', 'eyebrow', 'SANA ÖZEL HESAP'), el('h2', '', 'Şifreni değiştir'));
  const passwordNote = el('p', 'field-help', 'Her ekip üyesi kendi şifresi ve kendi Authenticator uygulamasıyla giriş yapar. Projeleri yönetmek için başka birinin koduna ihtiyacın yok.'); passwordCard.append(passwordNote);
  const passwordForm = el('form', 'studio-form');
  const oldPassword = input(passwordForm, 'Mevcut şifren', 'current-password', { type: 'password', required: true, maxLength: 128 }); oldPassword.autocomplete = 'current-password';
  const newPassword = input(passwordForm, 'Yeni şifren (en az 16 karakter)', 'new-password', { type: 'password', required: true, maxLength: 128 }); newPassword.minLength = 16; newPassword.autocomplete = 'new-password';
  const confirmPassword = input(passwordForm, 'Yeni şifreni tekrar gir', 'confirm-password', { type: 'password', required: true, maxLength: 128 }); confirmPassword.autocomplete = 'new-password';
  const passwordSave = button('Şifreyi değiştir ↗', null, 'button primary'); passwordSave.type = 'submit'; const passwordMessage = notice(); passwordForm.append(passwordSave, passwordMessage); passwordCard.append(passwordForm); document.querySelector('.security-grid').prepend(passwordCard);
  passwordForm.addEventListener('submit', (event) => { event.preventDefault(); confirmPassword.setCustomValidity(newPassword.value === confirmPassword.value ? '' : 'Yeni şifreler aynı olmalı.'); if (!passwordForm.reportValidity()) return; void action(passwordSave, passwordMessage, () => api('/api/admin/password', { method: 'POST', csrf: true, body: { currentPassword: oldPassword.value, newPassword: newPassword.value } }), async (session) => { remaskPasswords(); await ctx.showDashboard(session); }); });
  confirmPassword.addEventListener('input', () => confirmPassword.setCustomValidity(''));

  const mineRow = el('div', 'assignment-filter'); const mineCheck = check('Bana atananlar'); mineCheck.control.id = 'assigned-to-me'; mineRow.append(mineCheck.wrapper, el('span', 'field-help', 'Talepler ve aktif projeler için geçerli.')); document.querySelector('.inbox-tools').after(mineRow);
  const trackingMine = button('Bana atananlar', () => { mine = !mine; mineCheck.control.checked = mine; syncMine(); ctx.rerender(); void ctx.refreshTracking(); }); trackingMine.id = 'tracking-mine-filter'; $('tracking-refresh').before(trackingMine);
  function syncMine() { trackingMine.setAttribute('aria-pressed', String(mine)); trackingMine.textContent = mine ? 'Tüm projeleri göster' : 'Bana atananlar'; }
  mineCheck.control.addEventListener('change', () => { mine = mineCheck.control.checked; syncMine(); ctx.rerender(); });

  function hideSections() { for (const section of sections.values()) section.hidden = true; }
  function updateNavigation(restricted, current) {
    for (const [name, buttons] of nav) for (const node of buttons) { node.disabled = restricted; node.hidden = ownerSections.has(name) && account.role !== 'owner'; node.classList.toggle('active', current === name); if (current === name) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); }
    passwordCard.hidden = false;
    if (account.mustChangePassword) { $('mfa-setup-panel').hidden = true; $('mfa-enabled-panel').hidden = true; $('mfa-required-notice').textContent = 'Geçici şifreni şimdi değiştir. Sonraki adımda kendi telefonunla Authenticator kurulumunu tamamlayacaksın.'; $('mfa-required-notice').hidden = false; }
  }
  function showPasswordGate() { ctx.showSection('security'); $('requests').hidden = true; $('security-section').hidden = false; hideSections(); passwordNote.textContent = 'Bu hesap sana özel. Devam etmek için geçici şifreni değiştir; ardından Authenticator uygulamanı kendi telefonuna kur.'; $('mfa-setup-panel').hidden = true; $('mfa-enabled-panel').hidden = true; $('assistant-card').hidden = true; oldPassword.focus(); }

  async function show(name) {
    if (!ctx.allowed() || (ownerSections.has(name) && account.role !== 'owner')) return;
    if (!ctx.showSection(name)) return; sections.get(name).hidden = false;
    const body = $(`${name}-body`); const status = $(`${name}-message`); const generation = ctx.generation(); const request = (sectionToken.get(name) || 0) + 1; sectionToken.set(name, request); body.replaceChildren(el('p', 'field-help', 'Yükleniyor…')); message(status);
    try {
      const path = { team: 'users', clients: 'clients', reviews: 'reviews', activity: 'activity', trash: 'trash' }[name]; const result = await api(`/api/admin/${path}`);
      if (!safe(generation, body) || sectionToken.get(name) !== request) return; body.replaceChildren();
      ({ team: renderTeam, clients: renderClients, reviews: renderReviews, activity: renderActivity, trash: renderTrash })[name](body, result[path] || result.users || []);
    } catch (error) { if (safe(generation, body) && sectionToken.get(name) === request && !ctx.handleAuthError(error)) { body.replaceChildren(); message(status, error.message); } }
  }

  function renderTeam(body, users) {
    body.append(el('p', 'field-help', 'Her ortak kendi hesabıyla giriş yapar. Geçici şifresini değiştirip Authenticator uygulamasını kendi telefonuna kurar. Ana yönetici bütün projelere kendi hesabıyla erişir.'));
    const create = el('form', 'studio-card studio-form'); create.append(el('h2', '', 'Ortak hesabı ekle'));
    const username = input(create, 'Kullanıcı adı', 'username', { required: true, maxLength: 80 }); username.autocomplete = 'off'; username.autocapitalize = 'none';
    const displayName = input(create, 'Ad soyad', 'displayName', { required: true, maxLength: 100 });
    const password = input(create, 'Geçici şifre (en az 16 karakter)', 'password', { type: 'password', required: true, maxLength: 128 }); password.minLength = 16; password.autocomplete = 'new-password';
    const submit = button('Hesabı oluştur +', null, 'button primary'); submit.type = 'submit'; const status = notice(); create.append(submit, status); body.append(create);
    create.addEventListener('submit', (event) => { event.preventDefault(); if (!create.reportValidity()) return; void action(submit, status, () => api('/api/admin/users', { method: 'POST', csrf: true, body: { username: username.value.trim(), displayName: displayName.value.trim(), password: password.value } }), () => { password.value = ''; void show('team'); }); });
    const list = el('div', 'expansion-grid');
    for (const user of users) {
      const card = el('section', 'studio-card'); card.append(el('h2', '', user.displayName || user.username), el('p', 'field-help', `${user.username} · ${user.role === 'owner' ? 'Ana yönetici' : 'Ortak'} · ${user.disabled ? 'Devre dışı' : 'Etkin'}`), el('p', 'field-help', user.mfaEnabled ? 'Authenticator etkin' : 'İlk girişte kendi Authenticator kurulumunu tamamlayacak.'));
      if (user.role !== 'owner' && user.id !== 'owner') {
        const form = el('form', 'studio-form'); const name = input(form, 'Görünen ad', 'displayName', { value: user.displayName, required: true, maxLength: 100 }); const reset = input(form, 'Yeni geçici şifre (değiştirmeyeceksen boş bırak)', 'resetPassword', { type: 'password', maxLength: 128 }); reset.minLength = 16; reset.autocomplete = 'new-password'; const disabled = check('Hesabı devre dışı bırak', user.disabled); const save = button('Hesabı güncelle', null); save.type = 'submit'; const note = notice(); form.append(disabled.wrapper, save, note); card.append(form);
        form.addEventListener('submit', (event) => { event.preventDefault(); if (!form.reportValidity()) return; void action(save, note, () => api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', csrf: true, body: { displayName: name.value.trim(), disabled: disabled.control.checked, ...(reset.value ? { resetPassword: reset.value } : {}) } }), () => { reset.value = ''; void show('team'); }); });
      }
      list.append(card);
    }
    body.append(list);
  }

  function renderClients(body, clients) {
    body.append(el('p', 'field-help', 'Yalnızca gerçek müşterileri ve yayınlama izniniz olan logoları ekleyin. Yayınlanan kayıtlar sitedeki Müşterilerimiz alanında görünür.'));
    const newButton = button('Yeni müşteri ekle +', () => { editor(null); }); body.append(newButton); const list = el('div', 'expansion-grid'); const edit = el('div'); body.append(list, edit);
    for (const client of clients) { const card = el('section', 'studio-card client-admin-card'); if (typeof (client.logo?.url || client.logoUrl) === 'string' && (client.logo?.url || client.logoUrl).startsWith('/')) { const img = el('img', 'client-logo-preview'); img.src = client.logo?.url || client.logoUrl; img.alt = client.name; card.append(img); } card.append(el('h2', '', client.name), el('p', 'field-help', client.published ? 'Yayında' : 'Taslak'), button('Düzenle ↗', () => editor(client))); list.append(card); }
    if (!clients.length) list.append(el('p', 'field-help', 'Müşteriler bölümünü ilk gerçek kaydınla aç.'));
    function editor(client) {
      edit.replaceChildren(); const form = el('form', 'studio-card studio-form'); form.append(el('h2', '', client ? 'Müşteriyi düzenle' : 'Yeni müşteri')); const name = input(form, 'Müşteri / marka adı', 'name', { required: true, maxLength: 120, value: client?.name || '' }); const description = input(form, 'Kısa açıklama', 'description', { tag: 'textarea', maxLength: 500, value: client?.description || '' }); const order = input(form, 'Görünüm sırası', 'sortOrder', { type: 'number', value: client?.sortOrder || 0 }); const permission = check('Müşteri adı ve logosunu yayınlama iznimiz var.', client?.permissionConfirmed); const published = check('Sitede yayınla', client?.published); const save = button('Müşteriyi kaydet', null, 'button primary'); save.type = 'submit'; const status = notice(); form.append(permission.wrapper, published.wrapper, save, status); edit.append(form);
      form.addEventListener('submit', (event) => { event.preventDefault(); if (!form.reportValidity()) return; void action(save, status, () => api(client ? `/api/admin/clients/${encodeURIComponent(client.id)}` : '/api/admin/clients', { method: client ? 'PATCH' : 'POST', csrf: true, body: { name: name.value.trim(), description: description.value.trim(), sortOrder: Number(order.value || 0), permissionConfirmed: permission.control.checked, published: published.control.checked } }), (result) => { message(status, 'Müşteri kaydedildi.', 'success'); if (!client && result.client) { client = result.client; addLogo(client); } }); });
      function addLogo(record) { const uploadForm = el('div', 'studio-card studio-form'); uploadForm.append(el('h2', '', 'Müşteri logosu')); const file = input(uploadForm, 'Logo: JPG, PNG veya WebP (en fazla 8 MB)', 'logo', { type: 'file' }); file.accept = 'image/jpeg,image/png,image/webp'; const upload = button('Logoyu yükle ↑', null); const note = notice(); uploadForm.append(upload, note); edit.append(uploadForm); upload.addEventListener('click', () => { if (!file.files[0]) { message(note, 'Önce bir görsel seç.'); return; } void action(upload, note, () => ctx.uploadFile(`/api/admin/clients/${encodeURIComponent(record.id)}/logo`, file.files[0], ['image/jpeg', 'image/png', 'image/webp'], note), () => { file.value = ''; message(note, 'Logo yüklendi.', 'success'); }); }); }
      if (client) { addLogo(client); if (account.role === 'owner') { const removeStatus = notice(); const remove = button('Müşteriyi kaldır', () => { if (!window.confirm('Bu müşteri kaydı ve logosu kaldırılsın mı?')) return; void action(remove, removeStatus, () => api(`/api/admin/clients/${encodeURIComponent(client.id)}`, { method: 'DELETE', csrf: true, body: { confirmation: 'SİL' } }), () => show('clients')); }, 'button danger-outline'); edit.append(remove, removeStatus); } }
      name.focus(); edit.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function renderReviews(body, reviews) {
    body.append(el('p', 'field-help', 'Müşterinin yayın izni verdiği yorumlar burada kontrol edilir. Onayladığın yorumlar sitede görünür.'));
    if (!reviews.length) body.append(el('div', 'studio-card', 'Henüz müşteri yorumu yok. Müşterin teslim ekranından yorum gönderebilir.'));
    for (const review of reviews) { const card = el('section', 'studio-card'); card.append(el('h2', '', review.displayName || review.name || review.customerName || 'Müşteri yorumu'), el('p', 'field-help', [review.company || review.brand, review.rating ? `${review.rating}/5` : '', human(review.status), readableDate(review.createdAt, true)].filter(Boolean).join(' · ')), el('p', 'review-copy', review.message || review.text || review.comment || '')); const note = notice(); const actions = el('div', 'expansion-actions'); for (const [state, label] of [['approved', 'Onayla ve yayınla'], ['rejected', 'Yayınlama'], ['pending', 'Beklemeye al']]) { const control = button(label, () => action(control, note, () => api(`/api/admin/reviews/${encodeURIComponent(review.id)}`, { method: 'PATCH', csrf: true, body: { status: state } }), () => show('reviews'))); control.disabled = review.status === state; actions.append(control); } card.append(actions, note); body.append(card); }
  }
  function renderActivity(body, entries) {
    body.append(el('p', 'field-help', 'Ekip işlemleri tarih ve kullanıcı bilgisiyle kaydedilir. Parolalar, erişim kodları ve teslim bağlantılarının gizli anahtarları kayıtlara yazılmaz.'));
    const list = el('ol', 'activity-list'); for (const item of entries) { const row = el('li', 'studio-card'); row.append(el('strong', '', item.actorName || item.displayName || item.actorId || 'Stüdyo'), el('p', '', human(item.event || item.action)), el('small', '', `${readableDate(item.createdAt, true)} · ${human(item.targetType || '')}${item.targetId ? ` / ${item.targetId}` : ''}`)); list.append(row); } if (!entries.length) list.append(el('li', 'studio-card', 'İşlemler burada birikecek.')); body.append(list);
  }
  function renderTrash(body, entries) {
    body.append(el('p', 'field-help', 'Silinen proje ve dosyalar 30 gün boyunca geri yüklenebilir. Çöp kutusundaki teslimlere müşteriler erişemez. Kalıcı silme yalnızca ana yöneticiye açıktır.'));
    if (!entries.length) body.append(el('div', 'studio-card', 'Çöp kutusu boş.'));
    for (const entry of entries) { const card = el('section', 'studio-card'); card.append(el('h2', '', entry.title || 'Silinen kayıt'), el('p', 'field-help', `${human(entry.type)} · Silinme: ${readableDate(entry.deletedAt, true)} · Son geri yükleme: ${readableDate(entry.expiresAt, true)}`)); const note = notice(); const actions = el('div', 'expansion-actions'); const restore = button('Geri yükle ↗', () => action(restore, note, () => api(`/api/admin/trash/${encodeURIComponent(entry.id)}/restore`, { method: 'POST', csrf: true, body: {} }), () => show('trash'))); actions.append(restore);
      if (account.role === 'owner') { const confirm = input(actions, 'Kalıcı silmek için SİL yaz', 'purge', { maxLength: 3 }); const purge = button('Kalıcı sil', () => { if (confirm.value !== 'SİL') { message(note, 'Onay alanına SİL yaz.'); return; } void action(purge, note, () => api(`/api/admin/trash/${encodeURIComponent(entry.id)}`, { method: 'DELETE', csrf: true, body: { confirmation: 'SİL' } }), () => show('trash')); }, 'button danger-outline'); actions.append(purge); }
      card.append(actions, note); body.append(card);
    }
  }

  function leadTools(lead) {
    const wrapper = el('div', 'lead-operations-tools'); const operations = el('details', 'lead-studio-block'); operations.append(el('summary', '', 'Sorumlu, kapsam ve revizyon şartları')); const content = el('div'); operations.append(content); wrapper.append(operations);
    const quotes = el('details', 'lead-studio-block'); quotes.append(el('summary', '', 'Teklifler ve PDF')); const quoteContent = el('div'); quotes.append(quoteContent); wrapper.append(quotes);
    let opsLoaded = false; let quotesLoaded = false;
    operations.addEventListener('toggle', () => { if (operations.open && !opsLoaded) { opsLoaded = true; void loadOperations(); } }); quotes.addEventListener('toggle', () => { if (quotes.open && !quotesLoaded) { quotesLoaded = true; void loadQuotes(); } });
    async function loadOperations() {
      const generation = ctx.generation(); const status = notice(); content.replaceChildren(status); message(status, 'Proje kapsamı yükleniyor…', 'success');
      try { const [result, teamResult] = await Promise.all([api(`/api/admin/leads/${encodeURIComponent(lead.id)}/operations`), api('/api/admin/team')]); if (!safe(generation, content)) return; team = teamResult.users || []; const value = result.operations || {}; const form = el('form', 'studio-form'); const options = { '': 'Henüz atanmadı' }; for (const user of team) if (!user.disabled) options[user.id] = user.displayName || user.username;
        const assignee = input(form, 'Proje sorumlusu', 'assigneeId', { tag: 'select', options, value: value.assigneeId || '' }); const scope = input(form, 'Anlaşılan iş kapsamı', 'scope', { tag: 'textarea', maxLength: 4000, value: value.scope || '' }); const deliverables = input(form, 'Teslim edilecekler ve formatlar', 'deliverables', { tag: 'textarea', maxLength: 4000, value: value.deliverables || '' }); const deadline = input(form, 'Hedef teslim tarihi', 'deadline', { type: 'date', value: value.deadline || '' }); const save = button('Proje kapsamını kaydet', null, 'button primary'); save.type = 'submit'; form.append(el('p', 'revision-policy', 'İlk 3 revizyon dahildir. 4. revizyondan itibaren her revizyon 1.000 TL. Bu politika müşteri tesliminde ve teklif PDF’inde görünür.'), save, status); content.replaceChildren(form); message(status);
        form.addEventListener('submit', (event) => { event.preventDefault(); if (!form.reportValidity()) return; void action(save, status, () => api(`/api/admin/leads/${encodeURIComponent(lead.id)}/operations`, { method: 'PATCH', csrf: true, body: { assigneeId: assignee.value || null, scope: scope.value.trim(), deliverables: deliverables.value.trim(), deadline: deadline.value || null } }), () => { message(status, 'Proje kapsamı ve sorumlusu kaydedildi.', 'success'); void ctx.refreshLeads(); }); });
      } catch (error) { opsLoaded = false; if (safe(generation, content) && !ctx.handleAuthError(error)) message(status, error.message); }
    }
    async function loadQuotes() {
      const generation = ctx.generation(); const status = notice(); quoteContent.replaceChildren(status); message(status, 'Teklifler yükleniyor…', 'success');
      try { const result = await api(`/api/admin/leads/${encodeURIComponent(lead.id)}/quotes`); if (!safe(generation, quoteContent)) return; quoteContent.replaceChildren(); const list = el('div', 'quote-admin-list'); for (const quote of result.quotes || []) { const card = el('section', 'delivery-card'); card.append(el('h3', '', quote.title || 'Proje teklifi'), el('p', 'field-help', `${quote.number || ''} · ${moneyFormat.format((quote.totalCents || 0) / 100)} · ${human(quote.status)}`)); const pdf = el('a', 'button secondary', 'PDF indir ↓'); pdf.href = `/api/admin/quotes/${encodeURIComponent(quote.id)}/pdf`; pdf.download = `ordvis-teklif-${quote.number || quote.id}.pdf`; card.append(pdf); if (!['accepted', 'rejected'].includes(quote.status)) card.append(button('Teklifi düzenle', () => editor(quote))); else card.append(el('p', 'field-help', quote.status === 'accepted' ? 'Kabul edildi. Kayıt ve anlaşma şartları korunur.' : 'Kabul edilmedi. Yeni bir taslak hazırlayabilirsin.')); list.append(card); }
        const edit = el('div'); quoteContent.append(button('Yeni teklif hazırla +', () => editor(null)), list, edit);
        function editor(quote) { quoteEditor(edit, lead, quote, loadQuotes); }
        if (!result.quotes?.length) editor(null);
      } catch (error) { quotesLoaded = false; if (safe(generation, quoteContent) && !ctx.handleAuthError(error)) message(status, error.message); }
    }
    return wrapper;
  }

  function quoteEditor(container, lead, quote, reload) {
    const form = el('form', 'studio-form quote-editor'); form.append(el('h3', '', quote ? 'Teklifi düzenle' : 'Yeni teklif')); const title = input(form, 'Teklif başlığı', 'title', { required: true, maxLength: 160, value: quote?.title || `${lead.brand || 'Proje'} — hizmet teklifi` }); const rows = el('div', 'quote-line-items'); const rowControls = []; const sum = el('p', 'tracking-balance');
    function total() { const cents = rowControls.reduce((sum, row) => { const number = Number(row.price.value.replace(',', '.')); return sum + (Number.isFinite(number) ? Math.round(number * 100) * Number(row.quantity.value || 0) : 0); }, 0); sum.textContent = `Teklif toplamı: ${moneyFormat.format(cents / 100)}`; }
    function addRow(item = {}) { if (rowControls.length >= 20) return; const row = el('div', 'quote-line-item'); const description = input(row, 'Hizmet / kalem', 'description', { required: true, maxLength: 300, value: item.description || '' }); const quantity = input(row, 'Adet', 'quantity', { type: 'number', required: true, value: item.quantity || 1 }); quantity.min = '1'; quantity.max = '1000'; quantity.step = '1'; const price = input(row, 'Birim fiyat (TL)', 'price', { required: true, value: amount(item.unitPriceCents), maxLength: 14 }); price.inputMode = 'decimal'; const controls = { description, quantity, price }; rowControls.push(controls); row.append(button('Kalemi kaldır', () => { if (rowControls.length <= 1) return; rowControls.splice(rowControls.indexOf(controls), 1); row.remove(); total(); }, 'text-button')); row.addEventListener('input', total); rows.append(row); total(); }
    form.append(rows, button('Kalem ekle +', () => addRow()), sum); for (const item of quote?.items?.length ? quote.items : [{}]) addRow(item);
    const scope = input(form, 'İş kapsamı', 'scope', { tag: 'textarea', maxLength: 4000, value: quote?.scope ?? lead.operations?.scope ?? '' }); const deliverables = input(form, 'Teslim edilecekler', 'deliverables', { tag: 'textarea', maxLength: 4000, value: quote?.deliverables ?? lead.operations?.deliverables ?? '' }); const deadline = input(form, 'Teslim tarihi', 'deadline', { type: 'date', value: quote?.deadline || lead.operations?.deadline || '' }); const terms = input(form, 'Ek şartlar', 'terms', { tag: 'textarea', maxLength: 4000, value: quote?.terms || '' }); const state = input(form, 'Teklif durumu', 'status', { tag: 'select', value: quote?.status || 'draft', options: { draft: 'Taslak', sent: 'Müşteriye iletildi', accepted: 'Müşteri kabul etti', rejected: 'Kabul edilmedi' } }); form.append(el('p', 'revision-policy', '3 revizyon dahildir; sonrasında revizyon başına 1.000 TL. Teklif kabul edildiğinde kapsam ve toplam tutar proje kaydına bağlanır. Kabul edilen teklif değiştirilemez.'));
    const submit = button('Teklifi kaydet ↗', null, 'button primary'); submit.type = 'submit'; const status = notice(); form.append(submit, status); container.replaceChildren(form);
    if (quote?.status === 'sent') { for (const control of form.elements) if (control !== state && control !== submit) control.disabled = true; form.prepend(el('p', 'field-help', 'Gönderilmiş teklifin içeriği korunur. Kabul veya ret durumunu güncelleyebilirsin. İçerik değişikliği için yeni bir taslak hazırla.')); }
    form.addEventListener('submit', (event) => { event.preventDefault(); if (!form.reportValidity()) return; if (state.value === 'accepted' && !window.confirm('Bu teklifin müşteri tarafından kabul edildiğini onaylıyor musun? Teklif değiştirilemeyecek ve proje anlaşmasına bağlanacak.')) return; const payload = { title: title.value.trim(), scope: scope.value.trim(), deliverables: deliverables.value.trim(), deadline: deadline.value || null, terms: terms.value.trim(), status: state.value, items: rowControls.map((row) => ({ description: row.description.value.trim(), quantity: Number(row.quantity.value), unitPrice: row.price.value.trim() })) }; void action(submit, status, async () => { const generation = ctx.generation(); if (quote) return api(`/api/admin/quotes/${encodeURIComponent(quote.id)}`, { method: 'PATCH', csrf: true, body: quote.status === 'sent' ? { status: payload.status } : payload }); const created = await api(`/api/admin/leads/${encodeURIComponent(lead.id)}/quotes`, { method: 'POST', csrf: true, body: { ...payload, status: 'draft' } }); if (generation !== ctx.generation()) return; if (payload.status !== 'draft') { if (!created.quote?.id) throw new Error('Teklif kaydedildi; durumunu listeden güncelle.'); return api(`/api/admin/quotes/${encodeURIComponent(created.quote.id)}`, { method: 'PATCH', csrf: true, body: { status: payload.status } }); } return created; }, reload); });
  }

  return {
    clear() { account = {}; remaskPasswords(); mine = false; team = []; mineCheck.control.checked = false; syncMine(); for (const [name, section] of sections) { section.hidden = true; sectionToken.set(name, (sectionToken.get(name) || 0) + 1); $(`${name}-body`).replaceChildren(); message($(`${name}-message`)); } message(passwordMessage); },
    sessionChanged(value) { account = value; remaskPasswords(); }, updateNavigation, hideSections, showPasswordGate, leadTools,
    matchesLead(lead) { return !mine || (lead.operations?.assigneeId || lead.assigneeId) === account.userId; },
  };
};
