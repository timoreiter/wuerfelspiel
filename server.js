const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const ROW_COUNT = 10; // 1-6, Str, Fu, Po, Gr
const BASE = [20, 30, 40, 50]; // Str, Fu, Po, Gr

// ---------- HTTP (liefert nur die index.html) ----------
// Dateien für die "App": Manifest und Icons (alles andere liefert die Startseite)
const FILES = {
  '/manifest.webmanifest': 'application/manifest+json; charset=utf-8',
  '/icon.svg': 'image/svg+xml',
  '/icon-192.png': 'image/png',
  '/icon-512.png': 'image/png',
  '/apple-touch-icon.png': 'image/png',
};
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (FILES[url]) {
    res.writeHead(200, { 'Content-Type': FILES[url], 'Cache-Control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', url)));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
});

// ---------- Spiellogik ----------
const newCard = () => [0, 1, 2, 3].map(() => Array(ROW_COUNT).fill(null));

// Erlaubte Werte pro Feld (gewürfelt wird in echt, hier wird nur eingetragen)
function allowedValues(col, row) {
  if (row <= 5) return [0, 1, 2, 3, 4, 5].map(n => n * (row + 1));
  if (row === 9) { // Grande: 50 + Augenzahl, serviert (1. Wurf) 100 + Augenzahl
    const normal = [1, 2, 3, 4, 5, 6].map(n => 50 + n);
    const served = [1, 2, 3, 4, 5, 6].map(n => 100 + n);
    return col === 3 ? [0, ...served] : [0, ...normal, ...served];
  }
  const b = BASE[row - 6];
  return col === 3 ? [0, b + 5] : [0, b, b + 5]; // S = Serviert: nur mit dem 1. Wurf
}

function canPlace(card, col, row) {
  if (card[col][row] !== null) return false;
  if (col === 0) return card[0].findIndex(v => v === null) === row; // ↓
  if (col === 1) return card[1].lastIndexOf(null) === row;          // ↑
  return true;                                                      // ↕ und S
}

function totals(card) {
  const cols = [], bonus = [];
  let total = 0;
  for (let c = 0; c < 4; c++) {
    const upper = card[c].slice(0, 6).reduce((a, v) => a + (v || 0), 0);
    const sum = card[c].reduce((a, v) => a + (v || 0), 0);
    const b = upper >= 60 ? (c === 3 ? 60 : 30) : 0;
    cols.push(sum);
    bonus.push(b);
    total += sum + b;
  }
  return { cols, bonus, total };
}

const isFull = card => card.every(col => col.every(v => v !== null));
const filled = card => card.reduce((a, col) => a + col.filter(v => v !== null).length, 0);

// ---------- Räume ----------
const rooms = {};
const genCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); } while (rooms[c]);
  return c;
};

// Offene Tische: öffentliche Räume, die noch im Warteraum sind und Platz haben
const roomList = () => Object.values(rooms)
  .filter(r => r.public && r.state === 'lobby' && r.players.length < MAX_PLAYERS)
  .slice(0, 20)
  .map(r => ({ code: r.code, host: r.players[0].name, names: r.players.map(p => p.name), count: r.players.length, max: MAX_PLAYERS }));

// Alle, die gerade noch in keinem Raum sind (Startseite), sehen die Liste live
function pushRooms() {
  const msg = JSON.stringify({ t: 'rooms', rooms: roomList() });
  wss.clients.forEach(c => { if (!c.room && c.readyState === 1) c.send(msg); });
}

function publicState(room, meIdx) {
  return {
    t: 'state',
    room: room.code,
    state: room.state,
    public: !!room.public,
    game: room.game || null,
    me: meIdx,
    players: room.players.map((p, i) => ({
      name: p.name,
      connected: p.connected,
      host: i === 0,
      card: p.card,
      filled: filled(p.card),
      canUndo: p.history.length > 0,
      ...totals(p.card),
    })),
  };
}

function broadcast(room) {
  room.players.forEach((p, i) => {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(publicState(room, i)));
  });
}

const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const newPlayer = (name, token, ws) => ({ name, token, ws, connected: true, card: newCard(), history: [] });

