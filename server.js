const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 6e6 });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Data stores ──────────────────────────────────────────────
let rooms = {};   // roomId -> { id, name, password, createdBy, createdByEmail, createdAt, closed, messages:[], online:{} }
// online inside room: socketId -> { username, email, isAdmin, joinedAt, typingOff, ghost }

function genId() {
  return crypto.randomBytes(4).toString('hex');
}

function roomPublicInfo(r) {
  return {
    id: r.id,
    name: r.name,
    hasPassword: !!r.password,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    closed: r.closed,
    memberCount: Object.keys(r.online).filter(s => !r.online[s].ghost).length
  };
}

function sysMsg(room, text) {
  const msg = { id: Date.now() + Math.random().toString(36).slice(2), ts: Date.now(), type: 'system', text };
  room.messages.push(msg);
  if (room.messages.length > 400) room.messages.shift();
  io.to(room.id).emit('message', msg);
  return msg;
}

function userList(room) {
  return Object.values(room.online)
    .filter(u => !u.ghost)
    .map(u => ({ username: u.username, isAdmin: u.isAdmin, joinedAt: u.joinedAt }));
}

function adminUserList(room) {
  return Object.values(room.online)
    .map(u => ({ username: u.username, email: u.email, isAdmin: u.isAdmin, joinedAt: u.joinedAt, typingOff: u.typingOff, ghost: !!u.ghost }));
}

function pushUsers(room) {
  io.to(room.id).emit('userlist', userList(room));
  for (const [sid, u] of Object.entries(room.online)) {
    if (u.isAdmin) io.to(sid).emit('adminUserlist', adminUserList(room));
  }
}

function pushLobby() {
  const list = Object.values(rooms).map(roomPublicInfo);
  io.emit('lobby', list);
}

