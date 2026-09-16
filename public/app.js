(() => {
  const AVATAR_PALETTE = ['#e57373', '#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4db6ac', '#f06292', '#9575cd'];
  const INACTIVITY_MS = 17 * 60 * 1000; // ~17 min, within the 15-20 min window

  const state = {
    contacts: [],
    currentContactId: null,
    models: [],
    editingContactId: null, // null while overlay closed; 'new' for a fresh contact
    editMode: 'manual', // 'manual' | 'import' — only relevant while editingContactId === 'new'
    importDraft: null, // { first_message } from a parsed character card, pending save
    settings: { theme: 'default', dark_mode: 'system', wallpaper_url: '', ollama_url: '' },
  };

  let inactivityTimer = null;
  let systemDarkMql = null;

  // ---------- DOM refs ----------

  const contactListEl = document.getElementById('contact-list');
  const addContactBtn = document.getElementById('add-contact-btn');
  const emptyStateEl = document.getElementById('empty-state');
  const chatViewEl = document.getElementById('chat-view');
  const chatHeaderEl = document.getElementById('chat-header');
  const chatAvatarEl = document.getElementById('chat-avatar');
  const chatNameEl = document.getElementById('chat-name');
  const messagesEl = document.getElementById('messages');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');

  const editOverlay = document.getElementById('edit-overlay');
  const editTitle = document.getElementById('edit-title');
  const editClose = document.getElementById('edit-close');
  const editModeToggle = document.getElementById('edit-mode-toggle');
  const editFields = document.getElementById('edit-fields');
  const editAvatarPreview = document.getElementById('edit-avatar-preview');
  const editAvatarBtn = document.getElementById('edit-avatar-btn');
  const editAvatarFile = document.getElementById('edit-avatar-file');
  const editName = document.getElementById('edit-name');
  const editModel = document.getElementById('edit-model');
  const editPersonaPrompt = document.getElementById('edit-persona-prompt');
  const editError = document.getElementById('edit-error');
  const editSave = document.getElementById('edit-save');

  const cardImportDrop = document.getElementById('card-import-drop');
  const cardImportText = document.getElementById('card-import-text');
  const cardImportFile = document.getElementById('card-import-file');
  const cardImportError = document.getElementById('card-import-error');

  const settingsBtn = document.getElementById('settings-btn');
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsClose = document.getElementById('settings-close');
  const darkModeToggle = document.getElementById('dark-mode-toggle');
  const themeGrid = document.getElementById('theme-grid');
  const wallpaperSection = document.getElementById('wallpaper-section');
  const wallpaperDrop = document.getElementById('wallpaper-drop');
  const wallpaperDropText = document.getElementById('wallpaper-drop-text');
  const wallpaperFile = document.getElementById('wallpaper-file');
  const ollamaUrlInput = document.getElementById('ollama-url-input');
  const ollamaUrlSave = document.getElementById('ollama-url-save');
  const settingsError = document.getElementById('settings-error');

  // ---------- Helpers ----------

  function avatarNode(contact, size) {
    const el = document.createElement('div');
    el.className = 'avatar';
    fillAvatarEl(el, contact);
    return el;
  }

  function fillAvatarEl(el, contact) {
    el.innerHTML = '';
    if (contact.avatar_url) {
      el.style.background = 'transparent';
      const img = document.createElement('img');
      img.src = contact.avatar_url;
      el.appendChild(img);
    } else {
      el.style.background = AVATAR_PALETTE[(contact.id || 0) % AVATAR_PALETTE.length];
      el.textContent = (contact.name || '?').trim().charAt(0).toUpperCase();
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function api(path, options) {
    const resp = await fetch(path, options);
    if (!resp.ok) {
      let msg = `Request failed (${resp.status})`;
      try {
        const data = await resp.json();
        if (data.error) msg = data.error;
      } catch {}
      throw new Error(msg);
    }
    return resp;
  }

  // ---------- Theming ----------

  function resolveMode(darkMode) {
    if (darkMode === 'light' || darkMode === 'dark') return darkMode;
    return systemDarkMql && systemDarkMql.matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const root = document.documentElement;
    root.dataset.theme = state.settings.theme || 'default';
    root.dataset.mode = resolveMode(state.settings.dark_mode || 'system');

    if (state.settings.theme === 'glass' && state.settings.wallpaper_url) {
      root.style.setProperty('--body-bg-image', `url("${state.settings.wallpaper_url}")`);
    } else {
      root.style.setProperty('--body-bg-image', 'none');
    }
  }

  async function loadSettings() {
    try {
      const resp = await api('/api/settings');
      state.settings = await resp.json();
    } catch (err) {
      console.error('failed to load settings', err);
    }
    applyTheme();
  }

  async function patchSettings(partial) {
    Object.assign(state.settings, partial);
    applyTheme();
    const resp = await api('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    state.settings = await resp.json();
    applyTheme();
  }

  if (window.matchMedia) {
    systemDarkMql = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => {
      if (state.settings.dark_mode === 'system') applyTheme();
    };
    if (systemDarkMql.addEventListener) systemDarkMql.addEventListener('change', onSystemChange);
    else if (systemDarkMql.addListener) systemDarkMql.addListener(onSystemChange);
  }

  // ---------- Contacts sidebar ----------

  async function loadContacts() {
    const resp = await api('/api/contacts');
    state.contacts = await resp.json();
    renderContactList();
  }

  function renderContactList() {
    contactListEl.innerHTML = '';
    if (!state.contacts.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-sidebar';
      empty.textContent = 'No contacts yet. Tap + to add one.';
      contactListEl.appendChild(empty);
      return;
    }
    for (const contact of state.contacts) {
      const row = document.createElement('div');
      row.className = 'contact-row' + (contact.id === state.currentContactId ? ' active' : '');
      row.appendChild(avatarNode(contact));

      const textWrap = document.createElement('div');
      textWrap.className = 'contact-row-text';

      const nameEl = document.createElement('div');
      nameEl.className = 'contact-row-name';
      nameEl.textContent = contact.name;

      const previewEl = document.createElement('div');
      previewEl.className = 'contact-row-preview';
      previewEl.textContent = contact.last_message || 'No messages yet';

      textWrap.appendChild(nameEl);
      textWrap.appendChild(previewEl);
      row.appendChild(textWrap);

      const menuBtn = document.createElement('button');
      menuBtn.className = 'icon-btn contact-row-menu-btn';
      menuBtn.title = 'More';
      menuBtn.textContent = '⋮';
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleContactRowMenu(row, contact);
      });
      row.appendChild(menuBtn);

      row.addEventListener('click', () => openContact(contact.id));
      contactListEl.appendChild(row);
    }
  }

  function closeContactRowMenus() {
    for (const menu of contactListEl.querySelectorAll('.contact-row-menu')) menu.remove();
    for (const btn of contactListEl.querySelectorAll('.contact-row-menu-btn')) btn.classList.remove('menu-open');
  }

  function toggleContactRowMenu(row, contact) {
    const existing = row.querySelector('.contact-row-menu');
    closeContactRowMenus();
    if (existing) return; // was already open; just closed it above

    row.querySelector('.contact-row-menu-btn').classList.add('menu-open');

    const menu = document.createElement('div');
    menu.className = 'contact-row-menu';
    const deleteItem = document.createElement('button');
    deleteItem.type = 'button';
    deleteItem.className = 'contact-row-menu-item';
    deleteItem.textContent = 'Delete contact';
    deleteItem.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContactRowMenus();
      deleteContact(contact);
    });
    menu.appendChild(deleteItem);
    menu.addEventListener('click', (e) => e.stopPropagation());
    row.appendChild(menu);
  }

  document.addEventListener('click', closeContactRowMenus);

  async function deleteContact(contact) {
    const ok = window.confirm(
      `Delete ${contact.name}? This removes the contact and all messages with them.`
    );
    if (!ok) return;

    try {
      await api(`/api/contacts/${contact.id}`, { method: 'DELETE' });
    } catch (err) {
      alert(`Could not delete contact: ${err.message}`);
      return;
    }

    if (state.currentContactId === contact.id) {
      state.currentContactId = null;
      clearInactivityTimer();
      chatViewEl.hidden = true;
      emptyStateEl.hidden = false;
    }
    await loadContacts();
  }

  // ---------- Chat view ----------

  async function openContact(id) {
    if (state.currentContactId !== null && state.currentContactId !== id) {
      // leaving a conversation: end it and trigger summarization
      triggerSummary(state.currentContactId, false);
    }
    state.currentContactId = id;
    clearInactivityTimer();
    renderContactList();

    const contact = state.contacts.find((c) => c.id === id);
    emptyStateEl.hidden = true;
    chatViewEl.hidden = false;

    fillAvatarEl(chatAvatarEl, contact);
    chatNameEl.textContent = contact.name;

    messagesEl.innerHTML = '<div class="empty-sidebar">Loading…</div>';
    const resp = await api(`/api/contacts/${id}/messages`);
    const messages = await resp.json();
    renderMessages(messages);
    messageInput.focus();
    resetInactivityTimer();
  }

  function renderMessages(messages) {
    messagesEl.innerHTML = '';
    for (const m of messages) {
      appendBubble(m.role, m.content);
    }
    scrollToBottom();
  }

  function appendBubble(role, content) {
    const row = document.createElement('div');
    row.className = 'msg-row ' + (role === 'user' ? 'out' : 'in');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = content;
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    return bubble;
  }

  function appendTypingIndicator() {
    const row = document.createElement('div');
    row.className = 'msg-row in';
    row.id = 'typing-row';
    const bubble = document.createElement('div');
    bubble.className = 'bubble typing-bubble';
    bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    scrollToBottom();
    return row;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function sendMessage() {
    const content = messageInput.value.trim();
    if (!content || state.currentContactId === null) return;
    const contactId = state.currentContactId;

    messageInput.value = '';
    appendBubble('user', content);
    scrollToBottom();
    bumpContactPreview(contactId, content);
    resetInactivityTimer();

    const typingRow = appendTypingIndicator();

    let resp;
    try {
      resp = await fetch(`/api/contacts/${contactId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    } catch (err) {
      typingRow.remove();
      appendBubble('assistant', `[connection error: ${err.message}]`);
      return;
    }

    if (!resp.ok || !resp.body) {
      typingRow.remove();
      let msg = `Ollama error (${resp.status})`;
      try {
        const data = await resp.json();
        if (data.error) msg = data.error;
      } catch {}
      appendBubble('assistant', `[${msg}]`);
      scrollToBottom();
      return;
    }

    typingRow.remove();
    const bubble = appendBubble('assistant', '');
    scrollToBottom();

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
      bubble.textContent = full;
      scrollToBottom();
    }

    bumpContactPreview(contactId, full || content);
    resetInactivityTimer();
  }

  function bumpContactPreview(contactId, previewText) {
    const contact = state.contacts.find((c) => c.id === contactId);
    if (!contact) return;
    contact.last_message = previewText;
    contact.last_message_at = new Date().toISOString();
    state.contacts.sort((a, b) => new Date(b.last_message_at || b.created_at) - new Date(a.last_message_at || a.created_at));
    renderContactList();
  }

  // ---------- Inactivity + close summarization ----------

  function clearInactivityTimer() {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
  }

  function resetInactivityTimer() {
    clearInactivityTimer();
    const contactId = state.currentContactId;
    if (contactId === null) return;
    inactivityTimer = setTimeout(() => {
      if (state.currentContactId === contactId) {
        triggerSummary(contactId, false);
      }
    }, INACTIVITY_MS);
  }

  function triggerSummary(contactId, useBeacon) {
    if (contactId === null) return;
    if (useBeacon && navigator.sendBeacon) {
      const blob = new Blob(['{}'], { type: 'application/json' });
      navigator.sendBeacon(`/api/contacts/${contactId}/summarize`, blob);
    } else {
      fetch(`/api/contacts/${contactId}/summarize`, { method: 'POST' }).catch(() => {});
    }
  }

  window.addEventListener('beforeunload', () => {
    if (state.currentContactId !== null) {
      triggerSummary(state.currentContactId, true);
    }
  });

  // ---------- Edit / add contact overlay ----------

  async function loadModels() {
    try {
      const resp = await api('/api/models');
      state.models = await resp.json();
    } catch (err) {
      state.models = [];
      console.error('failed to load models', err);
    }
  }

  function populateModelSelect(selected) {
    editModel.innerHTML = '';
    if (!state.models.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No models found — is Ollama running?';
      editModel.appendChild(opt);
      return;
    }
    for (const name of state.models) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      editModel.appendChild(opt);
    }
    if (selected && state.models.includes(selected)) {
      editModel.value = selected;
    }
  }

  async function openEditOverlay(contactId) {
    editError.hidden = true;
    editError.textContent = '';
    state.importDraft = null;
    await loadModels();

    if (contactId === 'new') {
      editTitle.textContent = 'New contact';
      editName.value = '';
      populateModelSelect(state.models[0] || '');
      setEditAvatarPreview({ id: 0, name: '', avatar_url: '' });
      editAvatarFile.value = '';
      editAvatarPreview.dataset.url = '';
      editPersonaPrompt.value = '';
      editModeToggle.hidden = false;
      setEditMode('manual');
    } else {
      const contact = state.contacts.find((c) => c.id === contactId);
      editTitle.textContent = 'Edit contact';
      editName.value = contact.name;
      populateModelSelect(contact.model);
      setEditAvatarPreview(contact);
      editAvatarFile.value = '';
      editAvatarPreview.dataset.url = contact.avatar_url || '';
      editPersonaPrompt.value = contact.persona_prompt || '';
      editModeToggle.hidden = true;
      cardImportDrop.hidden = true;
      editFields.hidden = false;
    }

    state.editingContactId = contactId;
    editOverlay.hidden = false;
    editName.focus();
  }

  function setEditMode(mode) {
    state.editMode = mode;
    state.importDraft = null;
    cardImportError.hidden = true;
    cardImportError.textContent = '';
    cardImportFile.value = '';
    cardImportText.textContent = 'drop a character card PNG or click to browse';

    for (const btn of editModeToggle.querySelectorAll('.segmented-btn')) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }

    if (mode === 'import') {
      cardImportDrop.hidden = false;
      editFields.hidden = true;
    } else {
      cardImportDrop.hidden = true;
      editFields.hidden = false;
      editName.value = '';
      populateModelSelect(state.models[0] || '');
      setEditAvatarPreview({ id: 0, name: '', avatar_url: '' });
      editAvatarPreview.dataset.url = '';
      editPersonaPrompt.value = '';
    }
  }

  async function importCharacterCard(file) {
    cardImportError.hidden = true;
    cardImportText.textContent = 'reading card…';
    const formData = new FormData();
    formData.append('card', file);
    try {
      const resp = await api('/api/cards/parse', { method: 'POST', body: formData });
      const data = await resp.json();

      state.importDraft = { first_message: data.first_message || '' };
      editName.value = data.name || '';
      populateModelSelect(state.models[0] || '');
      editAvatarPreview.dataset.url = data.avatar_url || '';
      setEditAvatarPreview({ id: 0, name: data.name || '', avatar_url: data.avatar_url || '' });
      editPersonaPrompt.value = data.persona_prompt || '';

      cardImportDrop.hidden = true;
      editFields.hidden = false;
      editName.focus();
    } catch (err) {
      cardImportText.textContent = 'drop a character card PNG or click to browse';
      cardImportError.hidden = false;
      cardImportError.textContent = err.message;
    }
  }

  function setEditAvatarPreview(contact) {
    editAvatarPreview.innerHTML = '';
    editAvatarPreview.style.background = '';
    if (contact.avatar_url) {
      editAvatarPreview.style.background = 'transparent';
      const img = document.createElement('img');
      img.src = contact.avatar_url;
      editAvatarPreview.appendChild(img);
    } else {
      editAvatarPreview.style.background = AVATAR_PALETTE[(contact.id || 0) % AVATAR_PALETTE.length];
      editAvatarPreview.textContent = (contact.name || editName.value || '?').trim().charAt(0).toUpperCase() || '?';
    }
  }

  function closeEditOverlay() {
    editOverlay.hidden = true;
    state.editingContactId = null;
  }

  editClose.addEventListener('click', closeEditOverlay);
  editOverlay.addEventListener('click', (e) => {
    if (e.target === editOverlay) closeEditOverlay();
  });

  editModeToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    setEditMode(btn.dataset.mode);
  });

  cardImportDrop.addEventListener('click', () => cardImportFile.click());
  cardImportDrop.addEventListener('dragover', (e) => {
    e.preventDefault();
    cardImportDrop.classList.add('drag-over');
  });
  cardImportDrop.addEventListener('dragleave', () => cardImportDrop.classList.remove('drag-over'));
  cardImportDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    cardImportDrop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) importCharacterCard(file);
  });
  cardImportFile.addEventListener('change', () => {
    const file = cardImportFile.files[0];
    if (file) importCharacterCard(file);
  });

  addContactBtn.addEventListener('click', () => openEditOverlay('new'));
  chatHeaderEl.addEventListener('click', () => {
    if (state.currentContactId !== null) openEditOverlay(state.currentContactId);
  });

  editAvatarBtn.addEventListener('click', () => editAvatarFile.click());
  editAvatarFile.addEventListener('change', async () => {
    const file = editAvatarFile.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('avatar', file);
    try {
      const resp = await api('/api/upload/avatar', { method: 'POST', body: formData });
      const data = await resp.json();
      editAvatarPreview.dataset.url = data.url;
      editAvatarPreview.innerHTML = '';
      editAvatarPreview.style.background = 'transparent';
      const img = document.createElement('img');
      img.src = data.url;
      editAvatarPreview.appendChild(img);
    } catch (err) {
      editError.hidden = false;
      editError.textContent = err.message;
    }
  });

  editName.addEventListener('input', () => {
    if (!editAvatarPreview.dataset.url) {
      editAvatarPreview.textContent = editName.value.trim().charAt(0).toUpperCase() || '?';
    }
  });

  editSave.addEventListener('click', async () => {
    const name = editName.value.trim();
    const model = editModel.value;
    if (!name) {
      editError.hidden = false;
      editError.textContent = 'Name is required';
      return;
    }
    if (!model) {
      editError.hidden = false;
      editError.textContent = 'Pick a model';
      return;
    }
    const payload = {
      name,
      model,
      avatar_url: editAvatarPreview.dataset.url || '',
      persona_prompt: editPersonaPrompt.value.trim(),
    };
    if (state.editingContactId === 'new' && state.importDraft) {
      payload.first_message = state.importDraft.first_message;
    }

    try {
      let contact;
      if (state.editingContactId === 'new') {
        const resp = await api('/api/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        contact = await resp.json();
      } else {
        const resp = await api(`/api/contacts/${state.editingContactId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        contact = await resp.json();
      }
      closeEditOverlay();
      await loadContacts();
      if (state.currentContactId === contact.id) {
        openContact(contact.id);
      }
    } catch (err) {
      editError.hidden = false;
      editError.textContent = err.message;
    }
  });

  // ---------- Settings overlay ----------

  function renderSettingsUI() {
    for (const btn of darkModeToggle.querySelectorAll('.segmented-btn')) {
      btn.classList.toggle('active', btn.dataset.value === (state.settings.dark_mode || 'system'));
    }
    for (const tile of themeGrid.querySelectorAll('.theme-tile')) {
      tile.classList.toggle('selected', tile.dataset.theme === (state.settings.theme || 'default'));
    }
    wallpaperSection.hidden = state.settings.theme !== 'glass';
    ollamaUrlInput.value = state.settings.ollama_url || '';
    settingsError.hidden = true;
    settingsError.textContent = '';
  }

  function openSettingsOverlay() {
    renderSettingsUI();
    settingsOverlay.hidden = false;
  }

  function closeSettingsOverlay() {
    settingsOverlay.hidden = true;
  }

  settingsBtn.addEventListener('click', openSettingsOverlay);
  settingsClose.addEventListener('click', closeSettingsOverlay);
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeSettingsOverlay();
  });

  darkModeToggle.addEventListener('click', async (e) => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    try {
      await patchSettings({ dark_mode: btn.dataset.value });
      renderSettingsUI();
    } catch (err) {
      settingsError.hidden = false;
      settingsError.textContent = err.message;
    }
  });

  themeGrid.addEventListener('click', async (e) => {
    const tile = e.target.closest('.theme-tile');
    if (!tile) return;
    try {
      await patchSettings({ theme: tile.dataset.theme });
      renderSettingsUI();
    } catch (err) {
      settingsError.hidden = false;
      settingsError.textContent = err.message;
    }
  });

  wallpaperDrop.addEventListener('click', () => wallpaperFile.click());
  wallpaperDrop.addEventListener('dragover', (e) => {
    e.preventDefault();
    wallpaperDrop.classList.add('drag-over');
  });
  wallpaperDrop.addEventListener('dragleave', () => wallpaperDrop.classList.remove('drag-over'));
  wallpaperDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    wallpaperDrop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) uploadWallpaper(file);
  });
  wallpaperFile.addEventListener('change', () => {
    const file = wallpaperFile.files[0];
    if (file) uploadWallpaper(file);
  });

  async function uploadWallpaper(file) {
    wallpaperDropText.textContent = 'uploading…';
    const formData = new FormData();
    formData.append('wallpaper', file);
    try {
      const resp = await api('/api/upload/wallpaper', { method: 'POST', body: formData });
      const data = await resp.json();
      state.settings.wallpaper_url = data.url;
      applyTheme();
      wallpaperDropText.textContent = 'drop an image or click to browse';
    } catch (err) {
      wallpaperDropText.textContent = 'drop an image or click to browse';
      settingsError.hidden = false;
      settingsError.textContent = err.message;
    }
  }

  ollamaUrlSave.addEventListener('click', async () => {
    const url = ollamaUrlInput.value.trim();
    if (!url) {
      settingsError.hidden = false;
      settingsError.textContent = 'Ollama URL is required';
      return;
    }
    try {
      await patchSettings({ ollama_url: url });
      settingsError.hidden = true;
    } catch (err) {
      settingsError.hidden = false;
      settingsError.textContent = err.message;
    }
  });

  // ---------- Input row ----------

  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  });

  // ---------- Init ----------

  loadSettings();
  loadContacts();
})();
