import {
  $, $$, h, icon, hydrateIcons, avatar, fillAvatar, colorFor, renderMarkdown, isEmojiOnly, snippet,
  timeOf, listTime, dayLabel, dayKey, toDate, toast, openModal, closeModal, topModal, bindModal,
  confirmDialog, showMenu, closeMenu, positionPopover, debounce, storage, playPop, PALETTE,
} from './util.js';
import { api, getJSON, sendJSON, uploadImage, readEvents } from './api.js';
import { PERSONA_TEMPLATES, QUICK_REACTIONS, EMOJIS } from './templates.js';

const INACTIVITY_MS = 17 * 60 * 1000;
const MOBILE = () => window.matchMedia('(max-width: 760px)').matches;

const THEMES = [
  { key: 'default', label: 'Default', bg: '#17212b', bar: '#5aa0e8', block: 'rgba(255,255,255,.16)' },
  { key: 'whatsapp', label: 'WhatsApp', bg: '#0b141a', bar: '#00a884', block: 'rgba(255,255,255,.16)' },
  { key: 'discord', label: 'Discord', bg: '#313338', bar: '#5865f2', block: 'rgba(255,255,255,.16)' },
  { key: 'midnight', label: 'Midnight', bg: '#000', bar: '#a78bfa', block: 'rgba(255,255,255,.14)' },
  { key: 'paper', label: 'Paper', bg: '#efe6d3', bar: '#a9702e', block: 'rgba(74,60,40,.2)' },
  { key: 'sakura', label: 'Sakura', bg: '#fdf0f3', bar: '#e05d8a', block: 'rgba(160,60,90,.18)' },
  { key: 'glass', label: 'Glass', bg: 'linear-gradient(135deg,#2a2035,#1a1e2e)', bar: '#b48ee0', block: 'rgba(255,255,255,.2)' },
  { key: 'dracula', label: 'Dracula', bg: '#282a36', bar: '#ff79c6', block: 'rgba(189,147,249,.35)' },
  { key: 'synthwave', label: 'Synthwave', bg: 'linear-gradient(135deg,#241b3a,#17101f)', bar: '#36f9f6', block: 'rgba(255,126,219,.35)' },
];

const STYLE_HINTS = {
  texting: 'Short, casual texts like a real friend. Built-in rules stop the model from sounding like an assistant, even on small 3-4B models.',
  roleplay: 'In-character replies, *actions* allowed, a bit longer. Good for character cards and stories.',
  raw: 'Only your description below is used as the system prompt. No built-in rules.',
};

const state = {
  settings: {},
  chats: [],
  contacts: [],
  models: [],
  ollamaOk: null,
  currentId: null,
  msgs: [],
  hasMore: false,
  loadingOlder: false,
  streams: new Map(), // chat id -> { controller, typing: Map(sender id -> streamed text) }
  replyTo: null,
  attachments: [], // composer: { key, name, isImage, preview, uploading, info }
  drafts: storage.get('drafts', {}),
  filter: '',
  search: { ids: [], index: -1 },
  missed: 0,
  editing: null,
  editingGroup: null,
};

// ---------- DOM refs ----------

const appEl = $('#app');
const chatListEl = $('#chat-list');
const emptyStateEl = $('#empty-state');
const chatViewEl = $('#chat-view');
const messagesEl = $('#messages');
const inputEl = $('#message-input');
const sendBtn = $('#send-btn');
const stopBtn = $('#stop-btn');
const jumpBtn = $('#jump-btn');

const currentChat = () => state.chats.find((c) => c.id === state.currentId) || null;
const chatById = (id) => state.chats.find((c) => c.id === id) || null;
const userName = () => (state.settings.user_name || '').trim() || 'You';

// ================= Settings & theming =================

let systemDark = window.matchMedia('(prefers-color-scheme: dark)');
systemDark.addEventListener?.('change', () => state.settings.dark_mode === 'system' && applyTheme());

function applyTheme() {
  const s = state.settings;
  const root = document.documentElement;
  root.dataset.theme = s.theme || 'default';
  root.dataset.mode =
    s.dark_mode === 'light' || s.dark_mode === 'dark' ? s.dark_mode : systemDark.matches ? 'dark' : 'light';
  root.dataset.bubbles = s.bubble_style || 'round';
  root.dataset.density = s.density || 'comfy';
  root.style.setProperty('--fs', `${Number(s.font_size) || 14}px`);

  if (s.accent_color) {
    root.style.setProperty('--accent', s.accent_color);
    root.style.setProperty('--accent-dark', `color-mix(in srgb, ${s.accent_color} 78%, #000)`);
    root.dataset.accent = 'custom';
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-dark');
    delete root.dataset.accent;
  }

  const wall = s.wallpaper_url ? `url("${s.wallpaper_url}")` : 'none';
  const glass = root.dataset.theme === 'glass';
  root.style.setProperty('--body-bg-image', glass ? wall : 'none');
  root.style.setProperty('--chat-wallpaper', glass ? 'none' : wall);
  root.style.setProperty('--wall-dim', String((Number(s.wallpaper_dim) || 0) / 100));
  root.style.setProperty('--wall-blur', `${Number(s.wallpaper_blur) || 0}px`);
  root.classList.toggle('has-wallpaper', !!s.wallpaper_url && !glass);
}

async function loadSettings() {
  try {
    state.settings = await getJSON('/api/settings');
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
  applyTheme();
}

async function patchSettings(partial) {
  Object.assign(state.settings, partial);
  applyTheme();
  try {
    state.settings = await sendJSON('/api/settings', 'PATCH', partial);
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
  applyTheme();
  renderMe();
}

function renderMe() {
  fillAvatar($('#me-avatar'), { name: userName(), avatar_url: state.settings.user_avatar_url, color: state.settings.accent_color || '#5aa0e8' });
  $('#me-name').textContent = (state.settings.user_name || '').trim() || 'Set your name';
}

// ================= Data =================

let busyPoll = null;

async function loadChats() {
  const prev = state.chats;
  try {
    state.chats = await getJSON('/api/chats');
  } catch (err) {
    toast(err.message, { type: 'error' });
    return;
  }
  if (state.currentId && !currentChat()) closeChat();
  renderChatList();
  renderHeader();
  updateTitle();
  syncRemoteBusy(prev);
}

// A reply can still be generating server-side after a reload (it isn't tied
// to this tab's connection). Poll until it finishes and pull in new messages.
const remoteBusy = (chat) => chat?.busy && !state.streams.has(chat.id);

function syncRemoteBusy(prevChats) {
  const cur = currentChat();
  const before = prevChats.find((c) => c.id === cur?.id);
  if (cur && before && !state.streams.has(cur.id) && before.last_message?.id !== cur.last_message?.id) {
    reloadMessages().then(() => !document.hidden && markRead(cur.id));
  }
  if (cur && !state.streams.has(cur.id)) renderTypingPlaceholder(remoteBusy(cur));
  clearTimeout(busyPoll);
  if (state.chats.some(remoteBusy)) busyPoll = setTimeout(loadChats, 1500);
}

function renderTypingPlaceholder(on) {
  const existing = $('.remote-typing', messagesEl);
  if (!on) return existing?.remove();
  if (existing) return;
  const near = isNearBottom();
  messagesEl.append(
    h('div', { class: 'msg-row in g-start g-end remote-typing' },
      h('div', { class: 'msg-body' }, h('div', { class: 'bubble typing-bubble', html: '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>' })))
  );
  if (near) scrollToBottom();
}

async function loadContacts() {
  state.contacts = await getJSON('/api/contacts');
}

async function loadModels() {
  try {
    state.models = await getJSON('/api/models');
    setOllamaStatus(true);
  } catch {
    state.models = [];
    setOllamaStatus(false);
  }
  return state.models;
}

async function checkStatus() {
  try {
    const s = await getJSON('/api/status');
    setOllamaStatus(s.ok);
  } catch {
    setOllamaStatus(false);
  }
}

function setOllamaStatus(ok) {
  const changed = state.ollamaOk !== ok;
  state.ollamaOk = ok;
  const el = $('#ollama-status');
  el.classList.toggle('ok', ok);
  el.classList.toggle('bad', !ok);
  $('.label', el).textContent = ok ? 'Ollama connected' : 'Ollama offline';
  if (changed && !state.currentId) renderEmptyState();
}

let avatarPresets = [];
async function loadAvatarPresets() {
  try {
    avatarPresets = (await getJSON('/avatars/index.json')).map((f) => `/avatars/${f}`);
  } catch {
    avatarPresets = [];
  }
}

function renderAvatarPresets(el, current, onPick) {
  el.replaceChildren(
    ...avatarPresets.map((url) =>
      h('button', { type: 'button', class: `preset${current === url ? ' active' : ''}`, title: 'Use this picture', onclick: () => onPick(url) }, h('img', { src: url, alt: '' }))
    )
  );
  el.hidden = !avatarPresets.length;
}

// Can at least one model in this chat see images?
function chatCanSee(chat) {
  return chat.members.some((m) => state.models.find((x) => x.name === m.model)?.vision !== false);
}

function defaultModel() {
  const names = state.models.map((m) => m.name);
  if (state.settings.default_model && names.includes(state.settings.default_model)) return state.settings.default_model;
  return names[0] || '';
}

function sortChats() {
  const ts = (c) => c.last_message?.created_at || c.created_at;
  state.chats.sort((a, b) => b.pinned - a.pinned || ts(b).localeCompare(ts(a)));
}

function updateTitle() {
  const n = state.chats.filter((c) => !c.muted).reduce((sum, c) => sum + (c.unread || 0), 0);
  document.title = n ? `(${n}) Chatboard` : 'Chatboard';
}

// ================= Sidebar =================

function previewText(chat) {
  const st = state.streams.get(chat.id);
  if (st && st.typing.size) {
    const names = [...st.typing.keys()].map((id) => chat.members.find((m) => m.id === id)?.name).filter(Boolean);
    return { typing: true, text: chat.kind === 'group' && names.length ? `${names[0]} is typing…` : 'typing…' };
  }
  if (remoteBusy(chat)) return { typing: true, text: 'typing…' };
  const m = chat.last_message;
  if (!m) return { text: chat.kind === 'group' ? `${chat.members.length} members` : chat.about || 'Say hi 👋' };
  const body = m.content ? snippet(m.content, 90) : m.attachment || attachmentLabel(m);
  const prefix = m.role === 'user' ? 'You: ' : chat.kind === 'group' && m.sender_name ? `${m.sender_name.split(' ')[0]}: ` : '';
  return { text: prefix + body };
}

function renderChatList() {
  const q = state.filter.trim().toLowerCase();
  const list = state.chats.filter(
    (c) => !q || c.name?.toLowerCase().includes(q) || c.members.some((m) => m.name.toLowerCase().includes(q))
  );
  chatListEl.replaceChildren();
  if (!state.chats.length) {
    chatListEl.append(h('div', { class: 'list-empty' }, 'No chats yet.', h('br'), 'Hit ', icon('compose', 14), ' to start one.'));
    return;
  }
  if (!list.length) {
    chatListEl.append(h('div', { class: 'list-empty' }, `No chats match “${state.filter}”`));
    return;
  }
  for (const chat of list) {
    const pv = previewText(chat);
    const row = h(
      'div',
      {
        class: `chat-row${chat.id === state.currentId ? ' active' : ''}${chat.unread ? ' unread' : ''}`,
        role: 'listitem',
        tabindex: '0',
        onclick: () => openChat(chat.id),
        onkeydown: (e) => e.key === 'Enter' && openChat(chat.id),
        oncontextmenu: (e) => {
          e.preventDefault();
          showMenu(row, chatMenuItems(chat), { align: 'right' });
        },
      },
      avatar(chat, { group: chat.kind === 'group' }),
      h(
        'div',
        { class: 'chat-row-body' },
        h(
          'div',
          { class: 'chat-row-top' },
          h('span', { class: 'chat-row-name' }, chat.name),
          chat.kind === 'group' ? h('span', { class: 'row-ic', title: 'Group' }, icon('users', 13)) : null,
          chat.muted ? h('span', { class: 'row-ic', title: 'Muted' }, icon('mute', 13)) : null,
          h('span', { class: 'chat-row-time' }, listTime(chat.last_message?.created_at))
        ),
        h(
          'div',
          { class: 'chat-row-bottom' },
          h('span', { class: `chat-row-preview${pv.typing ? ' typing' : ''}` }, pv.text),
          chat.pinned && !chat.unread ? h('span', { class: 'row-ic', title: 'Pinned' }, icon('pin', 13)) : null,
          chat.unread ? h('span', { class: `badge${chat.muted ? ' muted' : ''}` }, chat.unread > 99 ? '99+' : chat.unread) : null
        )
      )
    );
    chatListEl.append(row);
  }
}

$('#chat-search').addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderChatList();
});
$('#chat-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = $('.chat-row', chatListEl);
    first?.click();
  }
});

