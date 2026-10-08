// Small shared helpers: DOM, icons, avatars, formatting, toasts, dialogs, menus.

export const PALETTE = ['#e57373', '#f06292', '#ba68c8', '#9575cd', '#64b5f6', '#4db6ac', '#81c784', '#ffb74d', '#ff8a65', '#a1887f'];

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------- Icons ----------

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  compose: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.35-4.35',
  settings:
    'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  send: { d: 'M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.99.99 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z', fill: true },
  stop: { d: 'M7 7h10v10H7z', fill: true },
  clip: 'M21.4 11.1l-9.2 9.2a6 6 0 01-8.5-8.5l9.2-9.2a4 4 0 015.7 5.7l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5',
  smile: 'M12 22a10 10 0 100-20 10 10 0 000 20zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
  more: 'M12 5h.01M12 12h.01M12 19h.01',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  reply: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  pencil: 'M17 3a2.8 2.8 0 014 4L7.5 20.5 2 22l1.5-5.5z',
  refresh: 'M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5',
  x: 'M18 6L6 18M6 6l12 12',
  back: 'M19 12H5M12 19l-7-7 7-7',
  down: 'M6 9l6 6 6-6',
  up: 'M18 15l-6-6-6 6',
  pin: 'M12 17v5M9 10.8V4h6v6.8l3 3.2v2H6v-2z',
  mute: 'M11 5L6 9H2v6h4l5 4zM23 9l-6 6M17 9l6 6',
  bell: 'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0',
  users: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  userPlus: 'M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M8.5 11a4 4 0 100-8 4 4 0 000 8zM20 8v6M23 11h-6',
  user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM21 15l-5-5L5 21',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z',
  camera: { d: 'M9 3L7.2 5H4a2 2 0 00-2 2v11a2 2 0 002 2h16a2 2 0 002-2V7a2 2 0 00-2-2h-3.2L15 3zm3 15a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z', fill: true },
  check: 'M20 6L9 17l-5-5',
  checks: 'M17 6L6.5 16.5 2 12M22 7l-9.5 9.5-1.5-1.5',
  file: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6',
  card: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M12 18v-6M9 15l3-3 3 3',
  brain: 'M9.5 2A2.5 2.5 0 007 4.5v.5a3 3 0 00-2.8 4.3A3 3 0 005 15a3 3 0 003 3h.5V2zM14.5 2A2.5 2.5 0 0117 4.5v.5a3 3 0 012.8 4.3A3 3 0 0119 15a3 3 0 01-3 3h-.5V2zM12 2v20',
  palette: 'M12 22a10 10 0 110-20c5.5 0 10 4 10 9a5 5 0 01-5 5h-2a2 2 0 00-1 3.7A1.5 1.5 0 0112 22zM7.5 11.5h.01M10.5 7.5h.01M15.5 7.5h.01M18 11.5h.01',
  chat: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
  globe: 'M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2a15 15 0 014 10 15 15 0 01-4 10 15 15 0 01-4-10 15 15 0 014-10z',
  bellRing: 'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0M2 8c0-2 .8-3.9 2-5.3M22 8c0-2-.8-3.9-2-5.3',
  cpu: 'M4 4h16v16H4zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3',
  database: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
};

