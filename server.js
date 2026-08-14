const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/room/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.json({ exists: false });
  res.json({
    exists: true, name: room.name, hasPassword: !!room.password,
    memberCount: Object.keys(room.online).filter(s => !room.online[s].ghost).length,
    closed: room.closed, createdBy: room.createdBy
  });
});

let rooms = {};
function genId() {
  let id;
  do { id = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms[id]);
  return id;
}
function rPub(r) {
  return { id: r.id, name: r.name, hasPassword: !!r.password,
    createdBy: r.createdBy, createdAt: r.createdAt, closed: r.closed,
    memberCount: Object.keys(r.online).filter(s => !r.online[s].ghost).length };
}
function sys(room, text) {
  const m = { id: Date.now() + Math.random().toString(36).slice(2), ts: Date.now(), type: 'system', text };
  room.messages.push(m); if (room.messages.length > 400) room.messages.shift();
  io.to(room.id).emit('message', m);
}
function uPub(room) { return Object.values(room.online).filter(u => !u.ghost).map(u => ({ username: u.username, isAdmin: u.isAdmin, joinedAt: u.joinedAt })); }
function uAdm(room) { return Object.values(room.online).map(u => ({ username: u.username, email: u.email, isAdmin: u.isAdmin, joinedAt: u.joinedAt, ghost: !!u.ghost })); }
function pushU(room) {
  io.to(room.id).emit('userlist', uPub(room));
  for (const [s, u] of Object.entries(room.online)) if (u.isAdmin) io.to(s).emit('adminUserlist', uAdm(room));
}
function pushL() { io.emit('lobby', Object.values(rooms).map(rPub)); }