$('#new-btn').addEventListener('click', (e) =>
  showMenu(e.currentTarget, [
    { label: 'New contact', icon: 'userPlus', onClick: () => openContactModal() },
    { label: 'New group', icon: 'users', onClick: () => openGroupModal() },
    { label: 'Import character card', icon: 'card', onClick: () => openContactModal({ importMode: true }) },
  ])
);

// ================= Empty state / welcome =================

function renderEmptyState() {
  emptyStateEl.replaceChildren();
  const wrap = h('div', { class: 'welcome' });
  emptyStateEl.append(wrap);

  if (state.ollamaOk === false) {
    wrap.append(
      h(
        'div',
        { class: 'notice' },
        h('strong', {}, "Can't reach Ollama. "),
        `Chatboard talks to ${state.settings.ollama_url || 'http://127.0.0.1:11434'}. Start it with `,
        h('code', {}, 'ollama serve'),
        ' and pull a small model, e.g. ',
        h('code', {}, 'ollama pull gemma3:4b'),
        '.'
      )
    );
  }

  if (!state.contacts.length) {
    wrap.append(
      h('div', { class: 'welcome-logo' }, icon('chat', 34)),
      h('h1', {}, 'Welcome to Chatboard'),
      h('p', { class: 'muted' }, 'Text your local AI friends. Everything runs on your machine.')
    );
    if (!(state.settings.user_name || '').trim()) {
      const nameInput = h('input', { class: 'input', placeholder: 'What should they call you?', maxlength: 60 });
      nameInput.addEventListener('change', () => patchSettings({ user_name: nameInput.value.trim() }));
      wrap.append(h('div', { class: 'welcome-name' }, nameInput));
    }
    wrap.append(h('div', { class: 'section-label' }, 'Pick someone to start with'));
    const grid = h('div', { class: 'template-grid' });
    for (const t of PERSONA_TEMPLATES) {
      grid.append(
        h(
          'button',
          { class: 'template-card', onclick: () => quickCreate(t) },
          avatar({ name: t.name, color: t.color, avatar_url: t.avatar }),
          h('div', { class: 'template-card-name' }, t.name),
          h('div', { class: 'template-card-label' }, t.label),
          h('div', { class: 'template-card-about' }, t.about)
        )
      );
    }
    wrap.append(
      grid,
      h(
        'div',
        { class: 'welcome-actions' },
        h('button', { class: 'btn btn-primary', onclick: () => openContactModal() }, icon('userPlus', 16), 'Create your own'),
        h('button', { class: 'btn', onclick: () => openContactModal({ importMode: true }) }, icon('card', 16), 'Import character card')
      )
    );
  } else {
    wrap.append(
      h('div', { class: 'welcome-logo subtle' }, icon('chat', 30)),
      h('h2', {}, 'Pick a chat'),
      h('p', { class: 'muted' }, 'Or start something new.'),
      h(
        'div',
        { class: 'welcome-actions' },
        h('button', { class: 'btn btn-primary', onclick: () => openContactModal() }, icon('userPlus', 16), 'New contact'),
        h('button', { class: 'btn', onclick: () => openGroupModal() }, icon('users', 16), 'New group')
      )
    );
  }
}

async function quickCreate(t) {
  const model = defaultModel();
  if (!model) return toast('No models found. Is Ollama running?', { type: 'error' });
  try {
    const contact = await sendJSON('/api/contacts', 'POST', templatePayload(t, model));
    await Promise.all([loadContacts(), loadChats()]);
    openChat(contact.dm_chat_id);
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}

const templatePayload = (t, model) => ({
  name: t.name,
  model,
  about: t.about,
  status: t.status,
  color: t.color,
  avatar_url: t.avatar || '',
  persona_prompt: t.persona,
  style: t.style || 'texting',
  length: t.length || 'short',
  first_message: t.first_message || '',
});

// ================= Opening chats =================

async function openChat(id) {
  const chat = chatById(id);
  if (!chat) return;
  if (state.currentId && state.currentId !== id) {
    saveDraft();
    summarize(state.currentId);
  }
  const switching = state.currentId !== id;
  state.currentId = id;
  storage.set('lastChat', id);
  appEl.classList.add('chat-open');
  emptyStateEl.hidden = true;
  chatViewEl.hidden = false;
  if (switching) {
    state.replyTo = null;
    clearAttachments();
    closeSearch();
    renderReplyBar();
    state.missed = 0;
  }
  renderChatList();
  renderHeader();
  updateComposerState();

  if (switching) {
    messagesEl.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
    inputEl.value = state.drafts[id] || '';
    autosize();
  }
  try {
    const { messages, has_more } = await getJSON(`/api/chats/${id}/messages`);
    if (state.currentId !== id) return;
    state.msgs = messages;
    state.hasMore = has_more;
  } catch (err) {
    toast(err.message, { type: 'error' });
    return;
  }
  renderMessages({ scroll: 'bottom' });
  markRead(id);
  if (!MOBILE()) inputEl.focus();
  resetInactivity();
}

function closeChat() {
  if (state.currentId) {
    saveDraft();
    summarize(state.currentId);
  }
  state.currentId = null;
  storage.set('lastChat', null);
  appEl.classList.remove('chat-open');
  chatViewEl.hidden = true;
  emptyStateEl.hidden = false;
  renderEmptyState();
  renderChatList();
}

$('#back-btn').addEventListener('click', closeChat);

function renderHeader() {
  const chat = currentChat();
  if (!chat) return;
  const group = chat.kind === 'group';
  fillAvatar($('#chat-avatar'), chat, { group });
  $('#chat-name').textContent = chat.name;
  const statusEl = $('#chat-status');
  const st = state.streams.get(chat.id);
  const typingNames = st ? [...st.typing.keys()].map((sid) => chat.members.find((m) => m.id === sid)?.name).filter(Boolean) : [];
  statusEl.classList.toggle('typing', typingNames.length > 0 || remoteBusy(chat) || !!st?.status);
  if (st?.status) {
    statusEl.textContent = st.status;
  } else if (remoteBusy(chat)) {
    statusEl.textContent = 'typing…';
  } else if (typingNames.length) {
    statusEl.textContent = group
      ? `${typingNames.join(', ')} ${typingNames.length > 1 ? 'are' : 'is'} typing…`
      : 'typing…';
  } else if (group) {
    statusEl.textContent = [...chat.members.map((m) => m.name.split(' ')[0]), 'you'].join(', ');
  } else {
    statusEl.textContent = chat.status || 'online';
  }
  $('#nudge-btn').title = group ? 'Let them keep talking' : `Nudge ${chat.name.split(' ')[0]} to text again`;
}

$('#chat-title').addEventListener('click', () => {
  const chat = currentChat();
  if (chat) openChatInfo(chat);
});

function openChatInfo(chat) {
  if (chat.kind === 'group') openGroupModal(chat);
  else {
    const contact = state.contacts.find((c) => c.id === chat.contact_id);
    if (contact) openContactModal({ contact });
  }
}

// ================= Messages =================

const isNearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
const scrollToBottom = (smooth = false) =>
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });

function senderOf(m) {
  const chat = currentChat();
  return (
    chat?.members.find((x) => x.id === m.sender_id) ||
    state.contacts.find((x) => x.id === m.sender_id) || { id: m.sender_id, name: m.sender_name || 'Someone' }
  );
}

const sameSender = (a, b) =>
  a.role === b.role && (a.role === 'user' || (a.sender_id === b.sender_id && a.sender_name === b.sender_name));
const closeInTime = (a, b) => Math.abs(toDate(b.created_at) - toDate(a.created_at)) < 5 * 60 * 1000;

function renderMessages({ scroll = 'auto' } = {}) {
  const chat = currentChat();
  if (!chat) return;
  const near = isNearBottom();
  const prevHeight = messagesEl.scrollHeight;
  const prevTop = messagesEl.scrollTop;

  const frag = document.createDocumentFragment();
  if (state.hasMore) {
    frag.append(h('button', { class: 'load-older', onclick: loadOlder }, state.loadingOlder ? 'Loading…' : 'Load earlier messages'));
  } else {
    frag.append(chatIntro(chat));
  }

  const msgs = state.msgs;
  let lastAssistantIdx = -1;
  msgs.forEach((m, i) => m.role === 'assistant' && (lastAssistantIdx = i));
  const streaming = state.streams.has(chat.id);

  msgs.forEach((m, i) => {
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
    if (newDay) frag.append(h('div', { class: 'day-sep' }, h('span', {}, dayLabel(m.created_at))));
    const start = newDay || !sameSender(prev, m) || !closeInTime(prev, m);
    const end = !next || !sameSender(m, next) || dayKey(next.created_at) !== dayKey(m.created_at) || !closeInTime(m, next);
    frag.append(
      messageEl(m, {
        start,
        end,
        group: chat.kind === 'group',
        read: m.role === 'user' && i < lastAssistantIdx,
        canRegenerate: !streaming && i === msgs.length - 1 && m.role === 'assistant',
      })
    );
  });

  messagesEl.replaceChildren(frag);
  renderLive();
  if (remoteBusy(chat)) renderTypingPlaceholder(true);

  if (scroll === 'bottom' || (scroll === 'auto' && near)) {
    scrollToBottom();
    pinnedToBottom = true;
  }
  else if (scroll === 'preserve') messagesEl.scrollTop = messagesEl.scrollHeight - prevHeight + prevTop;
  else messagesEl.scrollTop = prevTop;
  updateJumpBtn();
}

