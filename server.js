const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const MAX_TEAMS = 5; // Teams zu je 2 Spielern
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
  .map(r => ({ code: r.code, host: r.players[0].name, names: r.players.map(p => p.name), count: r.players.length, max: MAX_PLAYERS, stake: r.stake || 0, mode: r.mode }));

// Alle, die gerade noch in keinem Raum sind (Startseite), sehen die Liste live
function pushRooms() {
  const msg = JSON.stringify({ t: 'rooms', rooms: roomList() });
  wss.clients.forEach(c => { if (!c.room && c.readyState === 1) c.send(msg); });
}

// Eine "Einheit" ist ein Zettel: im Einzelspiel ein Spieler, im Team-Modus ein Team aus 2 Spielern
const newUnit = players => ({ players, card: newCard(), history: [], writer: players[0] });
const unitOf = (room, p) => room.units && room.units.find(u => u.players.includes(p));

function assignTeam(room, p) {
  for (let t = 0; t < MAX_TEAMS; t++) {
    if (room.players.filter(q => q !== p && q.team === t).length < 2) { p.team = t; return; }
  }
}

function canStart(room) {
  if (room.players.length < 2) return false;
  if (room.mode !== 'teams') return true;
  const c = {};
  room.players.forEach(p => { c[p.team] = (c[p.team] || 0) + 1; });
  const v = Object.values(c);
  return v.length >= 2 && v.every(n => n === 2);
}

function buildUnits(room) {
  if (room.mode === 'teams') {
    const g = {};
    room.players.forEach(p => { (g[p.team] = g[p.team] || []).push(p); });
    return Object.keys(g).sort((a, b) => a - b).map(k => newUnit(g[k]));
  }
  return room.players.map(p => newUnit([p]));
}

function publicState(room, meIdx) {
  const me = room.players[meIdx];
  const units = room.units;
  const idxOf = p => room.players.indexOf(p);
  const uOf = p => (units ? units.findIndex(u => u.players.includes(p)) : -1);
  const unitData = units ? units.map(u => ({
    name: u.players.map(p => p.name).join(' & '),
    members: u.players.map(idxOf).filter(i => i >= 0),
    writer: idxOf(u.writer),
    connected: u.players.some(p => p.connected),
    card: u.card,
    filled: filled(u.card),
    canUndo: u.history.length > 0,
    ...totals(u.card),
  })) : null;
  const myUnit = uOf(me);
  return {
    t: 'state',
    room: room.code,
    state: room.state,
    public: !!room.public,
    stake: room.stake || 0, // Einsatz in Cent pro Punkt Unterschied (0 = ohne Geld)
    mode: room.mode,
    game: room.game || null,
    me: meIdx,
    myUnit,
    iWrite: units && myUnit >= 0 ? units[myUnit].writer === me : false,
    units: unitData,
    pairs: (room.pairs || []).map(([a, b]) => [idxOf(a), idxOf(b)]).filter(([a, b]) => a >= 0 && b >= 0),
    players: room.players.map((p, i) => ({
      name: p.name,
      connected: p.connected,
      host: i === 0,
      team: p.team,
      u: uOf(p),
      total: units && uOf(p) >= 0 ? unitData[uOf(p)].total : 0,
    })),
  };
}

function broadcast(room) {
  room.players.forEach((p, i) => {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(publicState(room, i)));
  });
}

const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const newPlayer = (name, token, ws) => ({ name, token, ws, connected: true, team: null });

