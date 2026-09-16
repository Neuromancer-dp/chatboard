# Chatboard

Local messenger for local models.

Chatboard (the running app still calls itself **humanchat**) is a desktop-style chat UI for [Ollama](https://ollama.com). Each contact is its own persona: its own model, prompt, avatar, thread, and rolling memory. Nothing leaves your machine except traffic to `127.0.0.1:11434`.

Looks like Element / Telegram. Behaves like a phone book of models.

![Chatboard](screenshot.png)

## Features

- Two-pane desktop layout: contact list + thread
- One Ollama model per contact (`ollama list` is the dropdown)
- Streaming replies
- Per-contact system / persona prompt
- Automatic memory: after a thread goes idle (or the tab closes), the contact’s own model writes a short note and keeps the last few summaries
- SillyTavern-style character card import (PNG / Character Card V2–V3)
- Avatar + wallpaper uploads
- SQLite persistence (contacts + messages)
- Theme / dark mode / custom Ollama URL in settings

## Requirements

- Node.js **≥ 22.5**
- [Ollama](https://ollama.com) running locally (default `http://127.0.0.1:11434`)
- At least one pulled model, e.g. `ollama pull gemma3:4b`

## Setup

```bash
git clone https://github.com/Neuromancer-dp/chatboard.git
cd chatboard
npm install
npm start
```

Open [http://127.0.0.1:3210](http://127.0.0.1:3210).

Override the port with `PORT=4000 npm start`.
Point at a different Ollama host in the in-app settings if you need to.

## Use

1. Start Ollama.
2. Hit **+** in the sidebar → name, model, optional avatar.
3. Or drop a character-card PNG; name, persona, first message, and art are filled from the card.
4. Chat. Replies stream. History is stored per contact.
5. Click the header to edit name / model / prompt / avatar.

Memory is automatic. You don’t edit it in v1. Closing the tab fires a summarize via `sendBeacon`; ~15–20 minutes idle on a thread does the same. Older notes get folded so the field doesn’t eat the context window.

## Stack

| Piece     | Choice                                      |
|-----------|---------------------------------------------|
| Server    | Node + Express                              |
| DB        | SQLite (`db.js`)                            |
| Frontend  | Plain HTML/CSS/JS in `public/` — no bundler |
| Uploads   | multer → `public/uploads/`                  |
| Models    | Ollama `/api/tags` + `/api/chat` (streamed) |
| Cards     | `@lenml/char-card-reader`                   |

## API (local)

| Method     | Path                           | Purpose                         |
|------------|--------------------------------|---------------------------------|
| GET/POST   | `/api/contacts`                | list / create                   |
| PUT/DELETE | `/api/contacts/:id`            | edit / delete                   |
| GET/POST   | `/api/contacts/:id/messages`   | history / send (streamed text)  |
| POST       | `/api/contacts/:id/summarize`  | kick memory update              |
| GET        | `/api/models`                  | proxy of Ollama tags            |
| GET/PATCH  | `/api/settings`                | theme, wallpaper, ollama_url    |
| POST       | `/api/upload/avatar`           | image                           |
| POST       | `/api/upload/wallpaper`        | image                           |
| POST       | `/api/cards/parse`             | character card PNG              |

## Not in v1

Group chats, multiple threads per contact, manual memory editor, mobile layout.
