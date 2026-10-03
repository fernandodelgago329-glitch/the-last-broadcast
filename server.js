const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const rooms = new Map();

function id() { return crypto.randomBytes(9).toString('hex'); }
function code() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}
function roomFor(req, data) {
  const room = rooms.get(String(data.room || '').toUpperCase());
  const player = room && room.players.find(p => p.id === data.playerId);
  return { room, player };
}
function publicState(room, viewer) {
  const now = Date.now();
  if (room.phase === 'meeting' && now - room.meeting.startedAt >= 30000) resolveMeeting(room);
  const current = room.players.find(p => p.id === viewer.id);
  const role = current && current.role === 'saboteur' ? 'saboteur' : 'operator';
  return {
    code: room.code, phase: room.phase, hostId: room.hostId, stationProgress: room.progress,
    danger: room.danger, switchUsed: room.switchUsed, meeting: room.meeting && {
      startedAt: room.meeting.startedAt, votes: room.meeting.votes, secondsLeft: Math.max(0, 30 - Math.floor((now - room.meeting.startedAt) / 1000))
    },
    winner: room.winner,
    you: { id: current.id, name: current.name, alive: current.alive, role, initialRole: current.initialRole, eliminated: !current.alive },
    rooms: ['control', 'reactor', 'archive', 'comms'], roomFaults: room.roomFaults,
    players: room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, connected: p.connected, room: p.room, voted: !!(room.meeting && room.meeting.votes[p.id]) })),
    canSwitch: current.alive && role === 'saboteur' && !room.switchUsed && room.progress < 50 && room.phase === 'playing',
    canSabotage: current.alive && role === 'saboteur' && room.phase === 'playing',
    canEliminate: current.alive && role === 'saboteur' && room.phase === 'playing' && now - current.lastAction > 12000,
    lastEvent: room.events[room.events.length - 1] || null,
    events: room.events.slice(-8)
  };
}
function event(room, text) { room.events.push({ id: id(), text, at: Date.now() }); if (room.events.length > 30) room.events.shift(); }
function resolveMeeting(room) {
  if (!room.meeting) return;
  const counts = {};
  Object.values(room.meeting.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
  const ranked = Object.entries(counts).sort((a,b) => b[1] - a[1]);
  const top = ranked[0];
  const tie = top && ranked[1] && ranked[1][1] === top[1];
  if (top && !tie) {
    const out = room.players.find(p => p.id === top[0]);
    if (out) { out.alive = false; event(room, `${out.name} was voted out.`); }
  } else event(room, 'The vote was tied. Nobody was removed.');
  room.meeting = null;
  room.phase = 'playing';
  checkWin(room);
}
function checkWin(room) {
  if (room.progress >= 100) room.winner = 'operators';
  if (room.danger >= 100) room.winner = 'saboteur';
  const alive = room.players.filter(p => p.alive).length;
  const sab = room.players.filter(p => p.alive && p.role === 'saboteur').length;
  if (sab && sab >= alive - sab && alive > 1) room.winner = 'saboteur';
  if (room.players.find(p => p.role === 'saboteur' && p.alive) === undefined && room.phase === 'playing') room.winner = 'operators';
  if (room.winner) { room.phase = 'ended'; event(room, room.winner === 'operators' ? 'Operators secured the station!' : 'The Saboteur took control of the station.'); }
}
function start(room) {
  if (room.players.length < 2) return false;
  const chosen = room.players[Math.floor(Math.random() * room.players.length)];
  room.players.forEach(p => { p.role = p.id === chosen.id ? 'saboteur' : 'operator'; p.initialRole = p.role; p.alive = true; p.room = 'control'; });
  room.phase = 'playing'; room.progress = 0; room.danger = 0; room.switchUsed = false; event(room, 'The broadcast has begun.'); return true;
}
async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/') return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const room = rooms.get((url.searchParams.get('room') || '').toUpperCase());
    const player = room && room.players.find(p => p.id === url.searchParams.get('playerId'));
    return room && player ? json(res, 200, publicState(room, player)) : json(res, 404, { error: 'Room or player not found' });
  }
  if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
  let data; try { data = await body(req); } catch (e) { return json(res, 400, { error: e.message }); }
  if (url.pathname === '/api/create') {
    let roomCode = code(); while (rooms.has(roomCode)) roomCode = code();
    const player = { id: id(), name: String(data.name || 'Host').slice(0, 18), alive: true, connected: true, role: null, initialRole: null, lastAction: 0, room: 'control' };
    const room = { code: roomCode, hostId: player.id, players: [player], phase: 'lobby', progress: 0, danger: 0, switchUsed: false, meeting: null, winner: null, events: [], roomFaults: {} };
    rooms.set(roomCode, room); return json(res, 200, { room: roomCode, playerId: player.id });
  }
  if (url.pathname === '/api/join') {
    const room = rooms.get(String(data.room || '').toUpperCase());
    if (!room) return json(res, 404, { error: 'Room not found' });
    if (room.players.length >= 8) return json(res, 400, { error: 'Room is full' });
    if (room.phase !== 'lobby') return json(res, 400, { error: 'Game already started' });
    const player = { id: id(), name: String(data.name || 'Player').slice(0, 18), alive: true, connected: true, role: null, initialRole: null, lastAction: 0, room: 'control' };
    room.players.push(player); return json(res, 200, { room: room.code, playerId: player.id });
  }
  const { room, player } = roomFor(req, data);
  if (!room || !player) return json(res, 404, { error: 'Room or player not found' });
  const action = url.pathname.split('/').pop();
  if (action === 'start') {
    if (player.id !== room.hostId) return json(res, 403, { error: 'Only the host can start' });
    if (!start(room)) return json(res, 400, { error: 'Need at least 2 players' });
  } else if (action === 'move') {
    if (room.phase !== 'playing' || !player.alive || !['control', 'reactor', 'archive', 'comms'].includes(data.destination)) return json(res, 400, { error: 'Cannot move there' });
    player.room = data.destination; event(room, `${player.name} moved to ${data.destination}.`);
  } else if (action === 'task') {
    if (room.phase !== 'playing' || !player.alive) return json(res, 400, { error: 'Cannot do that now' });
    room.progress = Math.min(100, room.progress + 8); if (room.roomFaults[player.room]) delete room.roomFaults[player.room]; event(room, `${player.name} stabilized ${player.room}.`); checkWin(room);
  } else if (action === 'sabotage') {
    if (room.phase !== 'playing' || player.role !== 'saboteur' || !player.alive) return json(res, 400, { error: 'Cannot do that now' });
    const targetRoom = ['control', 'reactor', 'archive', 'comms'].includes(data.targetRoom) ? data.targetRoom : player.room;
    room.danger = Math.min(100, room.danger + 15); room.progress = Math.max(0, room.progress - 5); room.roomFaults[targetRoom] = true; player.lastAction = Date.now(); event(room, `A system fault was detected in ${targetRoom}.`); checkWin(room);
  } else if (action === 'eliminate') {
    const target = room.players.find(p => p.id === data.targetId);
    if (room.phase !== 'playing' || player.role !== 'saboteur' || !player.alive || !target || !target.alive || target.id === player.id || target.room !== player.room || Date.now() - player.lastAction < 12000) return json(res, 400, { error: 'Elimination unavailable' });
    target.alive = false; player.lastAction = Date.now(); event(room, 'A player was found offline.'); checkWin(room);
  } else if (action === 'switch') {
    const candidates = room.players.filter(p => p.alive && p.id !== player.id && p.role !== 'saboteur');
    if (room.phase !== 'playing' || player.role !== 'saboteur' || room.switchUsed || room.progress >= 50 || !candidates.length) return json(res, 400, { error: 'Role Switch unavailable' });
    const next = candidates[Math.floor(Math.random() * candidates.length)]; player.role = 'operator'; next.role = 'saboteur'; room.switchUsed = true; event(room, 'A strange shift in the station’s systems went unnoticed.');
  } else if (action === 'meeting') {
    if (room.phase !== 'playing' || !player.alive || room.meeting) return json(res, 400, { error: 'Meeting unavailable' });
    room.phase = 'meeting'; room.meeting = { startedAt: Date.now(), votes: {} }; event(room, `${player.name} called an emergency meeting.`);
  } else if (action === 'vote') {
    if (room.phase !== 'meeting' || !player.alive || room.meeting.votes[player.id]) return json(res, 400, { error: 'Vote unavailable' });
    const target = room.players.find(p => p.id === data.targetId && p.alive);
    if (!target) return json(res, 400, { error: 'Invalid vote' });
    room.meeting.votes[player.id] = target.id;
    if (Object.keys(room.meeting.votes).length >= room.players.filter(p => p.alive).length) resolveMeeting(room);
  } else if (action === 'rematch') {
    if (player.id !== room.hostId || room.phase !== 'ended') return json(res, 403, { error: 'Only the host can start a rematch' });
    room.phase = 'lobby'; room.progress = 0; room.danger = 0; room.switchUsed = false; room.meeting = null; room.winner = null; room.roomFaults = {};
    room.players.forEach(p => { p.role = null; p.initialRole = null; p.alive = true; p.lastAction = 0; p.room = 'control'; });
    room.events = []; event(room, 'The crew is preparing for another broadcast.');
  } else if (action === 'end') {
    if (player.id !== room.hostId || room.phase !== 'ended') return json(res, 403, { error: 'Only the host can end the game' });
    rooms.delete(room.code);
    return json(res, 200, { ended: true });
  } else return json(res, 404, { error: 'Unknown action' });
  return json(res, 200, publicState(room, player));
}
http.createServer(handler).listen(PORT, '0.0.0.0', () => console.log(`Last Broadcast running at http://localhost:${PORT}`));