function handle(ws, msg) {
  if (msg.t === 'list') return send(ws, { t: 'rooms', rooms: roomList() });

  if (msg.t === 'create') {
    const name = String(msg.name || '').trim().slice(0, 16);
    if (!name) return send(ws, { t: 'error', msg: 'Bitte einen Namen eingeben.' });
    const code = genCode();
    const token = crypto.randomBytes(12).toString('hex');
    const room = { code, state: 'lobby', public: !!msg.public, stake: 0, mode: 'single', units: null, pairs: [], players: [newPlayer(name, token, ws)] };
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
    const np = newPlayer(name, token, ws);
    room.players.push(np);
    if (room.mode === 'teams') assignTeam(room, np);
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

  // Tisch verlassen (im Warteraum und nach dem Spiel); mitten im Spiel nicht
  if (msg.t === 'leave') {
    if (room.state === 'playing') return;
    room.players.splice(idx, 1);
    ws.room = null; ws.token = null;
    if (!room.players.length) delete rooms[room.code]; else broadcast(room);
    return pushRooms();
  }

  if (msg.t === 'start') {
    if (idx !== 0 || room.state !== 'lobby' || !canStart(room)) return;
    room.state = 'playing';
    room.game = crypto.randomBytes(6).toString('hex'); // Spiel-Nummer, damit jedes Spiel nur einmal gezählt wird
    room.units = buildUnits(room);
    room.pairs = [];
    broadcast(room);
    return pushRooms();
  }

  if (msg.t === 'again') {
    if (idx !== 0 || room.state !== 'finished') return;
    room.state = 'lobby';
    room.players = room.players.filter(p => p.connected);
    room.units = null; room.pairs = [];
    if (room.mode === 'teams') room.players.forEach(p => { if (p.team === null || room.players.filter(q => q.team === p.team).length > 2) assignTeam(room, p); });
    broadcast(room);
    return pushRooms();
  }

  // Einsatz pro Punkt Unterschied: nur der Gastgeber, nur im Warteraum, 0 (aus) oder 10 bis 200 Cent in 10er-Schritten
  if (msg.t === 'stake') {
    if (idx !== 0 || room.state !== 'lobby') return;
    const v = msg.value;
    if (!Number.isInteger(v) || v < 0 || v > 200 || v % 10 !== 0) return;
    room.stake = v;
    broadcast(room);
    return pushRooms();
  }

  // Einzeln oder Teams (2er): nur der Gastgeber im Warteraum
  if (msg.t === 'mode') {
    if (idx !== 0 || room.state !== 'lobby' || (msg.value !== 'single' && msg.value !== 'teams')) return;
    room.mode = msg.value;
    if (room.mode === 'teams') {
      room.players.forEach(p => { p.team = null; });
      room.players.forEach(p => assignTeam(room, p));
    }
    broadcast(room);
    return pushRooms();
  }

  // Team wechseln: jeder für sich, der Gastgeber auch für andere
  if (msg.t === 'team') {
    if (room.state !== 'lobby' || room.mode !== 'teams') return;
    const target = idx === 0 && Number.isInteger(msg.who) && room.players[msg.who] ? room.players[msg.who] : me;
    const v = msg.value;
    if (!Number.isInteger(v) || v < 0 || v >= MAX_TEAMS) return;
    if (room.players.filter(q => q !== target && q.team === v).length >= 2) return;
    target.team = v;
    return broadcast(room);
  }

  // Gastgeber schaltet den Tisch öffentlich oder privat
  if (msg.t === 'visibility') {
    if (idx !== 0 || room.state !== 'lobby') return;
    room.public = !!msg.value;
    broadcast(room);
    return pushRooms();
  }

  if (room.state === 'lobby') return;

  // Eintragen: nur der Schreiber der eigenen Einheit (im Einzelspiel jeder für sich)
  const unit = unitOf(room, me);
  if (!unit) return;

  if (msg.t === 'set') {
    if (unit.writer !== me) return;
    const { col, row, value } = msg;
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || col > 3 || row < 0 || row >= ROW_COUNT) return;
    if (!canPlace(unit.card, col, row)) return;
    if (!allowedValues(col, row).includes(value)) return;
    unit.card[col][row] = value;
    unit.history.push({ col, row });
    room.state = room.units.every(u => isFull(u.card)) ? 'finished' : 'playing';
    return broadcast(room);
  }

  // Letzten Eintrag rückgängig machen (Vertipper)
  if (msg.t === 'undo') {
    if (unit.writer !== me) return;
    const last = unit.history.pop();
    if (!last) return;
    unit.card[last.col][last.row] = null;
    room.state = 'playing';
    return broadcast(room);
  }

  // Schreiber übernehmen (Team-Modus)
  if (msg.t === 'writer') {
    if (room.state !== 'playing') return;
    unit.writer = me;
    return broadcast(room);
  }

  // Abrechnung im Team-Modus: a rechnet mit b ab, der Partner von a automatisch mit dem Partner von b
  if (msg.t === 'pick') {
    if (room.state !== 'finished' || room.mode !== 'teams') return;
    const pa = room.players[msg.a], pb = room.players[msg.b];
    if (!pa || !pb) return;
    const ua = unitOf(room, pa), ub = unitOf(room, pb);
    if (!ua || !ub || ua === ub) return;
    if (unit !== ua && unit !== ub) return;
    const between = ([x, y]) => (ua.players.includes(x) && ub.players.includes(y)) || (ub.players.includes(x) && ua.players.includes(y));
    room.pairs = room.pairs.filter(pr => !between(pr));
    room.pairs.push([pa, pb]);
    const pa2 = ua.players.find(p => p !== pa), pb2 = ub.players.find(p => p !== pb);
    if (pa2 && pb2) room.pairs.push([pa2, pb2]);
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
      const gone = room.players[idx];
      gone.connected = false;
      const u = unitOf(room, gone); // fällt der Schreiber aus, schreibt der Partner
      if (u && u.writer === gone) { const alt = u.players.find(q => q !== gone && q.connected); if (alt) u.writer = alt; }
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