function chatIntro(chat) {
  const group = chat.kind === 'group';
  return h(
    'div',
    { class: 'chat-intro' },
    avatar(chat, { group }),
    h('div', { class: 'chat-intro-name' }, chat.name),
    h(
      'div',
      { class: 'chat-intro-sub' },
      group ? chat.description || `${chat.members.map((m) => m.name).join(', ')} and you` : chat.about || 'This is the start of your chat.'
    ),
    group
      ? h('div', { class: 'chat-intro-members' }, chat.members.map((m) => avatar(m)))
      : h('div', { class: 'chat-intro-model' }, icon('cpu', 13), chat.model || '')
  );
}

function messageEl(m, { start, end, group, read, canRegenerate }) {
  const out = m.role === 'user';
  const sender = out ? null : senderOf(m);
  const atts = m.attachments || [];
  const images = atts.filter((a) => a.kind === 'image');
  const docs = atts.filter((a) => a.kind !== 'image');
  const emojiOnly = !atts.length && !m.reply && isEmojiOnly(m.content);
  const row = h('div', {
    class: `msg-row ${out ? 'out' : 'in'}${start ? ' g-start' : ''}${end ? ' g-end' : ''}${m.pending ? ' pending' : ''}`,
    dataset: { id: m.id },
  });

  if (group && !out) row.append(end ? avatar(sender) : h('div', { class: 'avatar-spacer' }));

  const body = h('div', { class: 'msg-body' });
  if (group && !out && start) body.append(h('div', { class: 'msg-sender', style: { color: colorFor(sender) } }, sender.name));
  const kindLabel = MESSAGE_KINDS[m.kind];
  if (kindLabel) body.append(h('div', { class: 'msg-kind' }, icon(kindLabel.icon, 13), kindLabel.label));

  const bubble = h('div', {
    class: `bubble${emojiOnly ? ' emoji-only' : ''}${images.length && !docs.length && !m.content && !m.reply ? ' media-only' : ''}`,
  });

  if (m.reply) {
    const r = m.reply;
    const who = r.deleted ? '' : r.role === 'user' ? 'You' : r.sender_name || 'Them';
    bubble.append(
      h(
        'div',
        { class: 'reply-quote', onclick: () => m.reply_to && scrollToMessage(m.reply_to) },
        h('div', { class: 'reply-quote-name' }, who),
        h('div', { class: 'reply-quote-text' }, r.deleted ? 'Deleted message' : r.content ? snippet(r.content, 120) : r.attachment || 'Attachment')
      )
    );
  }
  if (images.length) {
    bubble.append(
      h(
        'div',
        { class: `msg-images n${Math.min(images.length, 4)}` },
        images.map((a) =>
          h('img', { class: 'msg-image', src: a.url, alt: a.name || 'Photo', loading: 'lazy', onclick: () => openLightbox(a.url), onload: keepPinned })
        )
      )
    );
  }
  for (const a of docs) bubble.append(fileCard(a));
  if (m.content) bubble.append(h('div', { class: 'msg-text', html: renderMarkdown(m.content) }));

  const meta = h('span', { class: 'msg-meta' });
  const showTime = state.settings.show_timestamps !== '0';
  if (m.edited) meta.append(h('span', { class: 'edited' }, 'edited'));
  if (showTime) meta.append(h('span', {}, m.pending ? '' : timeOf(m.created_at)));
  if (out) meta.append(h('span', { class: `tick${read ? ' read' : ''}` }, icon(m.pending ? 'check' : 'checks', 15)));
  if (meta.childNodes.length) bubble.append(meta);
  // reserve room on the last text line so the time never overlaps the text
  const metaWidth = (showTime ? 50 : 0) + (out ? 20 : 0) + (m.edited ? 40 : 0);
  bubble.style.setProperty('--meta-w', `${metaWidth}px`);
  body.append(bubble);
  if (m.meta?.search) body.append(sourcesEl(m.meta.search));

  if (m.reactions?.length) {
    body.append(
      h(
        'div',
        { class: 'reactions' },
        m.reactions.map((e) => h('button', { class: 'reaction', title: 'Remove reaction', onclick: () => react(m, e) }, e))
      )
    );
  }
  row.append(body);

  if (!m.pending) {
    row.append(
      h(
        'div',
        { class: 'msg-actions' },
        h('button', { class: 'icon-btn sm', title: 'React', onclick: (e) => openReactionPicker(e.currentTarget, m) }, icon('smile', 17)),
        h('button', { class: 'icon-btn sm', title: 'Reply', onclick: () => setReply(m) }, icon('reply', 17)),
        canRegenerate
          ? h('button', { class: 'icon-btn sm', title: 'Regenerate', onclick: regenerate }, icon('refresh', 17))
          : null,
        h('button', { class: 'icon-btn sm', title: 'More', onclick: (e) => openMessageMenu(e.currentTarget, m, canRegenerate) }, icon('dots', 17))
      )
    );
    // right-click on desktop, long-press on touch
    row.addEventListener('contextmenu', (e) => {
      if (e.target.closest('a, textarea')) return;
      e.preventDefault();
      openMessageMenu(bubble, m, canRegenerate);
    });
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.msg-actions, textarea, a')) return;
      window.getSelection()?.removeAllRanges();
      react(m, '❤️');
    });
  }
  return row;
}

const MESSAGE_KINDS = {
  reminder: { icon: 'bellRing', label: 'Reminder' },
  search: { icon: 'globe', label: 'Looked it up' },
};

function sourcesEl(search) {
  if (search.error) return h('div', { class: 'sources' }, h('span', { class: 'source-error' }, `Search failed: ${search.error}`));
  return h(
    'div',
    { class: 'sources' },
    (search.results || []).slice(0, 4).map((r) => {
      let host = r.url;
      try {
        host = new URL(r.url).hostname.replace(/^www\./, '');
      } catch {}
      return h('a', { class: 'source', href: r.url, target: '_blank', rel: 'noopener noreferrer', title: r.title }, icon('globe', 12), h('span', {}, host));
    })
  );
}

const KIND_LABEL = { pdf: 'PDF', doc: 'DOCX', text: 'TXT' };