function handle(ws, msg) {
  if (msg.t === 'list') return send(ws, { t: 'rooms', rooms: roomList() });

  if (msg.t === 'create') {
    const name = String(msg.name || '').trim().slice(0, 16);
    if (!name) return send(ws, { t: 'error', msg: 'Bitte einen Namen eingeben.' });
    const code = genCode();
    const token = crypto.randomBytes(12).toString('hex');
    const room = { code, state: 'lobby', public: !!msg.public, players: [newPlayer(name, token, ws)] };
    rooms[code] = room;
    ws.room = room; ws.token = token;
    send(ws, { t: 'welcome', room: code, token });
    broadcast(room);
    return pushRooms();
  }

  if (msg.t === 'join') {
    const room = rooms[String(msg.room || '').toUpperCase()];
    if (!room) return send(ws, { t: 'error', msg: 'Raum nicht gefunden.', fatal: true });
    const existing = msg.token && room.players.find(p => p.token === msg.token);
    if (existing) { // Wiederverbinden
      existing.ws = ws; existing.connected = true;
      ws.room = room; ws.token = existing.token;
      send(ws, { t: 'welcome', room: room.code, token: existing.token });
      return broadcast(room);
    }
    if (room.state !== 'lobby') return send(ws, { t: 'error', msg: 'Das Spiel läuft schon.', fatal: true });
    if (room.players.length >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Der Raum ist voll.', fatal: true });
    const name = String(msg.name || '').trim().slice(0, 16);
    if (!name) return send(ws, { t: 'error', msg: 'Bitte einen Namen eingeben.' });
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase()))
      return send(ws, { t: 'error', msg: 'Der Name ist schon vergeben.' });
    const token = crypto.randomBytes(12).toString('hex');
    room.players.push(newPlayer(name, token, ws));
    ws.room = room; ws.token = token;
    send(ws, { t: 'welcome', room: room.code, token });
    broadcast(room);
    return pushRooms();
  }

  const room = ws.room;
  if (!room) return;
  const idx = room.players.findIndex(p => p.token === ws.token);
  if (idx < 0) return;
  const me = room.players[idx];

  if (msg.t === 'start') {
    if (idx !== 0 || room.state !== 'lobby') return;
    room.state = 'playing';
    room.game = crypto.randomBytes(6).toString('hex'); // Spiel-Nummer, damit jedes Spiel nur einmal gezählt wird
    room.players.forEach(p => { p.card = newCard(); p.history = []; });
    broadcast(room);
    return pushRooms();
  }

  if (msg.t === 'again') {
    if (idx !== 0 || room.state !== 'finished') return;
    room.state = 'lobby';
    room.players = room.players.filter(p => p.connected);
    room.players.forEach(p => { p.card = newCard(); p.history = []; });
    broadcast(room);
    return pushRooms();
  }

  // Gastgeber schaltet den Tisch öffentlich oder privat
  if (msg.t === 'visibility') {
    if (idx !== 0 || room.state !== 'lobby') return;
    room.public = !!msg.value;
    broadcast(room);
    return pushRooms();
  }

  if (room.state === 'lobby') return;

  // Eintragen: jeder Spieler trägt nur in seinen eigenen Zettel ein
  if (msg.t === 'set') {
    const { col, row, value } = msg;
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || col > 3 || row < 0 || row >= ROW_COUNT) return;
    if (!canPlace(me.card, col, row)) return;
    if (!allowedValues(col, row).includes(value)) return;
    me.card[col][row] = value;
    me.history.push({ col, row });
    room.state = room.players.every(p => isFull(p.card)) ? 'finished' : 'playing';
    return broadcast(room);
  }

  // Letzten eigenen Eintrag rückgängig machen (Vertipper)
  if (msg.t === 'undo') {
    const last = me.history.pop();
    if (!last) return;
    me.card[last.col][last.row] = null;
    room.state = 'playing';
    return broadcast(room);
  }
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  ws.on('message', data => {
    try { handle(ws, JSON.parse(data)); } catch (e) { console.error(e); }
  });
  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    const idx = room.players.findIndex(p => p.token === ws.token);
    if (idx < 0) return;
    if (room.state === 'lobby') {
      room.players.splice(idx, 1);
      if (!room.players.length) { delete rooms[room.code]; return pushRooms(); }
    } else {
      room.players[idx].connected = false;
      if (room.players.every(p => !p.connected)) {
        setTimeout(() => {
          if (rooms[room.code] && room.players.every(p => !p.connected)) delete rooms[room.code];
        }, 60 * 60 * 1000);
      }
    }
    broadcast(room);
    pushRooms();
  });
});

server.listen(PORT, () => console.log('Läuft auf http://localhost:' + PORT));
