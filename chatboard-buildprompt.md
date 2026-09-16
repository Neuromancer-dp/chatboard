# humanchat — build prompt for Claude Code

Build a small local chat app called "humanchat". It should look and feel like a standard desktop messenger (Element/Telegram-style layout) — not a workspace or dashboard, just a chat app. Runs locally on a laptop (landscape/desktop layout, not a mobile-width column), talks to a local Ollama instance at `127.0.0.1:11434`.

## Stack

- Node + Express backend
- SQLite for storage
- Plain HTML/CSS/JS frontend, no framework, no build step
- multer for avatar image uploads

## Layout

Two-pane desktop layout, Element-style:

- **Left sidebar** (~260px wide): list of contacts. Each row shows avatar, name, and a preview of the last message. Click a contact to open their chat in the main panel. A "+" button at the top adds a new contact.
- **Main panel**: takes the rest of the width.
  - Header: contact's avatar + name + "online" status text. **Clicking the header/avatar opens an edit view** for that contact (see below).
  - Message area: standard chat bubbles — contact's messages left-aligned with a rounded rect (sharp bottom-left corner), user's messages right-aligned with a distinct accent-tinted background (sharp bottom-right corner). Include a typing indicator (three animated dots) while waiting for a response.
  - Input row at the bottom: plus icon (reserved for future use, can be inert for v1), text input, send icon.

## Contacts

Each contact is a full "persona" with its own backing model. Schema:

```sql
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  avatar_url TEXT DEFAULT '',       -- uploaded image, or fall back to initials avatar
  model TEXT NOT NULL,              -- e.g. 'humanchat', 'gemma3:4b', 'qwen3:14b' — any tag from `ollama list`
  memory TEXT DEFAULT '',           -- see Memory section below
  created_at TEXT DEFAULT (datetime('now'))
);
```

- If no avatar is uploaded, show a colored circle with the contact's initial (rotate through a small fixed palette based on `id`, same idea as scratchboard's card colors).
- The model dropdown should be populated live from Ollama's `/api/tags` endpoint, so any locally pulled model (or Modelfile-built model like `humanchat`) is selectable.

### Contact edit view

Triggered by clicking the header/avatar in the main panel. A centered card (not a full page navigation) with:
- Avatar preview with a small camera-icon overlay button to trigger file upload → posts to `/api/upload/avatar`
- Name text input
- Model select dropdown (populated from Ollama)
- Save button

Adding a new contact (the "+" in the sidebar) opens the same card, empty, defaulting to no avatar and the first available model.

## Messages & persistence

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  role TEXT NOT NULL,               -- 'user' or 'assistant'
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);
```

- Each contact has one continuous message thread — no sub-conversations or history browsing within a contact.
- On sending a message: append to `messages`, then call Ollama's chat endpoint with the full running conversation for that contact, stream the response back into the UI token-by-token, then persist the assistant's reply to `messages`.
- Context sent to Ollama per message: the contact's `memory` field (see below) prepended as system context, plus the full message history for that contact.

## Memory (per contact, fully automatic)

Each contact has its own `memory` text field — a standing, rotating summary of past conversations with that specific contact, invisible to the user (no manual editing UI in v1).

**End-of-conversation triggers** (auto, no visible action):
1. **Tab/app close** — use `beforeunload` + `navigator.sendBeacon` to fire a summarization request as the page closes.
2. **Inactivity timeout** — if no new message for ~15-20 minutes on that contact's thread, treat it as ended and trigger summarization even if the tab is still open.

**Summarization step**: send that contact's recent conversation to their own backing model with a hidden prompt — *"Summarize what was just discussed in 2-3 short sentences, written as a memory note for yourself to reference later. Don't mention that this is a summary."* — then merge the result into that contact's `memory` field.

**Memory rotation**: cap growth — keep roughly the last 5 summaries per contact, or periodically ask the model to consolidate older summaries into one shorter note, so `memory` doesn't grow unbounded and eventually blow the context window.

Memory is scoped per-contact — humanchat's memory of past chats is completely separate from any other contact's.

## Explicitly out of scope for v1

- No character-card import (PNG/Character Card V2 — that's a separate future project)
- No group chats, no multiple conversations per contact
- No manual memory editing UI
- No theming/wallpaper (that's deskboard's territory) — keep this visually plain, standard messenger colors
- No mobile-responsive layout — desktop/landscape only for now