function fileExt(name, kind) {
  const ext = (name.split('.').pop() || '').toUpperCase();
  return ext && ext.length <= 4 ? ext : KIND_LABEL[kind] || 'FILE';
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileMeta(a) {
  return [
    a.pages ? `${a.pages} page${a.pages === 1 ? '' : 's'}` : '',
    formatSize(a.size),
    a.kind !== 'image' && a.text_chars === 0 ? 'no readable text' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const fileIcon = (a) => h('div', { class: `file-icon ${a.kind}` }, icon('file', 16), h('span', {}, fileExt(a.name, a.kind)));

function fileCard(a) {
  return h(
    'a',
    { class: 'file-card', href: a.url, target: '_blank', rel: 'noopener', title: `Open ${a.name}` },
    fileIcon(a),
    h('div', { class: 'file-info' }, h('div', { class: 'file-name' }, a.name), h('div', { class: 'file-meta' }, fileMeta(a)))
  );
}

// Live (still streaming) bubbles and typing indicators, kept after the history.
function renderLive() {
  const chat = currentChat();
  const st = chat && state.streams.get(chat.id);
  for (const el of $$('.live-row', messagesEl)) {
    if (!st || !st.typing.has(Number(el.dataset.sender))) el.remove();
  }
  if (!st) return;
  const near = isNearBottom();
  for (const [sid, text] of st.typing) {
    let row = $(`.live-row[data-sender="${sid}"]`, messagesEl);
    if (!row) {
      const sender = senderOf({ sender_id: sid });
      row = h('div', { class: 'msg-row in g-start g-end live-row', dataset: { sender: sid } });
      if (chat.kind === 'group') row.append(avatar(sender));
      const body = h('div', { class: 'msg-body' });
      if (chat.kind === 'group') body.append(h('div', { class: 'msg-sender', style: { color: colorFor(sender) } }, sender.name));
      body.append(h('div', { class: 'bubble' }));
      row.append(body);
      messagesEl.append(row);
    }
    const bubble = $('.bubble', row);
    const t = (text || '').trim();
    if (t) {
      bubble.classList.remove('typing-bubble');
      bubble.innerHTML = `<div class="msg-text">${renderMarkdown(t)}</div>`;
    } else if (!bubble.classList.contains('typing-bubble')) {
      bubble.className = 'bubble typing-bubble';
      bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    }
  }
  if (near) scrollToBottom();
}

async function loadOlder() {
  const chat = currentChat();
  const first = state.msgs.find((m) => !m.pending);
  if (!chat || !first || state.loadingOlder) return;
  state.loadingOlder = true;
  try {
    const { messages, has_more } = await getJSON(`/api/chats/${chat.id}/messages?before=${first.id}`);
    if (state.currentId !== chat.id) return;
    state.msgs = [...messages, ...state.msgs];
    state.hasMore = has_more;
  } catch (err) {
    toast(err.message, { type: 'error' });
  } finally {
    state.loadingOlder = false;
  }
  renderMessages({ scroll: 'preserve' });
}

function updateJumpBtn() {
  const away = !isNearBottom();
  jumpBtn.hidden = !away;
  if (!away) state.missed = 0;
  const count = $('#jump-count');
  count.hidden = !state.missed;
  count.textContent = state.missed;
}

// stay at the bottom while images above finish loading and change the height
let pinnedToBottom = true;
function keepPinned() {
  if (pinnedToBottom) scrollToBottom();
}

messagesEl.addEventListener('scroll', () => {
  pinnedToBottom = isNearBottom();
  if (messagesEl.scrollTop < 60 && state.hasMore && !state.loadingOlder) loadOlder();
  updateJumpBtn();
});
jumpBtn.addEventListener('click', () => {
  state.missed = 0;
  scrollToBottom(true);
});

function scrollToMessage(id) {
  const el = $(`.msg-row[data-id="${id}"]`, messagesEl);
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  return true;
}

function openLightbox(src) {
  $('#lightbox-img').src = src;
  openModal($('#lightbox'));
}

// ================= Streaming =================

async function runStream(chatId, url, body = {}) {
  if (state.streams.has(chatId)) {
    toast('Still replying, hang on a sec');
    return false;
  }
  const controller = new AbortController();
  const st = { controller, typing: new Map() };
  state.streams.set(chatId, st);
  if (chatId === state.currentId) {
    updateComposerState();
    renderMessages();
  }
  let ok = true;
  try {
    const resp = await api(url, { method: 'POST', body, signal: controller.signal });
    await readEvents(resp, (ev) => handleEvent(chatId, st, ev));
  } catch (err) {
    if (err.name !== 'AbortError') {
      ok = false;
      toast(err.message, { type: 'error' });
    }
  } finally {
    state.streams.delete(chatId);
    const aborted = controller.signal.aborted;
    if (chatId === state.currentId) {
      updateComposerState();
      renderHeader();
      if (aborted) {
        // the server saved whatever was typed so far; pick it up
        setTimeout(() => chatId === state.currentId && reloadMessages(), 300);
      } else renderMessages();
    }
    await loadChats();
    if (chatId === state.currentId && !document.hidden) markRead(chatId);
    resetInactivity();
  }
  return ok;
}

async function reloadMessages() {
  const chat = currentChat();
  if (!chat) return;
  const { messages, has_more } = await getJSON(`/api/chats/${chat.id}/messages`);
  if (state.currentId !== chat.id) return;
  state.msgs = messages;
  state.hasMore = has_more;
  renderMessages();
}

function handleEvent(chatId, st, ev) {
  const isCurrent = chatId === state.currentId;
  const chat = chatById(chatId);
  switch (ev.type) {
    case 'user_message': {
      if (isCurrent) {
        const i = state.msgs.findIndex((m) => m.pending);
        if (i >= 0) state.msgs[i] = ev.message;
        else state.msgs.push(ev.message);
        renderMessages();
      }
      bumpPreview(chat, ev.message, false);
      break;
    }
    case 'status':
      st.status = ev.text;
      if (isCurrent) renderHeader();
      break;
    case 'message_updated':
      if (isCurrent) replaceMessage(ev.message);
      break;
    case 'reminder_set': {
      const r = ev.reminder;
      toast(`⏰ Reminder set: ${r.text} · ${formatWhen(r.due_at)}`, { timeout: 5000 });
      break;
    }
    case 'typing':
      st.status = '';
      st.typing.set(ev.sender_id, '');
      if (isCurrent) {
        renderLive();
        renderHeader();
      }
      renderChatList();
      break;
    case 'token':
      st.typing.set(ev.sender_id, (st.typing.get(ev.sender_id) || '') + ev.text);
      if (isCurrent) renderLive();
      break;
    case 'message': {
      st.typing.set(ev.sender_id, ev.carry || '');
      const visible = isCurrent && !document.hidden;
      if (isCurrent) {
        const wasNear = isNearBottom();
        state.msgs.push(ev.message);
        renderMessages();
        if (!wasNear) state.missed++;
        updateJumpBtn();
        if (visible) scheduleRead(chatId);
      }
      bumpPreview(chat, ev.message, !visible);
      if (!visible && chat && !chat.muted && state.settings.sounds !== '0') playPop();
      if (chat && (!visible || !document.hasFocus())) notify(chat, ev.message);
      break;
    }
    case 'removed':
      if (isCurrent) {
        state.msgs = state.msgs.filter((m) => !ev.ids.includes(m.id));
        renderMessages();
      }
      break;
    case 'stop_typing':
      st.typing.delete(ev.sender_id);
      if (isCurrent) {
        renderLive();
        renderHeader();
      }
      renderChatList();
      break;
    case 'error':
      toast(ev.error, { type: 'error', timeout: 7000 });
      break;
  }
}

function bumpPreview(chat, message, countUnread) {
  if (!chat) return;
  chat.last_message = message;
  if (countUnread && message.role === 'assistant') chat.unread = (chat.unread || 0) + 1;
  sortChats();
  renderChatList();
  updateTitle();
}

// ----- server events: replies nobody asked for (reminders, contacts texting first) -----

const refreshChatsSoon = debounce(() => loadChats(), 400);

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    try {
      onServerEvent(JSON.parse(e.data));
    } catch (err) {
      console.error('bad server event', err);
    }
  };
  // EventSource reconnects by itself; resync once it does
  es.onopen = () => state.eventsSeen && refreshChatsSoon();
  state.eventsSeen = true;
}

function onServerEvent(ev) {
  if (ev.type === 'chats_changed') return refreshChatsSoon();
  const chatId = ev.chat_id;
  if (!chatId) return;
  if (ev.type === 'turn_start') {
    if (state.streams.has(chatId)) return;
    state.streams.set(chatId, { controller: null, background: true, typing: new Map(), status: '' });
    if (!chatById(chatId)) loadChats();
    if (chatId === state.currentId) {
      updateComposerState();
      renderHeader();
    }
    renderChatList();
    return;
  }
  const st = state.streams.get(chatId);
  if (!st?.background) return; // replies we asked for arrive on their own response
  if (ev.type === 'turn_end') {
    state.streams.delete(chatId);
    if (chatId === state.currentId) {
      updateComposerState();
      renderHeader();
      renderMessages();
      if (!document.hidden) markRead(chatId);
    }
    refreshChatsSoon();
    return;
  }
  handleEvent(chatId, st, ev);
}

const tauri = () => window.__TAURI__;

async function notify(chat, message) {
  if (state.settings.notifications === '0' || chat.muted || message.role !== 'assistant') return;
  const title = chat.kind === 'group' ? `${message.sender_name} · ${chat.name}` : chat.name;
  const body = (message.kind === 'reminder' ? '⏰ ' : '') + (message.content || attachmentLabel(message));
  const t = tauri()?.notification;
  if (t) {
    try {
      let ok = await t.isPermissionGranted();
      if (!ok) ok = (await t.requestPermission()) === 'granted';
      if (ok) t.sendNotification({ title, body });
    } catch (err) {
      console.error('notification failed', err);
    }
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, tag: `chat-${chat.id}`, icon: chat.avatar_url || undefined });
  n.onclick = () => {
    window.focus();
    openChat(chat.id);
    n.close();
  };
}

function formatWhen(iso) {
  const d = toDate(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

const readTimers = new Map();
function scheduleRead(chatId) {
  clearTimeout(readTimers.get(chatId));
  readTimers.set(chatId, setTimeout(() => markRead(chatId), 400));
}

function markRead(chatId) {
  const chat = chatById(chatId);
  if (chat) chat.unread = 0;
  renderChatList();
  updateTitle();
  api(`/api/chats/${chatId}/read`, { method: 'POST', body: {} }).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.currentId) markRead(state.currentId);
});

// ================= Composer =================

function updateComposerState() {
  const streaming = state.streams.has(state.currentId);
  sendBtn.hidden = streaming;
  stopBtn.hidden = !streaming;
  const chat = currentChat();
  inputEl.placeholder = chat?.kind === 'group' ? 'Message the group  (@ to mention, / for commands)' : 'Message  (/ for commands)';
}