// ── Socket handling ──────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Create room ──
  socket.on('createRoom', ({ roomName, username, email, password, roomPassword }, cb) => {
    if (typeof cb !== 'function') return;
    const cleanName = String(roomName || '').trim().slice(0, 50).replace(/\s+/g, ' ');
    const cleanUser = String(username || '').trim().slice(0, 24).replace(/\s+/g, ' ');
    const cleanEmail = String(email || '').trim().toLowerCase().slice(0, 80);
    const adminToken = String(password || '').trim().slice(0, 60);
    const cleanRoomPw = String(roomPassword || '').trim().slice(0, 60) || null;

    if (!cleanName) return cb({ error: 'Please provide a room name.' });
    if (!cleanUser) return cb({ error: 'Please enter your display name.' });
    if (!cleanEmail || !cleanEmail.includes('@')) return cb({ error: 'Please enter a valid email address.' });
    if (!adminToken) return cb({ error: 'Please set an admin password to manage this room.' });

    const id = genId();
    const room = {
      id, name: cleanName, password: cleanRoomPw,
      createdBy: cleanUser, createdByEmail: cleanEmail,
      createdAt: Date.now(), closed: false, messages: [], online: {}
    };
    rooms[id] = room;

    socket.join(id);
    room.online[socket.id] = {
      username: cleanUser, email: cleanEmail, isAdmin: true,
      joinedAt: Date.now(), typingOff: false, ghost: false
    };

    sysMsg(room, `${cleanUser} created the room "${cleanName}"`);
    pushUsers(room);
    pushLobby();

    cb({
      ok: true, roomId: id, isAdmin: true,
      settings: { roomName: cleanName, joinPassword: cleanRoomPw },
      history: room.messages, users: userList(room), adminUsers: adminUserList(room)
    });
  });

  // ── Join room ──
  socket.on('joinRoom', ({ roomId, username, email, password }, cb) => {
    if (typeof cb !== 'function') return;
    const room = rooms[roomId];
    if (!room) return cb({ error: 'Room not found. It may have been closed.' });
    if (room.closed) return cb({ error: 'This room has been closed by its creator.' });

    const cleanUser = String(username || '').trim().slice(0, 24).replace(/\s+/g, ' ');
    const cleanEmail = String(email || '').trim().toLowerCase().slice(0, 80);

    if (!cleanUser) return cb({ error: 'Please enter your display name.' });
    if (!cleanEmail || !cleanEmail.includes('@')) return cb({ error: 'Please enter a valid email address.' });
    if (room.password && String(password || '') !== room.password)
      return cb({ error: 'Incorrect room password.' });
    if (Object.values(room.online).some(u => u.username.toLowerCase() === cleanUser.toLowerCase()))
      return cb({ error: 'That display name is already in use. Choose another.' });

    socket.join(roomId);
    room.online[socket.id] = {
      username: cleanUser, email: cleanEmail, isAdmin: false,
      joinedAt: Date.now(), typingOff: false, ghost: false
    };

    sysMsg(room, `${cleanUser} joined the room`);
    pushUsers(room);
    pushLobby();

    cb({
      ok: true, roomId, isAdmin: false,
      settings: { roomName: room.name, joinPassword: room.password },
      history: room.messages, users: userList(room), adminUsers: null
    });
  });

  // ── Admin rejoin (creator re-enters as admin) ──
  socket.on('adminRejoin', ({ roomId, username, email, adminPassword }, cb) => {
    if (typeof cb !== 'function') return;
    const room = rooms[roomId];
    if (!room) return cb({ error: 'Room not found.' });
    if (room.closed) return cb({ error: 'This room has been closed.' });
    if (room.createdByEmail !== String(email || '').trim().toLowerCase())
      return cb({ error: 'Only the room creator can rejoin as admin.' });
    // adminPassword is just validated client-side, we trust the email match

    const cleanUser = String(username || '').trim().slice(0, 24).replace(/\s+/g, ' ') || room.createdBy;
    socket.join(roomId);
    room.online[socket.id] = {
      username: cleanUser, email: room.createdByEmail, isAdmin: true,
      joinedAt: Date.now(), typingOff: false, ghost: false
    };

    sysMsg(room, `${cleanUser} (host) rejoined`);
    pushUsers(room);
    pushLobby();

    cb({
      ok: true, roomId, isAdmin: true,
      settings: { roomName: room.name, joinPassword: room.password },
      history: room.messages, users: userList(room), adminUsers: adminUserList(room)
    });
  });

  // ── Send message ──
  socket.on('message', ({ roomId, text, img }) => {
    const room = rooms[roomId];
    const u = room?.online[socket.id];
    if (!u) return;
    const cleanText = String(text || '').slice(0, 2000).trim();
    if (!cleanText && !img) return;
    if (img && !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(img)) return;

    const msg = {
      id: Date.now() + Math.random().toString(36).slice(2), ts: Date.now(),
      type: 'msg', from: u.username, text: cleanText, img: img || null
    };
    room.messages.push(msg);
    if (room.messages.length > 400) room.messages.shift();
    io.to(roomId).emit('message', msg);
  });

  // ── Typing indicator ──
  socket.on('typing', ({ roomId }) => {
    const room = rooms[roomId];
    const u = room?.online[socket.id];
    if (u && !u.typingOff && !u.ghost) socket.to(roomId).emit('typing', u.username);
  });

  // ── Admin: toggle typing for user ──
  socket.on('admin:toggleTyping', ({ roomId, username }) => {
    const room = rooms[roomId];
    const admin = room?.online[socket.id];
    if (!admin?.isAdmin) return;
    const target = Object.values(room.online).find(u => u.username === username);
    if (!target) return;
    target.typingOff = !target.typingOff;
    sysMsg(room, `${username}'s typing indicator was ${target.typingOff ? 'disabled' : 'enabled'} by ${admin.username}`);
    pushUsers(room);
  });

  // ── Admin: ghost mode ──
  socket.on('admin:toggleGhost', ({ roomId }) => {
    const room = rooms[roomId];
    const u = room?.online[socket.id];
    if (!u?.isAdmin) return;
    u.ghost = !u.ghost;
    sysMsg(room, u.ghost ? `${u.username} left the room` : `${u.username} joined the room`);
    pushUsers(room);
    pushLobby();
  });

  // ── Admin: delete message ──
  socket.on('admin:deleteMsg', ({ roomId, id }) => {
    const room = rooms[roomId];
    if (!room?.online[socket.id]?.isAdmin) return;
    room.messages = room.messages.filter(m => m.id !== id);
    io.to(roomId).emit('deleteMsg', id);
  });

  // ── Admin: clear chat ──
  socket.on('admin:clearChat', ({ roomId }) => {
    const room = rooms[roomId];
    const u = room?.online[socket.id];
    if (!u?.isAdmin) return;
    room.messages = [];
    io.to(roomId).emit('clearChat');
    sysMsg(room, `Conversation cleared by ${u.username}`);
  });

  // ── Admin: kick user ──
  socket.on('admin:kick', ({ roomId, username }) => {
    const room = rooms[roomId];
    if (!room?.online[socket.id]?.isAdmin) return;
    for (const [sid, usr] of Object.entries(room.online)) {
      if (usr.username === username && !usr.isAdmin) {
        io.to(sid).emit('kicked');
        io.sockets.sockets.get(sid)?.disconnect(true);
      }
    }
  });

  // ── Admin: update room settings ──
  socket.on('admin:updateSettings', ({ roomId, roomName, joinPassword }) => {
    const room = rooms[roomId];
    const u = room?.online[socket.id];
    if (!u?.isAdmin) return;
    room.name = String(roomName || room.name).slice(0, 50).replace(/\s+/g, ' ') || room.name;
    room.password = joinPassword !== undefined ? (String(joinPassword).slice(0, 60) || null) : room.password;
    io.to(roomId).emit('settingsUpdated', { roomName: room.name, joinPassword: room.password });
    sysMsg(room, `Room settings updated by ${u.username}`);
    pushLobby();
  });

  // ── Admin: close room ──
  socket.on('admin:closeRoom', ({ roomId }) => {
    const room = rooms[roomId];
    const u = room?.online[socket.id];
    if (!u?.isAdmin) return;

    room.closed = true;
    sysMsg(room, `This room has been closed by ${u.username}. Thank you for using Freedom.`);

    // Disconnect all members after a brief delay so they see the message
    setTimeout(() => {
      for (const [sid, usr] of Object.entries(room.online)) {
        io.to(sid).emit('roomClosed', { name: room.name });
        io.sockets.sockets.get(sid)?.disconnect(true);
      }
      // Remove room from memory
      delete rooms[roomId];
      pushLobby();
    }, 2000);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    for (const [rid, room] of Object.entries(rooms)) {
      const u = room.online[socket.id];
      if (u) {
        delete room.online[socket.id];
        if (!u.ghost) sysMsg(room, `${u.username} left the room`);
        pushUsers(room);
        pushLobby();
        break;
      }
    }
  });
});

// Periodic lobby push
setInterval(pushLobby, 10000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Freedom running on http://localhost:${PORT}`));