io.on('connection', (socket) => {

  socket.on('createRoom', ({ roomName, username, email, password, roomPassword }, cb) => {
    if (typeof cb !== 'function') return;
    const n = String(roomName || '').trim().slice(0, 50).replace(/\s+/g, ' ');
    const u = String(username || '').trim().slice(0, 24).replace(/\s+/g, ' ');
    const e = String(email || '').trim().toLowerCase().slice(0, 80);
    const ap = String(password || '').trim().slice(0, 60);
    const rp = String(roomPassword || '').trim().slice(0, 60) || null;
    if (!n) return cb({ error: 'Please provide a room name.' });
    if (!u) return cb({ error: 'Please enter your display name.' });
    if (!e || !e.includes('@')) return cb({ error: 'Please enter a valid email.' });
    if (!ap) return cb({ error: 'Please set an admin password.' });
    const id = genId();
    const apHash = crypto.createHash('sha256').update(ap).digest('hex');
    rooms[id] = { id, name: n, password: rp, createdBy: u, createdByEmail: e, adminPasswordHash: apHash, createdAt: Date.now(), closed: false, messages: [], online: {} };
    socket.join(id);
    rooms[id].online[socket.id] = { username: u, email: e, isAdmin: true, joinedAt: Date.now(), ghost: false };
    sys(rooms[id], `${u} created the room`); pushU(rooms[id]); pushL();
    cb({ ok: true, roomId: id, isAdmin: true, settings: { roomName: n, joinPassword: rp }, history: rooms[id].messages, users: uPub(rooms[id]), adminUsers: uAdm(rooms[id]) });
  });

  socket.on('joinRoom', ({ roomId, username, email, password }, cb) => {
    if (typeof cb !== 'function') return;
    const room = rooms[roomId];
    if (!room) return cb({ error: 'Room not found.' });
    if (room.closed) return cb({ error: 'This room has been closed.' });
    const u = String(username || '').trim().slice(0, 24).replace(/\s+/g, ' ');
    const e = String(email || '').trim().toLowerCase().slice(0, 80);
    if (!u) return cb({ error: 'Please enter your display name.' });
    if (!e || !e.includes('@')) return cb({ error: 'Please enter a valid email.' });
    if (room.password && String(password || '') !== room.password) return cb({ error: 'Incorrect room password.' });
    if (Object.values(room.online).some(x => x.username.toLowerCase() === u.toLowerCase())) return cb({ error: 'That name is already in use.' });
    socket.join(roomId);
    room.online[socket.id] = { username: u, email: e, isAdmin: false, joinedAt: Date.now(), ghost: false };
    sys(room, `${u} joined`); pushU(room); pushL();
    cb({ ok: true, roomId, isAdmin: false, settings: { roomName: room.name, joinPassword: room.password }, history: room.messages, users: uPub(room), adminUsers: null });
  });

  socket.on('adminRejoin', ({ roomId, username, email, password }, cb) => {
    if (typeof cb !== 'function') return;
    const room = rooms[roomId];
    if (!room) return cb({ error: 'Room not found.' });
    if (room.closed) return cb({ error: 'This room has been closed.' });
    if (room.createdByEmail !== String(email || '').trim().toLowerCase()) return cb({ error: 'Only the creator can rejoin as host.' });
    const pHash = crypto.createHash('sha256').update(String(password || '')).digest('hex');
    if (pHash !== room.adminPasswordHash) return cb({ error: 'Incorrect admin password.' });
    const u = String(username || '').trim().slice(0, 24).replace(/\s+/g, ' ') || room.createdBy;
    socket.join(roomId);
    room.online[socket.id] = { username: u, email: room.createdByEmail, isAdmin: true, joinedAt: Date.now(), ghost: false };
    sys(room, `${u} (host) rejoined`); pushU(room); pushL();
    cb({ ok: true, roomId, isAdmin: true, settings: { roomName: room.name, joinPassword: room.password }, history: room.messages, users: uPub(room), adminUsers: uAdm(room) });
  });

  socket.on('message', ({ roomId, text, img }) => {
    const room = rooms[roomId]; const u = room?.online[socket.id]; if (!u) return;
    const t = String(text || '').slice(0, 2000).trim();
    if (!t && !img) return;
    if (img && !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(img)) return;
    const m = { id: Date.now() + Math.random().toString(36).slice(2), ts: Date.now(), type: 'msg', from: u.username, text: t, img: img || null };
    room.messages.push(m); if (room.messages.length > 400) room.messages.shift();
    io.to(roomId).emit('message', m);
  });

  socket.on('typing', ({ roomId }) => {
    const room = rooms[roomId]; const u = room?.online[socket.id];
    if (u && !u.ghost) socket.to(roomId).emit('typing', u.username);
  });

  socket.on('admin:toggleGhost', ({ roomId }) => {
    const room = rooms[roomId]; const u = room?.online[socket.id]; if (!u?.isAdmin) return;
    u.ghost = !u.ghost; sys(room, u.ghost ? `${u.username} left` : `${u.username} joined`); pushU(room); pushL();
  });

  socket.on('admin:deleteMsg', ({ roomId, id }) => {
    const room = rooms[roomId]; if (!room?.online[socket.id]?.isAdmin) return;
    room.messages = room.messages.filter(m => m.id !== id); io.to(roomId).emit('deleteMsg', id);
  });

  socket.on('admin:clearChat', ({ roomId }) => {
    const room = rooms[roomId]; const u = room?.online[socket.id]; if (!u?.isAdmin) return;
    room.messages = []; io.to(roomId).emit('clearChat'); sys(room, `Chat cleared by ${u.username}`);
  });

  socket.on('admin:kick', ({ roomId, username }) => {
    const room = rooms[roomId]; if (!room?.online[socket.id]?.isAdmin) return;
    for (const [sid, usr] of Object.entries(room.online)) {
      if (usr.username === username && !usr.isAdmin) {
        io.to(sid).emit('kicked'); io.sockets.sockets.get(sid)?.disconnect(true);
      }
    }
  });

  socket.on('admin:updateSettings', ({ roomId, roomName, joinPassword }) => {
    const room = rooms[roomId]; const u = room?.online[socket.id]; if (!u?.isAdmin) return;
    room.name = String(roomName || room.name).slice(0, 50).replace(/\s+/g, ' ') || room.name;
    room.password = joinPassword !== undefined ? (String(joinPassword).slice(0, 60) || null) : room.password;
    io.to(roomId).emit('settingsUpdated', { roomName: room.name, joinPassword: room.password });
    sys(room, `Settings updated by ${u.username}`); pushL();
  });

  socket.on('admin:closeRoom', ({ roomId }) => {
    const room = rooms[roomId]; const u = room?.online[socket.id]; if (!u?.isAdmin) return;
    room.closed = true;
    sys(room, `Room closed by ${u.username}.`);
    setTimeout(() => {
      for (const [sid] of Object.entries(room.online)) {
        io.to(sid).emit('roomClosed', { name: room.name });
        io.sockets.sockets.get(sid)?.disconnect(true);
      }
      delete rooms[roomId]; pushL();
    }, 2000);
  });

  socket.on('disconnect', () => {
    for (const [, room] of Object.entries(rooms)) {
      const u = room.online[socket.id];
      if (u) { delete room.online[socket.id]; if (!u.ghost) sys(room, `${u.username} left`); pushU(room); pushL(); break; }
    }
  });
});

setInterval(pushL, 8000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Freedom on http://localhost:${PORT}`));