function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 180)}px`;
}

const persistDrafts = debounce(() => storage.set('drafts', state.drafts), 500);
function saveDraft() {
  if (!state.currentId) return;
  const v = inputEl.value;
  if (v.trim()) state.drafts[state.currentId] = v;
  else delete state.drafts[state.currentId];
  persistDrafts();
}

inputEl.addEventListener('input', () => {
  autosize();
  saveDraft();
  updateMentions();
});

inputEl.addEventListener('keydown', (e) => {
  if (mentionState.open && handleMentionKey(e)) return;
  if (e.key === 'Enter' && !e.isComposing) {
    const enterSends = state.settings.enter_to_send !== '0';
    if ((enterSends && !e.shiftKey) || (!enterSends && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      sendMessage();
    }
  } else if (e.key === 'ArrowUp' && !inputEl.value) {
    const last = [...state.msgs].reverse().find((m) => m.role === 'user' && !m.pending);
    if (last) {
      e.preventDefault();
      startEdit(last);
    }
  }
});

inputEl.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    attachFiles(files);
  }
});

sendBtn.addEventListener('click', sendMessage);
stopBtn.addEventListener('click', () => {
  const st = state.streams.get(state.currentId);
  if (!st) return;
  st.controller?.abort();
  api(`/api/chats/${state.currentId}/stop`, { method: 'POST' }).catch(() => {});
});

async function sendMessage() {
  const chat = currentChat();
  if (!chat) return;
  if (state.streams.has(chat.id)) return toast('Still replying. Hit stop to interrupt.');
  const content = inputEl.value.trim();
  const atts = state.attachments.filter((a) => a.info);
  if (!content && !atts.length) return;
  if (state.attachments.some((a) => a.uploading)) return toast('Still uploading, one sec…');
  if (!chat.members.length) return toast('Nobody is in this chat yet', { type: 'error' });

  const reply = state.replyTo;
  const pending = {
    id: `tmp-${Date.now()}`,
    pending: true,
    role: 'user',
    content,
    attachments: atts.map((a) => ({ ...a.info, url: a.info.kind === 'image' ? a.preview || a.info.url : a.info.url })),
    reply_to: reply?.id || null,
    reply: reply ? { role: reply.role, sender_name: reply.sender_name, content: reply.content, attachment: attachmentLabel(reply) } : null,
    reactions: [],
    created_at: new Date().toISOString(),
  };
  state.msgs.push(pending);
  inputEl.value = '';
  autosize();
  delete state.drafts[chat.id];
  persistDrafts();
  state.replyTo = null;
  renderReplyBar();
  state.attachments = []; // previews stay alive for the pending bubble
  renderAttachBar();
  closeMentions();
  renderMessages({ scroll: 'bottom' });
  resetInactivity();

  await runStream(chat.id, `/api/chats/${chat.id}/messages`, {
    content,
    attachments: atts.map((a) => a.info.id),
    reply_to: reply?.id || null,
  });

  // never confirmed by the server: take it back so nothing is lost
  if (state.msgs.includes(pending)) {
    state.msgs = state.msgs.filter((m) => m !== pending);
    if (state.currentId === chat.id) {
      renderMessages();
      if (!inputEl.value) {
        inputEl.value = content;
        autosize();
      }
    }
  }
}

async function nudge() {
  const chat = currentChat();
  if (!chat) return;
  if (!chat.members.length) return toast('Nobody is in this chat yet', { type: 'error' });
  runStream(chat.id, `/api/chats/${chat.id}/continue`);
}
$('#nudge-btn').addEventListener('click', nudge);

function regenerate() {
  const chat = currentChat();
  if (chat) runStream(chat.id, `/api/chats/${chat.id}/regenerate`);
}

// ----- reply -----

function setReply(m) {
  state.replyTo = m;
  renderReplyBar();
  inputEl.focus();
}

function renderReplyBar() {
  const bar = $('#reply-bar');
  const m = state.replyTo;
  bar.hidden = !m;
  if (!m) return;
  $('#reply-to-name').textContent = m.role === 'user' ? 'Replying to yourself' : `Replying to ${m.sender_name || 'them'}`;
  $('#reply-to-text').textContent = m.content ? snippet(m.content, 140) : attachmentLabel(m);
}
$('#reply-cancel').addEventListener('click', () => {
  state.replyTo = null;
  renderReplyBar();
});

// ----- attachments -----

const MAX_ATTACHMENTS = 10;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

function attachmentLabel(m) {
  const atts = m.attachments || [];
  if (!atts.length) return m.attachment || 'Attachment';
  if (atts.every((a) => a.kind === 'image')) return atts.length > 1 ? `📷 ${atts.length} photos` : '📷 Photo';
  return `📄 ${atts.find((a) => a.kind !== 'image').name}`;
}

$('#attach-btn').addEventListener('click', () => $('#attach-file').click());
$('#attach-file').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  attachFiles(files);
});

let visionWarnedFor = null;

function attachFiles(files) {
  const chat = currentChat();
  const room = MAX_ATTACHMENTS - state.attachments.length;
  if (files.length > room) toast(`Up to ${MAX_ATTACHMENTS} files per message`);
  for (const file of files.slice(0, Math.max(0, room))) {
    const isImage = file.type.startsWith('image/') && IMAGE_FILE.test(file.name || '.png');
    const item = { key: `${Date.now()}-${Math.random()}`, name: file.name || 'pasted image', size: file.size, isImage, preview: isImage ? URL.createObjectURL(file) : '', uploading: true, info: null };
    state.attachments.push(item);
    uploadImage('file', file)
      .then((info) => {
        item.uploading = false;
        item.info = info;
        if (info.warning) toast(info.warning, { timeout: 6000 });
      })
      .catch((err) => {
        toast(`${item.name}: ${err.message}`, { type: 'error' });
        removeAttachment(item);
      })
      .finally(renderAttachBar);
    if (isImage && chat && !chatCanSee(chat) && visionWarnedFor !== chat.id) {
      visionWarnedFor = chat.id;
      const model = chat.members[0]?.model || 'This model';
      toast(`${model} can't see images, so they'll only know you sent a photo. Switch them to a vision model to fix that.`, { timeout: 8000 });
    }
  }
  renderAttachBar();
  inputEl.focus();
}

function removeAttachment(item) {
  if (item.preview) URL.revokeObjectURL(item.preview);
  state.attachments = state.attachments.filter((a) => a !== item);
  renderAttachBar();
}

function clearAttachments() {
  for (const a of state.attachments) if (a.preview) URL.revokeObjectURL(a.preview);
  state.attachments = [];
  renderAttachBar();
}

function renderAttachBar() {
  const bar = $('#attach-bar');
  bar.hidden = !state.attachments.length;
  bar.replaceChildren(
    ...state.attachments.map((a) => {
      const x = h('button', { class: 'chip-x', title: 'Remove', onclick: () => removeAttachment(a) }, icon('x', 13));
      const spinner = a.uploading ? h('span', { class: 'spinner' }) : null;
      if (a.isImage) {
        return h('div', { class: `attach-chip image${a.uploading ? ' uploading' : ''}`, title: a.name }, h('img', { src: a.preview, alt: '' }), spinner, x);
      }
      const info = a.info || { name: a.name, kind: 'file', size: a.size };
      return h(
        'div',
        { class: `attach-chip${a.uploading ? ' uploading' : ''}`, title: a.name },
        fileIcon({ ...info, name: a.name }),
        h('div', { class: 'chip-text' }, h('div', { class: 'chip-name' }, a.name), h('div', { class: 'chip-meta' }, a.uploading ? 'Reading…' : fileMeta(info))),
        spinner,
        x
      );
    })
  );
}

const wrapEl = $('#messages-wrap');
let dragDepth = 0;
wrapEl.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  $('#drop-hint').hidden = false;
});
wrapEl.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#drop-hint').hidden = true;
  }
});
wrapEl.addEventListener('dragover', (e) => e.preventDefault());
wrapEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-hint').hidden = true;
  if (e.dataTransfer.files.length) attachFiles([...e.dataTransfer.files]);
});

// ----- emoji picker -----

let popoverEl = null;
function closePopover() {
  popoverEl?.remove();
  popoverEl = null;
}
document.addEventListener('mousedown', (e) => {
  if (popoverEl && !popoverEl.contains(e.target) && !e.target.closest('[data-popover-anchor]')) closePopover();
});

function emojiGrid(onPick) {
  return h(
    'div',
    { class: 'emoji-grid' },
    EMOJIS.map((e) => h('button', { class: 'emoji-cell', onclick: () => onPick(e) }, e))
  );
}

function insertAtCaret(text) {
  const { selectionStart: s, selectionEnd: e, value } = inputEl;
  inputEl.value = value.slice(0, s) + text + value.slice(e);
  inputEl.selectionStart = inputEl.selectionEnd = s + text.length;
  inputEl.focus();
  autosize();
  saveDraft();
}

$('#emoji-btn').dataset.popoverAnchor = '1';
$('#emoji-btn').addEventListener('click', (e) => {
  if (popoverEl) return closePopover();
  popoverEl = h('div', { class: 'popover emoji-popover' }, emojiGrid((emoji) => insertAtCaret(emoji)));
  positionPopover(popoverEl, e.currentTarget, 'right');
});

function openReactionPicker(anchor, m) {
  closePopover();
  const quick = h(
    'div',
    { class: 'reaction-row' },
    QUICK_REACTIONS.map((e) =>
      h('button', { class: `emoji-cell${m.reactions?.includes(e) ? ' on' : ''}`, onclick: () => (closePopover(), react(m, e)) }, e)
    ),
    h(
      'button',
      {
        class: 'emoji-cell more',
        title: 'More',
        onclick: () => {
          popoverEl.replaceChildren(emojiGrid((e) => (closePopover(), react(m, e))));
          positionPopover(popoverEl, anchor, 'right');
        },
      },
      icon('plus', 16)
    )
  );
  popoverEl = h('div', { class: 'popover reaction-popover' }, quick);
  positionPopover(popoverEl, anchor, 'right');
}

async function react(m, emoji) {
  try {
    const updated = await sendJSON(`/api/messages/${m.id}/react`, 'POST', { emoji });
    replaceMessage(updated);
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}

function replaceMessage(updated) {
  const i = state.msgs.findIndex((x) => x.id === updated.id);
  if (i >= 0) state.msgs[i] = updated;
  renderMessages();
}

// ----- mentions -----

const mentionState = { open: false, items: [], index: 0, start: 0 };
const mentionEl = h('div', { class: 'mention-pop', hidden: true });
$('#composer').append(mentionEl);

// slash commands share the mention popup
const COMMANDS = [
  { command: 'search', hint: 'look something up online', example: '/search ' },
  { command: 'remind', hint: 'set a reminder', example: 'remind me to ' },
];

function updateMentions() {
  const chat = currentChat();
  const before = inputEl.value.slice(0, inputEl.selectionStart);
  const cmd = before.match(/^\/(\w*)$/);
  if (chat && cmd) {
    const items = COMMANDS.filter((c) => c.command.startsWith(cmd[1].toLowerCase())).map((c) => ({ ...c, id: `cmd:${c.command}` }));
    if (!items.length) return closeMentions();
    Object.assign(mentionState, { open: true, items, index: 0, start: 0 });
    return renderMentions();
  }
  if (!chat || chat.kind !== 'group') return closeMentions();
  const m = before.match(/(^|\s)@([\p{L}\p{N}_]*)$/u);
  if (!m) return closeMentions();
  const q = m[2].toLowerCase();
  const items = [{ id: 'everyone', name: 'everyone' }, ...chat.members].filter((x) => x.name.toLowerCase().startsWith(q) || x.name.toLowerCase().includes(' ' + q));
  if (!items.length) return closeMentions();
  Object.assign(mentionState, { open: true, items, index: 0, start: before.length - m[2].length - 1 });
  renderMentions();
}

function renderMentions() {
  mentionEl.hidden = false;
  mentionEl.replaceChildren(
    ...mentionState.items.map((item, i) =>
      item.command
        ? h(
            'button',
            {
              class: `mention-item command-item${i === mentionState.index ? ' active' : ''}`,
              onmousedown: (e) => {
                e.preventDefault();
                pickMention(item);
              },
            },
            h('div', { class: 'avatar' }, icon(item.command === 'search' ? 'globe' : 'bellRing', 15)),
            h('code', {}, `/${item.command}`),
            h('small', {}, item.hint)
          )
        : h(
        'button',
        {
          class: `mention-item${i === mentionState.index ? ' active' : ''}`,
          onmousedown: (e) => {
            e.preventDefault();
            pickMention(item);
          },
        },
        item.id === 'everyone' ? h('div', { class: 'avatar' }, icon('users', 15)) : avatar(item),
        h('span', {}, item.id === 'everyone' ? 'everyone' : item.name),
        item.id === 'everyone' ? h('small', {}, 'notify the whole group') : null
      )
    )
  );
}

function handleMentionKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = mentionState.items.length;
    mentionState.index = (mentionState.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderMentions();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    pickMention(mentionState.items[mentionState.index]);
    return true;
  }
  if (e.key === 'Escape') {
    closeMentions();
    return true;
  }
  return false;
}

function pickMention(item) {
  const caret = inputEl.selectionStart;
  if (item.command) {
    inputEl.value = item.example + inputEl.value.slice(caret);
    inputEl.selectionStart = inputEl.selectionEnd = item.example.length;
    closeMentions();
    inputEl.focus();
    autosize();
    return saveDraft();
  }
  const label = item.id === 'everyone' ? 'everyone' : item.name.split(' ')[0];
  inputEl.value = `${inputEl.value.slice(0, mentionState.start)}@${label} ${inputEl.value.slice(caret)}`;
  const pos = mentionState.start + label.length + 2;
  inputEl.selectionStart = inputEl.selectionEnd = pos;
  closeMentions();
  inputEl.focus();
  saveDraft();
}

function closeMentions() {
  mentionState.open = false;
  mentionEl.hidden = true;
}

// ================= Message actions =================

function openMessageMenu(anchor, m, canRegenerate) {
  showMenu(anchor, [
    { label: 'Reply', icon: 'reply', onClick: () => setReply(m) },
    { label: 'React', icon: 'smile', onClick: () => openReactionPicker(anchor, m) },
    { label: 'Copy text', icon: 'copy', hidden: !m.content, onClick: () => copyText(m.content) },
    { label: 'Edit', icon: 'pencil', hidden: !m.content, onClick: () => startEdit(m) },
    { label: 'Regenerate', icon: 'refresh', hidden: !canRegenerate, onClick: regenerate },
    'sep',
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteMessage(m) },
  ]);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Could not copy', { type: 'error' });
  }
}

function startEdit(m) {
  const row = $(`.msg-row[data-id="${m.id}"]`, messagesEl);
  const textEl = row && $('.msg-text', row);
  if (!textEl) return;
  row.classList.add('editing');
  const ta = h('textarea', { class: 'edit-box', rows: 1 });
  ta.value = m.content;
  const finish = async (save) => {
    if (!save || ta.value.trim() === m.content) return renderMessages();
    try {
      replaceMessage(await sendJSON(`/api/messages/${m.id}`, 'PUT', { content: ta.value }));
    } catch (err) {
      toast(err.message, { type: 'error' });
      renderMessages();
    }
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      finish(false);
    }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  });
  textEl.replaceWith(ta, h('div', { class: 'edit-hint' }, 'Enter to save · Esc to cancel'));
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.dispatchEvent(new Event('input'));
}

async function deleteMessage(m) {
  try {
    await api(`/api/messages/${m.id}`, { method: 'DELETE' });
    state.msgs = state.msgs.filter((x) => x.id !== m.id);
    renderMessages();
    loadChats();
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}

// ================= In-chat search =================

const searchInput = $('#search-input');

function openSearch() {
  $('#search-bar').hidden = false;
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  $('#search-bar').hidden = true;
  searchInput.value = '';
  state.search = { ids: [], index: -1 };
  $('#search-count').textContent = '';
  $$('.search-hit', messagesEl).forEach((el) => el.classList.remove('search-hit'));
}

const runSearch = debounce(async () => {
  const chat = currentChat();
  const q = searchInput.value.trim();
  if (!chat || !q) {
    state.search = { ids: [], index: -1 };
    $('#search-count').textContent = '';
    return;
  }
  const results = await getJSON(`/api/chats/${chat.id}/search?q=${encodeURIComponent(q)}`);
  state.search = { ids: results.map((r) => r.id), index: results.length ? 0 : -1 };
  showSearchResult();
}, 250);

async function showSearchResult() {
  const { ids, index } = state.search;
  $('#search-count').textContent = ids.length ? `${index + 1} of ${ids.length}` : 'No results';
  if (index < 0) return;
  const id = ids[index];
  if (!$(`.msg-row[data-id="${id}"]`, messagesEl) && state.hasMore) {
    const chat = currentChat();
    const { messages, has_more } = await getJSON(`/api/chats/${chat.id}/messages?limit=500`);
    state.msgs = messages;
    state.hasMore = has_more;
    renderMessages({ scroll: 'keep' });
  }
  $$('.search-hit', messagesEl).forEach((el) => el.classList.remove('search-hit'));
  $(`.msg-row[data-id="${id}"]`, messagesEl)?.classList.add('search-hit');
  scrollToMessage(id);
}

searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    step(e.shiftKey ? 1 : -1);
  } else if (e.key === 'Escape') closeSearch();
});
function step(dir) {
  const s = state.search;
  if (!s.ids.length) return;
  // results come newest first; "up" goes to older ones
  s.index = (s.index - dir + s.ids.length) % s.ids.length;
  showSearchResult();
}
$('#search-prev').addEventListener('click', () => step(-1));
$('#search-next').addEventListener('click', () => step(1));
$('#search-close').addEventListener('click', closeSearch);
$('#search-btn').addEventListener('click', () => ($('#search-bar').hidden ? openSearch() : closeSearch()));

// ================= Chat menu =================

function chatMenuItems(chat) {
  const dm = chat.kind === 'dm';
  return [
    { label: chat.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', onClick: () => patchChat(chat, { pinned: !chat.pinned }) },
    { label: chat.muted ? 'Unmute' : 'Mute', icon: chat.muted ? 'bell' : 'mute', onClick: () => patchChat(chat, { muted: !chat.muted }) },
    { label: dm ? 'Edit contact' : 'Edit group', icon: 'pencil', onClick: () => openChatInfo(chat) },
    { label: 'Reminders', icon: 'bellRing', onClick: () => openReminders(chat) },
    { label: dm ? `Nudge ${chat.name.split(' ')[0]}` : 'Let them keep talking', icon: 'sparkle', onClick: () => (openChat(chat.id), runStream(chat.id, `/api/chats/${chat.id}/continue`)) },
    'sep',
    { label: 'Export as text', icon: 'download', onClick: () => download(`/api/chats/${chat.id}/export`) },
    { label: 'Export as JSON', icon: 'download', onClick: () => download(`/api/chats/${chat.id}/export?format=json`) },
    'sep',
    { label: 'Clear history', icon: 'trash', danger: true, onClick: () => clearChat(chat) },
    { label: dm ? 'Delete contact' : 'Delete group', icon: 'trash', danger: true, onClick: () => (dm ? deleteContact(chat.contact_id) : deleteGroup(chat)) },
  ];
}

$('#chat-menu-btn').addEventListener('click', (e) => {
  const chat = currentChat();
  if (chat) {
    showMenu(e.currentTarget, [
      { label: 'Search messages', icon: 'search', onClick: openSearch },
      ...chatMenuItems(chat),
    ]);
  }
});

function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

async function patchChat(chat, patch) {
  try {
    const updated = await sendJSON(`/api/chats/${chat.id}`, 'PUT', patch);
    Object.assign(chat, updated);
    sortChats();
    renderChatList();
    renderHeader();
    updateTitle();
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}

async function clearChat(chat) {
  const ok = await confirmDialog({
    title: `Clear chat with ${chat.name}?`,
    body: 'All messages in this chat will be deleted. Memory notes are kept.',
    confirm: 'Clear',
    danger: true,
  });
  if (!ok) return;
  await api(`/api/chats/${chat.id}/clear`, { method: 'POST' });
  if (state.currentId === chat.id) {
    state.msgs = [];
    state.hasMore = false;
    renderMessages();
  }
  loadChats();
}

async function deleteContact(contactId) {
  const contact = state.contacts.find((c) => c.id === contactId);
  if (!contact) return;
  const ok = await confirmDialog({
    title: `Delete ${contact.name}?`,
    body: 'This removes the contact and your whole chat with them. Their messages in group chats stay.',
    confirm: 'Delete',
    danger: true,
  });
  if (!ok) return false;
  try {
    await api(`/api/contacts/${contactId}`, { method: 'DELETE' });
  } catch (err) {
    toast(err.message, { type: 'error' });
    return false;
  }
  if (currentChat()?.contact_id === contactId) closeChat();
  await Promise.all([loadContacts(), loadChats()]);
  if (!state.currentId) renderEmptyState();
  return true;
}

async function deleteGroup(chat) {
  const ok = await confirmDialog({ title: `Delete “${chat.name}”?`, body: 'The group and all its messages will be deleted.', confirm: 'Delete', danger: true });
  if (!ok) return false;
  await api(`/api/chats/${chat.id}`, { method: 'DELETE' });
  if (state.currentId === chat.id) closeChat();
  await loadChats();
  return true;
}

// ================= Contact editor =================

const contactModal = $('#contact-modal');
bindModal(contactModal);

function setSegmented(el, value) {
  for (const b of $$('button', el)) b.classList.toggle('active', b.dataset.value === value);
}

function bindSegmented(el, onChange) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    setSegmented(el, b.dataset.value);
    onChange(b.dataset.value);
  });
}

function bindTabs(tabsEl, root) {
  tabsEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) showTab(tabsEl, root, t.dataset.tab);
  });
}

function showTab(tabsEl, root, name) {
  for (const t of $$('[data-tab]', tabsEl)) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of $$('[data-panel]', root)) p.hidden = p.dataset.panel !== name;
}

function fillModelSelect(select, selected, { allowEmpty = false } = {}) {
  select.replaceChildren();
  if (allowEmpty) select.append(h('option', { value: '' }, 'First available'));
  if (!state.models.length && !allowEmpty) select.append(h('option', { value: '' }, 'No models found. Is Ollama running?'));
  const names = state.models.map((m) => m.name);
  if (selected && !names.includes(selected)) select.append(h('option', { value: selected }, `${selected} (not installed)`));
  for (const m of state.models) select.append(h('option', { value: m.name }, [m.name, m.params, m.vision ? 'sees images' : ''].filter(Boolean).join('  ·  ')));
  if (selected) select.value = selected;
}

function renderSwatches(el, current, onPick, { allowDefault = false } = {}) {
  el.replaceChildren();
  if (allowDefault) {
    el.append(h('button', { class: `swatch swatch-default${!current ? ' active' : ''}`, title: 'Theme default', onclick: () => onPick('') }, 'Aa'));
  }
  for (const c of PALETTE) {
    el.append(h('button', { class: `swatch${current === c ? ' active' : ''}`, style: { background: c }, title: c, onclick: () => onPick(c) }));
  }
  const custom = h('input', { type: 'color', class: 'swatch-custom', title: 'Custom color', value: current && !PALETTE.includes(current) ? current : '#888888' });
  custom.addEventListener('change', () => onPick(custom.value));
  const wrap = h('label', { class: `swatch swatch-picker${current && !PALETTE.includes(current) ? ' active' : ''}`, title: 'Custom color', style: current && !PALETTE.includes(current) ? { background: current } : {} }, icon('palette', 15), custom);
  el.append(wrap);
}

const cf = {
  title: $('#contact-title'),
  templates: $('#contact-templates'),
  drop: $('#card-drop'),
  form: $('#contact-form'),
  avatar: $('#contact-avatar'),
  name: $('#contact-name'),
  about: $('#contact-about'),
  model: $('#contact-model'),
  style: $('#contact-style'),
  styleHint: $('#contact-style-hint'),
  length: $('#contact-length'),
  persona: $('#contact-persona'),
  first: $('#contact-first'),
  firstWrap: $('#first-message-wrap'),
  colors: $('#contact-colors'),
  status: $('#contact-status'),
  temp: $('#contact-temp'),
  tempVal: $('#contact-temp-val'),
  memory: $('#contact-memory'),
  error: $('#contact-error'),
  del: $('#contact-delete'),
  save: $('#contact-save'),
  avatarClear: $('#contact-avatar-clear'),
};

bindTabs($('#contact-tabs'), cf.form);
bindSegmented(cf.style, (v) => {
  state.editing.style = v;
  cf.styleHint.textContent = STYLE_HINTS[v];
});
bindSegmented(cf.length, (v) => (state.editing.length = v));
bindSegmented($('#contact-initiative'), (v) => (state.editing.initiative = v));
cf.temp.addEventListener('input', () => (cf.tempVal.textContent = Number(cf.temp.value).toFixed(2)));
cf.name.addEventListener('input', refreshContactAvatar);

function refreshContactAvatar() {
  const e = state.editing;
  fillAvatar(cf.avatar, { name: cf.name.value || '?', avatar_url: e.avatar_url, color: e.color || PALETTE[0] });
  cf.avatarClear.hidden = !e.avatar_url;
  renderAvatarPresets($('#contact-presets'), e.avatar_url, (url) => {
    e.avatar_url = url;
    refreshContactAvatar();
  });
}
cf.avatar.addEventListener('click', () => $('#contact-avatar-file').click());

function renderContactColors() {
  renderSwatches(cf.colors, state.editing.color, (c) => {
    state.editing.color = c;
    renderContactColors();
    refreshContactAvatar();
  });
}

async function openContactModal({ contact = null, importMode = false } = {}) {
  await loadModels();
  const isNew = !contact;
  state.editing = {
    id: contact?.id ?? null,
    avatar_url: contact?.avatar_url || '',
    color: contact?.color || (isNew ? PALETTE[Math.floor(Math.random() * PALETTE.length)] : colorFor(contact)),
    style: contact?.style || 'texting',
    length: contact?.length || 'short',
    initiative: contact?.initiative || 'sometimes',
  };
  cf.title.textContent = isNew ? (importMode ? 'Import character card' : 'New contact') : `Edit ${contact.name}`;
  cf.name.value = contact?.name || '';
  cf.about.value = contact?.about || '';
  cf.status.value = contact?.status || '';
  cf.persona.value = contact?.persona_prompt || '';
  cf.first.value = '';
  cf.memory.value = contact?.memory || '';
  cf.temp.value = contact?.temperature ?? 0.8;
  cf.tempVal.textContent = Number(cf.temp.value).toFixed(2);
  fillModelSelect(cf.model, contact?.model || defaultModel());
  setSegmented(cf.style, state.editing.style);
  cf.styleHint.textContent = STYLE_HINTS[state.editing.style];
  setSegmented(cf.length, state.editing.length);
  setSegmented($('#contact-initiative'), state.editing.initiative);
  if (contact) renderFacts($('#contact-facts'), `/api/contacts/${contact.id}/memories`);
  else $('#contact-facts').replaceChildren(h('div', { class: 'hint' }, 'Available after you create them.'));
  cf.firstWrap.hidden = !isNew;
  cf.del.hidden = isNew;
  cf.save.textContent = isNew ? 'Create' : 'Save';
  cf.error.hidden = true;
  showTab($('#contact-tabs'), cf.form, 'persona');
  renderContactColors();
  refreshContactAvatar();

  cf.templates.hidden = !isNew || importMode;
  if (isNew && !importMode) renderTemplateStrip();
  cf.drop.hidden = !importMode;
  cf.form.hidden = importMode;
  $('#card-drop-text').textContent = 'Drop a character card PNG, or click to browse';

  openModal(contactModal);
  if (!importMode) setTimeout(() => cf.name.focus(), 50);
}

function renderTemplateStrip() {
  cf.templates.replaceChildren(
    h('div', { class: 'section-label' }, 'Start from a template'),
    h(
      'div',
      { class: 'template-chips' },
      PERSONA_TEMPLATES.map((t) =>
        h(
          'button',
          {
            class: 'template-chip',
            onclick: () => {
              cf.name.value = t.name;
              cf.about.value = t.about;
              cf.status.value = t.status || '';
              cf.persona.value = t.persona;
              cf.first.value = t.first_message || '';
              state.editing.color = t.color;
              if (t.avatar) state.editing.avatar_url = t.avatar;
              state.editing.style = t.style || 'texting';
              state.editing.length = t.length || 'short';
              setSegmented(cf.style, state.editing.style);
              cf.styleHint.textContent = STYLE_HINTS[state.editing.style];
              setSegmented(cf.length, state.editing.length);
              renderContactColors();
              refreshContactAvatar();
            },
          },
          h('span', { class: 'dot', style: { background: t.color } }),
          t.label
        )
      )
    )
  );
}

$('#contact-avatar-btn').addEventListener('click', () => $('#contact-avatar-file').click());
$('#contact-avatar-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    state.editing.avatar_url = (await uploadImage('avatar', f)).url;
    refreshContactAvatar();
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
});
cf.avatarClear.addEventListener('click', () => {
  state.editing.avatar_url = '';
  refreshContactAvatar();
});

// character card import
cf.drop.addEventListener('click', () => $('#card-file').click());
cf.drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  cf.drop.classList.add('drag-over');
});
cf.drop.addEventListener('dragleave', () => cf.drop.classList.remove('drag-over'));
cf.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  cf.drop.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) importCard(e.dataTransfer.files[0]);
});
$('#card-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importCard(f);
});

async function importCard(file) {
  $('#card-drop-text').textContent = 'Reading card…';
  const form = new FormData();
  form.append('card', file);
  try {
    const data = await (await api('/api/cards/parse', { method: 'POST', form })).json();
    cf.name.value = data.name || '';
    cf.persona.value = data.persona_prompt || '';
    cf.first.value = data.first_message || '';
    state.editing.avatar_url = data.avatar_url || '';
    state.editing.style = /\*[^*\n]+\*/.test(data.first_message || '') ? 'roleplay' : 'texting';
    setSegmented(cf.style, state.editing.style);
    cf.styleHint.textContent = STYLE_HINTS[state.editing.style];
    refreshContactAvatar();
    cf.drop.hidden = true;
    cf.form.hidden = false;
    cf.title.textContent = `Import ${data.name}`;
    cf.name.focus();
  } catch (err) {
    $('#card-drop-text').textContent = 'Drop a character card PNG, or click to browse';
    toast(err.message, { type: 'error' });
  }
}

cf.del.addEventListener('click', async () => {
  if (await deleteContact(state.editing.id)) closeModal(contactModal);
});

cf.save.addEventListener('click', async () => {
  const e = state.editing;
  const showError = (msg) => {
    cf.error.textContent = msg;
    cf.error.hidden = false;
  };
  const name = cf.name.value.trim();
  if (!name) return showError('Give them a name');
  if (!cf.model.value) return showError('Pick a model (is Ollama running?)');
  const payload = {
    name,
    model: cf.model.value,
    about: cf.about.value.trim(),
    status: cf.status.value.trim(),
    avatar_url: e.avatar_url,
    color: e.color,
    style: e.style,
    length: e.length,
    temperature: Number(cf.temp.value),
    persona_prompt: cf.persona.value.trim(),
    memory: cf.memory.value.trim(),
    initiative: e.initiative,
  };
  cf.save.disabled = true;
  try {
    if (e.id == null) {
      payload.first_message = cf.first.value.trim();
      const contact = await sendJSON('/api/contacts', 'POST', payload);
      closeModal(contactModal);
      await Promise.all([loadContacts(), loadChats()]);
      openChat(contact.dm_chat_id);
    } else {
      await sendJSON(`/api/contacts/${e.id}`, 'PUT', payload);
      closeModal(contactModal);
      await Promise.all([loadContacts(), loadChats()]);
      if (state.currentId) renderMessages();
    }
  } catch (err) {
    showError(err.message);
  } finally {
    cf.save.disabled = false;
  }
});

// ================= Group editor =================

const groupModal = $('#group-modal');
bindModal(groupModal);

const gf = {
  title: $('#group-title'),
  avatar: $('#group-avatar'),
  name: $('#group-name'),
  description: $('#group-description'),
  members: $('#group-members'),
  count: $('#group-count'),
  instructions: $('#group-instructions'),
  memory: $('#group-memory'),
  memoryWrap: $('#group-memory-wrap'),
  error: $('#group-error'),
  del: $('#group-delete'),
  save: $('#group-save'),
};

function refreshGroupAvatar() {
  const g = state.editingGroup;
  fillAvatar(gf.avatar, { name: gf.name.value, avatar_url: g.avatar_url, id: g.id || 7 }, { group: true });
  renderAvatarPresets($('#group-presets'), g.avatar_url, (url) => {
    g.avatar_url = url;
    refreshGroupAvatar();
  });
}
gf.avatar.addEventListener('click', () => $('#group-avatar-file').click());
gf.name.addEventListener('input', refreshGroupAvatar);

function renderMemberPicker() {
  const g = state.editingGroup;
  gf.members.replaceChildren();
  if (!state.contacts.length) {
    gf.members.append(h('div', { class: 'list-empty' }, 'No contacts yet. Create a few first.'));
  }
  for (const c of state.contacts) {
    const on = g.members.has(c.id);
    gf.members.append(
      h(
        'button',
        {
          class: `member-option${on ? ' on' : ''}`,
          onclick: () => {
            on ? g.members.delete(c.id) : g.members.add(c.id);
            renderMemberPicker();
          },
        },
        avatar(c),
        h('div', { class: 'member-option-text' }, h('div', {}, c.name), h('small', {}, c.model)),
        h('span', { class: 'check' }, on ? icon('check', 14) : null)
      )
    );
  }
  gf.count.textContent = g.members.size ? `· ${g.members.size} selected` : '';
}

async function openGroupModal(chat = null) {
  await loadContacts();
  if (!chat && !state.contacts.length) {
    toast('Add a contact or two first, then make a group');
    return openContactModal();
  }
  state.editingGroup = {
    id: chat?.id ?? null,
    avatar_url: chat?.avatar_url || '',
    members: new Set(chat ? chat.members.map((m) => m.id) : []),
  };
  gf.title.textContent = chat ? `Edit ${chat.name}` : 'New group';
  gf.name.value = chat?.name || '';
  gf.description.value = chat?.description || '';
  gf.instructions.value = chat?.instructions || '';
  gf.memory.value = chat?.memory || '';
  if (chat) renderFacts($('#group-facts'), `/api/chats/${chat.id}/memories`);
  gf.memoryWrap.hidden = !chat;
  gf.del.hidden = !chat;
  gf.save.textContent = chat ? 'Save' : 'Create group';
  gf.error.hidden = true;
  refreshGroupAvatar();
  renderMemberPicker();
  openModal(groupModal);
  setTimeout(() => gf.name.focus(), 50);
}

$('#group-avatar-btn').addEventListener('click', () => $('#group-avatar-file').click());
$('#group-avatar-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    state.editingGroup.avatar_url = (await uploadImage('avatar', f)).url;
    refreshGroupAvatar();
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
});

gf.del.addEventListener('click', async () => {
  const chat = chatById(state.editingGroup.id);
  if (chat && (await deleteGroup(chat))) closeModal(groupModal);
});

gf.save.addEventListener('click', async () => {
  const g = state.editingGroup;
  const showError = (msg) => {
    gf.error.textContent = msg;
    gf.error.hidden = false;
  };
  const name = gf.name.value.trim();
  if (!name) return showError('Give the group a name');
  if (!g.members.size) return showError('Pick at least one member');
  const payload = {
    name,
    description: gf.description.value.trim(),
    instructions: gf.instructions.value.trim(),
    avatar_url: g.avatar_url,
    member_ids: [...g.members],
  };
  if (g.id) payload.memory = gf.memory.value.trim();
  gf.save.disabled = true;
  try {
    const chat = g.id ? await sendJSON(`/api/chats/${g.id}`, 'PUT', payload) : await sendJSON('/api/chats', 'POST', payload);
    closeModal(groupModal);
    await loadChats();
    openChat(chat.id);
  } catch (err) {
    showError(err.message);
  } finally {
    gf.save.disabled = false;
  }
});

// ================= Settings =================

const settingsModal = $('#settings-modal');
bindModal(settingsModal);

function renderSettings() {
  const s = state.settings;
  for (const el of $$('[data-setting]', settingsModal)) el.value = s[el.dataset.setting] ?? '';
  for (const el of $$('[data-setting-seg]', settingsModal)) setSegmented(el, s[el.dataset.settingSeg]);
  for (const el of $$('[data-setting-toggle]', settingsModal)) el.checked = s[el.dataset.settingToggle] !== '0';

  fillAvatar($('#set-user-avatar'), { name: userName(), avatar_url: s.user_avatar_url, color: s.accent_color || '#5aa0e8' });
  $('#set-user-avatar-clear').hidden = !s.user_avatar_url;
  renderAvatarPresets($('#user-presets'), s.user_avatar_url, (url) => patchSettings({ user_avatar_url: url }).then(renderSettings));

  const grid = $('#theme-grid');
  grid.replaceChildren(
    ...THEMES.map((t) =>
      h(
        'button',
        { class: `theme-tile${(s.theme || 'default') === t.key ? ' selected' : ''}`, onclick: () => patchSettings({ theme: t.key }).then(renderSettings) },
        h(
          'div',
          { class: 'theme-preview', style: { background: t.bg } },
          h('div', { class: 'tp-bubble in', style: { background: t.block } }),
          h('div', { class: 'tp-bubble out', style: { background: t.bar } }),
          h('div', { class: 'tp-bubble in short', style: { background: t.block } })
        ),
        h('div', { class: 'theme-name' }, t.label)
      )
    )
  );

  renderSwatches($('#accent-swatches'), s.accent_color, (c) => patchSettings({ accent_color: c }).then(renderSettings), { allowDefault: true });

  $('#set-font-size').value = s.font_size || 14;
  $('#font-size-val').textContent = `${s.font_size || 14}px`;
  $('#set-wallpaper-dim').value = s.wallpaper_dim || 0;
  $('#dim-val').textContent = `${s.wallpaper_dim || 0}%`;
  $('#set-wallpaper-blur').value = s.wallpaper_blur || 0;
  $('#blur-val').textContent = `${s.wallpaper_blur || 0}px`;
  const wp = $('#wallpaper-preview');
  wp.style.backgroundImage = s.wallpaper_url ? `url("${s.wallpaper_url}")` : '';
  wp.classList.toggle('empty', !s.wallpaper_url);
  $('#wallpaper-clear').hidden = !s.wallpaper_url;

  $('#set-ollama-url').value = s.ollama_url || '';
  $('#searxng-wrap').hidden = s.search_provider !== 'searxng';
  refreshEmbedStatus();
  fillModelSelect($('#set-default-model'), s.default_model, { allowEmpty: true });
}

async function openSettings(tab = 'profile') {
  loadModels().then(() => fillModelSelect($('#set-default-model'), state.settings.default_model, { allowEmpty: true }));
  renderSettings();
  showTab($('.settings-nav'), $('.settings-body'), tab);
  openModal(settingsModal);
}

$('#settings-btn').addEventListener('click', () => openSettings());
$('#profile-btn').addEventListener('click', () => openSettings('profile'));
$('.settings-nav').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (t) showTab($('.settings-nav'), $('.settings-body'), t.dataset.tab);
});

for (const el of $$('[data-setting]', settingsModal)) {
  el.addEventListener('change', () => patchSettings({ [el.dataset.setting]: el.value.trim() }));
}
for (const el of $$('[data-setting-seg]', settingsModal)) {
  bindSegmented(el, (v) => patchSettings({ [el.dataset.settingSeg]: v }));
}
for (const el of $$('[data-setting-toggle]', settingsModal)) {
  el.addEventListener('change', () => {
    patchSettings({ [el.dataset.settingToggle]: el.checked ? '1' : '0' });
    if (state.currentId) renderMessages();
  });
}

$('#set-font-size').addEventListener('input', (e) => {
  state.settings.font_size = e.target.value;
  $('#font-size-val').textContent = `${e.target.value}px`;
  applyTheme();
});
$('#set-font-size').addEventListener('change', (e) => patchSettings({ font_size: e.target.value }));
$('#set-wallpaper-dim').addEventListener('input', (e) => {
  state.settings.wallpaper_dim = e.target.value;
  $('#dim-val').textContent = `${e.target.value}%`;
  applyTheme();
});
$('#set-wallpaper-dim').addEventListener('change', (e) => patchSettings({ wallpaper_dim: e.target.value }));
$('#set-wallpaper-blur').addEventListener('input', (e) => {
  state.settings.wallpaper_blur = e.target.value;
  $('#blur-val').textContent = `${e.target.value}px`;
  applyTheme();
});
$('#set-wallpaper-blur').addEventListener('change', (e) => patchSettings({ wallpaper_blur: e.target.value }));

$('#wallpaper-upload').addEventListener('click', () => $('#wallpaper-file').click());
$('#wallpaper-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const { url } = await uploadImage('wallpaper', f);
    await patchSettings({ wallpaper_url: url });
    renderSettings();
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
});
$('#wallpaper-clear').addEventListener('click', () => patchSettings({ wallpaper_url: '' }).then(renderSettings));

$('#set-default-model').addEventListener('change', (e) => patchSettings({ default_model: e.target.value }));

$('#set-user-avatar-btn').addEventListener('click', () => $('#set-user-avatar-file').click());
$('#set-user-avatar-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const { url } = await uploadImage('avatar', f);
    await patchSettings({ user_avatar_url: url });
    renderSettings();
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
});
$('#set-user-avatar-clear').addEventListener('click', () => patchSettings({ user_avatar_url: '' }).then(renderSettings));

$('#ollama-test').addEventListener('click', async () => {
  const url = $('#set-ollama-url').value.trim();
  if (!url) return;
  const result = $('#ollama-test-result');
  result.textContent = 'Testing…';
  result.className = 'hint';
  await patchSettings({ ollama_url: url });
  const models = await loadModels();
  if (state.ollamaOk) {
    result.textContent = `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`;
    result.className = 'hint ok-text';
  } else {
    result.textContent = `Couldn't connect to ${url}.`;
    result.className = 'hint error-text';
  }
  fillModelSelect($('#set-default-model'), state.settings.default_model, { allowEmpty: true });
});

