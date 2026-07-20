const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 6e6 }); // ~6MB, enough for images

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

let settings = { roomName: 'Chatzy Room', joinPassword: 'letmein' };
let messages = [];        // {id, type, from, text, img, ts}
let knownUsers = {};      // email -> last username (rename detection)
let online = {};          // socket.id -> {username, email, isAdmin, joinedAt}

const sys = (text) => broadcastMsg({ type: 'system', text });
const broadcastMsg = (m) => {
  const msg = { id: Date.now() + Math.random().toString(36).slice(2), ts: Date.now(), ...m };
  messages.push(msg);
  if (messages.length > 300) messages.shift();
  io.emit('message', msg);
  return msg;
};
const userList = () => Object.values(online)
  .map(u => ({ username: u.username, isAdmin: u.isAdmin, joinedAt: u.joinedAt }));
const pushUsers = () => io.emit('userlist', userList());

io.on('connection', (socket) => {
  socket.on('join', ({ username, email, password }, cb) => {
    if (typeof cb !== 'function') return;
    const raw = String(username || '');
    const isAdmin = /   $/.test(raw); // 3+ trailing spaces = admin
    const cleanName = raw.trim().slice(0, 24).replace(/\s+/g, ' ');
    const cleanEmail = String(email || '').trim().toLowerCase().slice(0, 80);

    if (!cleanName) return cb({ error: 'Please enter a username.' });
    if (!cleanEmail || !cleanEmail.includes('@')) return cb({ error: 'Please enter a valid email.' });
    if (String(password || '') !== settings.joinPassword) return cb({ error: 'Wrong room password.' });
    if (Object.values(online).some(u => u.username.toLowerCase() === cleanName.toLowerCase()))
      return cb({ error: 'That username is already online. Pick another.' });

    const prevName = knownUsers[cleanEmail];
    if (prevName && prevName !== cleanName) sys(`${prevName} is now known as ${cleanName}`);
    knownUsers[cleanEmail] = cleanName;

    online[socket.id] = { username: cleanName, email: cleanEmail, isAdmin, joinedAt: Date.now() };
    cb({ ok: true, isAdmin, settings, history: messages, users: userList() });
    sys(`${cleanName} joined the chat`);
    pushUsers();
  });

  socket.on('message', ({ text, img }) => {
    const u = online[socket.id];
    if (!u) return;
    const cleanText = String(text || '').slice(0, 2000).trim();
    if (!cleanText && !img) return;
    if (img && !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(img)) return; // block svg/other
    broadcastMsg({ type: 'msg', from: u.username, text: cleanText, img: img || null });
  });

  socket.on('typing', () => {
    const u = online[socket.id];
    if (u) socket.broadcast.emit('typing', u.username);
  });

  socket.on('admin:deleteMsg', (id) => {
    const u = online[socket.id]; if (!u || !u.isAdmin) return;
    messages = messages.filter(m => m.id !== id);
    io.emit('deleteMsg', id);
  });

  socket.on('admin:clearChat', () => {
    const u = online[socket.id]; if (!u || !u.isAdmin) return;
    messages = [];
    io.emit('clearChat');
    sys(`Chat cleared by ${u.username}`);
  });

  socket.on('admin:kick', (username) => {
    const u = online[socket.id]; if (!u || !u.isAdmin) return;
    for (const [sid, usr] of Object.entries(online)) {
      if (usr.username === username) {
        io.to(sid).emit('kicked');
        io.sockets.sockets.get(sid)?.disconnect(true);
      }
    }
  });

  socket.on('admin:updateSettings', (newSettings) => {
    const u = online[socket.id]; if (!u || !u.isAdmin) return;
    settings = {
      roomName: String(newSettings.roomName || settings.roomName).slice(0, 60),
      joinPassword: String(newSettings.joinPassword || settings.joinPassword).slice(0, 60)
    };
    io.emit('settingsUpdated', settings);
    sys(`Room settings updated by ${u.username}`);
  });

  socket.on('disconnect', () => {
    const u = online[socket.id];
    if (u) { delete online[socket.id]; sys(`${u.username} left the chat`); pushUsers(); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chatzy running on http://localhost:${PORT}`));