export function icon(name, size = 20) {
  const def = ICONS[name] || ICONS.dots;
  const { d, fill } = typeof def === 'string' ? { d: def, fill: false } : def;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ic');
  if (fill) svg.setAttribute('fill', 'currentColor');
  else {
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', name === 'more' || name === 'dots' ? '3' : '1.9');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

export function hydrateIcons(root = document) {
  for (const el of $$('[data-icon]', root)) {
    el.replaceWith(icon(el.dataset.icon, Number(el.dataset.size) || 20));
  }
}

// ---------- Avatars ----------

export const colorFor = (entity) =>
  entity?.color || PALETTE[Math.abs(Number(entity?.id) || hashCode(entity?.name || '')) % PALETTE.length];

function hashCode(s) {
  let x = 0;
  for (const ch of s) x = (x * 31 + ch.codePointAt(0)) | 0;
  return x;
}

export function initials(name) {
  const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
  const chars = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return chars.map((p) => [...p][0]).join('').toUpperCase() || '?';
}

export function fillAvatar(el, entity, { group = false } = {}) {
  el.innerHTML = '';
  el.classList.add('avatar');
  if (entity?.avatar_url) {
    el.style.background = 'transparent';
    el.append(h('img', { src: entity.avatar_url, alt: '', loading: 'lazy', draggable: 'false' }));
  } else {
    const c = colorFor(entity);
    el.style.background = `linear-gradient(140deg, ${c}, color-mix(in srgb, ${c} 70%, #000))`;
    if (group && !entity?.name) el.append(icon('users', 18));
    else el.textContent = initials(entity?.name);
  }
  return el;
}

export const avatar = (entity, opts) => fillAvatar(h('div', { class: 'avatar' }), entity, opts);

// ---------- Text ----------

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Small, safe markdown subset: code, bold, italics (incl. *actions*), strike, links.
export function renderMarkdown(text) {
  const blocks = [];
  let s = escapeHtml(text).replace(/```(?:[\w-]+)?\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u;
export const isEmojiOnly = (text) => !!text && EMOJI_ONLY.test(text.trim());

export const snippet = (s, n = 80) => {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// ---------- Time ----------

export const toDate = (iso) => new Date(iso && !/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso.replace(' ', 'T') + 'Z' : iso);

const sameDay = (a, b) => a.toDateString() === b.toDateString();

export function timeOf(iso) {
  return toDate(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function listTime(iso) {
  if (!iso) return '';
  const d = toDate(iso);
  const now = new Date();
  if (sameDay(d, now)) return timeOf(iso);
  const days = (now - d) / 864e5;
  if (days < 6) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function dayLabel(iso) {
  const d = toDate(iso);
  const now = new Date();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, yest)) return 'Yesterday';
  const opts = { weekday: 'long', month: 'long', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

export const dayKey = (iso) => toDate(iso).toDateString();

// ---------- Toasts ----------

export function toast(message, { type = 'info', timeout = 4000 } = {}) {
  let host = $('#toasts');
  if (!host) document.body.append((host = h('div', { id: 'toasts' })));
  const el = h('div', { class: `toast toast-${type}` }, message);
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, timeout);
}

// ---------- Modals ----------

const modalStack = [];

export function openModal(el) {
  el.hidden = false;
  el.classList.remove('closing');
  if (!modalStack.includes(el)) modalStack.push(el);
  requestAnimationFrame(() => el.classList.add('open'));
}

export function closeModal(el) {
  if (!el || el.hidden) return;
  el.classList.remove('open');
  const i = modalStack.indexOf(el);
  if (i >= 0) modalStack.splice(i, 1);
  setTimeout(() => {
    if (!el.classList.contains('open')) el.hidden = true;
  }, 160);
  el.dispatchEvent(new Event('modalclose'));
}

export const topModal = () => modalStack[modalStack.length - 1];

export function bindModal(el) {
  el.addEventListener('mousedown', (e) => {
    if (e.target === el) closeModal(el);
  });
  for (const btn of $$('[data-close]', el)) btn.addEventListener('click', () => closeModal(el));
}

export function confirmDialog({ title, body = '', confirm = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'overlay', hidden: true });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeModal(overlay);
      setTimeout(() => overlay.remove(), 200);
      resolve(v);
    };
    const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => finish(true) }, confirm);
    overlay.append(
      h(
        'div',
        { class: 'modal modal-sm' },
        h('h2', { class: 'modal-title' }, title),
        body ? h('p', { class: 'modal-text' }, body) : null,
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'), ok)
      )
    );
    overlay.addEventListener('mousedown', (e) => e.target === overlay && finish(false));
    overlay.addEventListener('modalclose', () => finish(false));
    document.body.append(overlay);
    openModal(overlay);
    ok.focus();
  });
}

// ---------- Popover menus ----------

let openMenuEl = null;

export function closeMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}

// items: [{ label, icon, onClick, danger, hidden }] or 'sep'
export function showMenu(anchor, items, { align = 'right' } = {}) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (!item || item.hidden) continue;
    if (item === 'sep') {
      menu.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    menu.append(
      h(
        'button',
        {
          class: 'menu-item' + (item.danger ? ' danger' : ''),
          role: 'menuitem',
          onclick: (e) => {
            e.stopPropagation();
            closeMenu();
            item.onClick?.();
          },
        },
        item.icon ? icon(item.icon, 17) : null,
        h('span', {}, item.label)
      )
    );
  }
  positionPopover(menu, anchor, align);
  openMenuEl = menu;
  return menu;
}

export function positionPopover(el, anchor, align = 'right') {
  el.style.visibility = 'hidden';
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  let left = align === 'right' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + ht > window.innerHeight - 8) top = Math.max(8, r.top - ht - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.visibility = '';
}

document.addEventListener('mousedown', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
});
window.addEventListener('resize', closeMenu);

// ---------- Misc ----------

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const storage = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

let audioCtx;
export function playPop() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1320, t + 0.08);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  } catch {}
}