// ================= Memory (summaries) =================

let inactivityTimer = null;

function summarize(chatId, beacon = false) {
  if (!chatId) return;
  const url = `/api/chats/${chatId}/summarize`;
  if (beacon && navigator.sendBeacon) navigator.sendBeacon(url, new Blob(['{}'], { type: 'application/json' }));
  else fetch(url, { method: 'POST' }).catch(() => {});
}

function resetInactivity() {
  clearTimeout(inactivityTimer);
  const chatId = state.currentId;
  if (!chatId) return;
  inactivityTimer = setTimeout(() => state.currentId === chatId && summarize(chatId), INACTIVITY_MS);
}

window.addEventListener('beforeunload', () => {
  saveDraft();
  storage.set('drafts', state.drafts);
  if (state.currentId) summarize(state.currentId, true);
});

// ================= Keyboard & misc =================

const lightbox = $('#lightbox');
bindModal(lightbox);
lightbox.addEventListener('click', () => closeModal(lightbox));

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (MOBILE() && state.currentId) closeChat();
    $('#chat-search').focus();
    $('#chat-search').select();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && state.currentId && !topModal()) {
    e.preventDefault();
    openSearch();
    return;
  }
  if (e.key !== 'Escape') return;
  if (popoverEl) return closePopover();
  if ($('.menu')) return closeMenu();
  const modal = topModal();
  if (modal) return closeModal(modal);
  if (!$('#search-bar').hidden) return closeSearch();
  if (state.replyTo) {
    state.replyTo = null;
    return renderReplyBar();
  }
  if (document.activeElement === $('#chat-search')) {
    $('#chat-search').value = '';
    state.filter = '';
    renderChatList();
    $('#chat-search').blur();
  }
});

