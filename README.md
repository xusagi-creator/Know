# Chatzy

## Run
1. `npm install`
2. `npm start`
3. Open http://localhost:3000

## Files
- `server.js` — the entire backend (Express + Socket.io)
- `index.html` — the entire frontend (UI, styles, and client logic)

## Admin
Type your username with 3 trailing spaces (e.g. "nizhat   ") when joining to become admin.
Trailing spaces are stripped from your display name — nobody sees the trick.

## Notes
- All state (messages, users, settings) lives in server memory — resets on restart.
- Default room password is `letmein`, changeable from the admin ⚙️ Room Settings panel.