// keep relative times fresh
setInterval(renderChatList, 60 * 1000);

// ================= Long-term memory (facts) =================

async function renderFacts(el, url) {
  el.replaceChildren(h('div', { class: 'hint' }, 'Loading…'));
  let facts = [];
  try {
    facts = await getJSON(url);
  } catch (err) {
    el.replaceChildren(h('div', { class: 'form-error' }, err.message));
    return;
  }
  const input = h('input', { class: 'input', placeholder: 'Add something they should remember', maxlength: 400 });
  const add = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    try {
      await sendJSON(url, 'POST', { text });
      renderFacts(el, url);
    } catch (err) {
      toast(err.message, { type: 'error' });
      input.disabled = false;
    }
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), add()));
  el.replaceChildren(
    ...facts.map((f) =>
      h(
        'div',
        { class: 'fact' },
        h('span', {}, f.text),
        f.source === 'manual' ? h('small', {}, 'added by you') : null,
        h(
          'button',
          {
            class: 'icon-btn sm',
            title: 'Forget this',
            onclick: async () => {
              await api(`/api/memories/${f.id}`, { method: 'DELETE' });
              renderFacts(el, url);
            },
          },
          icon('x', 15)
        )
      )
    ),
    h('div', { class: 'fact-add' }, input, h('button', { class: 'btn', onclick: add }, 'Add'))
  );
}

// ================= Reminders =================

const remindersModal = $('#reminders-modal');
bindModal(remindersModal);
let remindersChat = null;

async function openReminders(chat) {
  remindersChat = chat;
  $('#reminder-text').value = '';
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  soon.setMinutes(0, 0, 0);
  $('#reminder-when').value = toLocalInput(soon);
  await renderReminders();
  openModal(remindersModal);
}

const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

async function renderReminders() {
  const list = $('#reminder-list');
  const items = await getJSON(`/api/reminders?chat_id=${remindersChat.id}`);
  list.replaceChildren(
    ...items.map((r) =>
      h(
        'div',
        { class: 'reminder-item' },
        icon('bellRing', 16),
        h('span', { class: 'reminder-text' }, r.text),
        h('span', { class: 'reminder-when' }, formatWhen(r.due_at)),
        h(
          'button',
          {
            class: 'icon-btn sm',
            title: 'Cancel reminder',
            onclick: async () => {
              await api(`/api/reminders/${r.id}`, { method: 'DELETE' });
              renderReminders();
            },
          },
          icon('x', 15)
        )
      )
    )
  );
}

$('#reminder-add').addEventListener('click', async () => {
  const text = $('#reminder-text').value.trim();
  const when = $('#reminder-when').value;
  if (!text || !when) return toast('Add what and when');
  try {
    await sendJSON('/api/reminders', 'POST', { chat_id: remindersChat.id, text, due_at: new Date(when).toISOString() });
    $('#reminder-text').value = '';
    renderReminders();
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
});

// ================= Settings extras =================

async function refreshEmbedStatus() {
  const el = $('#embed-status');
  try {
    const s = await getJSON('/api/status');
    if (!s.embed_model) el.textContent = 'Off. Contacts fall back to simple keyword matching.';
    else if (s.embed_ok) el.textContent = `${s.embed_model} is installed. Contacts recall relevant memories by meaning.`;
    else el.innerHTML = `${escape(s.embed_model)} isn't installed. Run <code>ollama pull ${escape(s.embed_model)}</code> (until then, keyword matching is used).`;
  } catch {
    el.textContent = '';
  }
}
const escape = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

$('#set-search-provider').addEventListener('change', (e) => ($('#searxng-wrap').hidden = e.target.value !== 'searxng'));
$('#set-embed').addEventListener('change', () => setTimeout(refreshEmbedStatus, 300));

$('#set-notifications').addEventListener('change', async (e) => {
  if (!e.target.checked || tauri() || !('Notification' in window)) return;
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') toast('Notifications are blocked in your browser settings for this page');
  } else if (Notification.permission === 'denied') {
    toast('Notifications are blocked in your browser settings for this page');
  }
});

// ================= Desktop app (Tauri) =================

// In the desktop window, open outside links and downloads in the normal browser.
document.addEventListener('click', (e) => {
  const opener = tauri()?.opener;
  const a = e.target.closest('a[href]');
  if (!opener || !a) return;
  const url = new URL(a.getAttribute('href'), location.href);
  const external = url.origin !== location.origin;
  if (external || a.target === '_blank' || a.hasAttribute('download')) {
    e.preventDefault();
    opener.openUrl(url.href).catch((err) => toast(`Couldn't open link: ${err}`, { type: 'error' }));
  }
});

// ================= Init =================

(async function init() {
  hydrateIcons();
  await loadSettings();
  renderMe();
  await Promise.all([loadContacts().catch(() => {}), loadChats(), loadModels(), loadAvatarPresets()]);
  renderEmptyState();
  setInterval(checkStatus, 30 * 1000);
  connectEvents();

  const last = storage.get('lastChat');
  if (last && chatById(last) && !MOBILE()) openChat(last);
})();
