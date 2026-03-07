// ===== GAME CLIENT =====
// Use both transports; after server restart (e.g. Render spin-up) force clean reconnect.
const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1500,
  timeout: 20000
});

// State
let myId = null;
let myName = '';
let myAvatar = getRandomAvatar();
let currentRoom = null;
let isHost = false;
let isDrawer = false;
let gameState = 'home';
let timerInterval = null;
let chooseInterval = null;
let canvas = null;
let lastReactionTime = 0;
const REACTION_COOLDOWN = 1000;
let hasConfettiedThisRound = false;

// Random name pool
const RANDOM_NAMES = [
  'PixelNinja', 'DoodleMaster', 'SketchBot', 'NeonDraw', 'ArcadePro',
  'InkyFingers', 'DrawStar', 'GlitchArt', 'RetroScribe', 'ByteBrush',
  'CyberPencil', 'PixelPanda', 'NeonCat', 'GlowWorm', 'BitPainter',
  'DoodleBug', 'SketchFox', 'ArtBlitz', 'DrawGhost', 'PixelWolf',
  'InkStorm', 'NeonOwl', 'GlitchDraw', 'RetroFrog', 'ByteArt',
  'ScribbleKing', 'DoodleQueen', 'SketchLord', 'NeonTiger', 'PixelBear',
  'DrawWizard', 'ArtNinja', 'InkDragon', 'BitMaster', 'GlowDraw',
  'CyberDoodle', 'RetroInk', 'ArcadeArt', 'NeonFox', 'PixelHawk'
];

function getRandomName() {
  const name = RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
  const num = Math.floor(Math.random() * 99) + 1;
  return `${name}${num}`;
}

// Colors (skribbl.io palette)
const COLORS = [
  '#FFFFFF', '#C1C1C1', '#EF130B', '#FF7100', '#FFE400',
  '#00CC00', '#00B2FF', '#231FD3', '#A300BA', '#D37CAA',
  '#A0522D', '#000000',
  '#4C4C4C', '#505050', '#740B07', '#C23800', '#E8A200',
  '#005510', '#00569E', '#0E0865', '#550069', '#A75574',
  '#63300D', '#FFFFFF'
];

const SIZES = [
  { size: 2, display: 6 },
  { size: 4, display: 10 },
  { size: 8, display: 16 },
  { size: 14, display: 22 },
  { size: 22, display: 30 }
];

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  renderAvatar(document.getElementById('homeAvatar'), myAvatar, 80);

  document.getElementById('playerName').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') createRoom();
  });
  document.getElementById('joinRoomId').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinRoom();
  });
  document.getElementById('chatInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // Reaction buttons
  document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sendReaction(btn.dataset.emoji);
    });
  });

  // Sound toggle
  const soundBtn = document.getElementById('soundToggle');
  const soundIcon = document.getElementById('soundIcon');
  if (gameAudio.isMuted) {
    soundBtn.classList.add('muted');
    if (soundIcon) soundIcon.setAttribute('data-lucide', 'volume-x');
  }
  soundBtn.addEventListener('click', () => {
    const muted = gameAudio.toggleMute();
    soundBtn.classList.toggle('muted', muted);
    if (soundIcon) {
      soundIcon.setAttribute('data-lucide', muted ? 'volume-x' : 'volume-2');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  });

  // Check URL for room code
  const params = new URLSearchParams(window.location.search);
  const roomCode = params.get('room');
  if (roomCode) document.getElementById('joinRoomId').value = roomCode;

  document.getElementById('playerName').focus();
});

// ===== REACTIONS =====
function sendReaction(emoji) {
  const now = Date.now();
  if (now - lastReactionTime < REACTION_COOLDOWN) return;
  lastReactionTime = now;

  gameAudio.playReactionClick();
  socket.emit('sendReaction', { emoji });

  // Brief cooldown visual on all buttons
  document.querySelectorAll('.reaction-btn').forEach(b => b.classList.add('cooldown'));
  setTimeout(() => {
    document.querySelectorAll('.reaction-btn').forEach(b => b.classList.remove('cooldown'));
  }, REACTION_COOLDOWN);
}

function spawnFloatingReaction(emoji) {
  const container = document.getElementById('floatingReactions');
  if (!container) return;

  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = emoji;

  // Random horizontal position (10%-90% of container width)
  const left = 10 + Math.random() * 80;
  el.style.left = left + '%';

  container.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
  // Safety cleanup
  setTimeout(() => { if (el.parentNode) el.remove(); }, 3000);
}

// ===== SCREEN SHAKE =====
function triggerShake(type) {
  const container = document.getElementById('canvasContainer');
  if (!container) return;
  const cls = type === '67' ? 'shake-67' : 'shake';
  container.classList.remove('shake', 'shake-67');
  // Force reflow to restart animation
  void container.offsetWidth;
  container.classList.add(cls);
  container.addEventListener('animationend', () => {
    container.classList.remove(cls);
  }, { once: true });
}

// ===== CONFETTI =====
function victoryShow() {
  const cvs = document.createElement('canvas');
  cvs.className = 'confetti-canvas';
  cvs.width = window.innerWidth;
  cvs.height = window.innerHeight;
  document.body.appendChild(cvs);
  const ctx = cvs.getContext('2d');

  const neonColors = ['#00fff2', '#39ff14', '#ff2cf1', '#ffe600', '#ff6600', '#4488ff', '#b44aff', '#ff003c'];
  const confetti = [];
  const fireworks = [];
  const sparkles = [];
  const stars = [];
  let frame = 0;
  const maxFrames = 300; // ~5s at 60fps

  // --- CONFETTI ---
  function spawnConfettiWave(count) {
    for (let i = 0; i < count; i++) {
      const side = Math.random();
      let x, y, vx, vy;
      if (side < 0.25) {
        x = 0; y = Math.random() * cvs.height * 0.7;
        vx = 4 + Math.random() * 8; vy = -3 + Math.random() * 6;
      } else if (side < 0.5) {
        x = cvs.width; y = Math.random() * cvs.height * 0.7;
        vx = -(4 + Math.random() * 8); vy = -3 + Math.random() * 6;
      } else if (side < 0.75) {
        x = Math.random() * cvs.width; y = 0;
        vx = -4 + Math.random() * 8; vy = 3 + Math.random() * 6;
      } else {
        x = cvs.width / 2 + (-100 + Math.random() * 200);
        y = cvs.height * 0.6;
        vx = -5 + Math.random() * 10; vy = -(6 + Math.random() * 8);
      }
      confetti.push({
        x, y, vx, vy,
        color: neonColors[Math.floor(Math.random() * neonColors.length)],
        size: 3 + Math.random() * 6,
        shape: Math.random() > 0.5 ? 'rect' : 'circle',
        rotation: Math.random() * 360,
        rotSpeed: -8 + Math.random() * 16,
        gravity: 0.10 + Math.random() * 0.08,
        spawnFrame: frame
      });
    }
  }

  // --- FIREWORKS ---
  function spawnFirework() {
    const cx = cvs.width * (0.15 + Math.random() * 0.7);
    const cy = cvs.height * (0.1 + Math.random() * 0.35);
    const color = neonColors[Math.floor(Math.random() * neonColors.length)];
    const count = 20 + Math.floor(Math.random() * 15);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.3;
      const speed = 2 + Math.random() * 4;
      fireworks.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color,
        size: 2 + Math.random() * 2,
        gravity: 0.04,
        friction: 0.97,
        spawnFrame: frame
      });
    }
  }

  // --- SPARKLES (twinkling points) ---
  function spawnSparkles(count) {
    for (let i = 0; i < count; i++) {
      sparkles.push({
        x: Math.random() * cvs.width,
        y: Math.random() * cvs.height * 0.8,
        size: 1 + Math.random() * 3,
        color: neonColors[Math.floor(Math.random() * neonColors.length)],
        twinkleSpeed: 0.05 + Math.random() * 0.1,
        phase: Math.random() * Math.PI * 2,
        spawnFrame: frame
      });
    }
  }

  // --- FLOATING STARS ---
  function spawnStars(count) {
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * cvs.width,
        y: cvs.height + 20,
        vy: -(1 + Math.random() * 2.5),
        vx: -0.5 + Math.random() * 1,
        size: 8 + Math.random() * 12,
        color: neonColors[Math.floor(Math.random() * neonColors.length)],
        rotation: Math.random() * 360,
        rotSpeed: -3 + Math.random() * 6,
        wobble: Math.random() * Math.PI * 2,
        spawnFrame: frame
      });
    }
  }

  function drawStar(cx, cy, size, color, rotation, alpha) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i * 4 * Math.PI) / 5 - Math.PI / 2;
      const r = i === 0 ? size : size;
      ctx[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * r, Math.sin(a) * r);
      const b = a + (2 * Math.PI) / 10;
      ctx.lineTo(Math.cos(b) * size * 0.4, Math.sin(b) * size * 0.4);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Initial spawns
  spawnConfettiWave(80);
  spawnSparkles(30);
  spawnStars(8);

  function animate() {
    frame++;
    ctx.clearRect(0, 0, cvs.width, cvs.height);

    // Timed spawns
    if (frame === 30) { spawnFirework(); spawnConfettiWave(50); }
    if (frame === 60) { spawnFirework(); spawnStars(6); }
    if (frame === 100) { spawnFirework(); spawnConfettiWave(40); spawnSparkles(20); }
    if (frame === 150) { spawnFirework(); spawnStars(5); }
    if (frame === 200) { spawnFirework(); spawnConfettiWave(30); }

    // Draw sparkles (background layer)
    for (let i = sparkles.length - 1; i >= 0; i--) {
      const s = sparkles[i];
      const age = frame - s.spawnFrame;
      if (age > 120) { sparkles.splice(i, 1); continue; }
      const alpha = Math.sin(s.phase + frame * s.twinkleSpeed) * 0.5 + 0.5;
      const fade = Math.max(0, 1 - age / 120);
      ctx.save();
      ctx.globalAlpha = alpha * fade;
      ctx.fillStyle = s.color;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      // 4-point sparkle shape
      const sz = s.size;
      ctx.moveTo(s.x, s.y - sz);
      ctx.quadraticCurveTo(s.x + sz * 0.15, s.y - sz * 0.15, s.x + sz, s.y);
      ctx.quadraticCurveTo(s.x + sz * 0.15, s.y + sz * 0.15, s.x, s.y + sz);
      ctx.quadraticCurveTo(s.x - sz * 0.15, s.y + sz * 0.15, s.x - sz, s.y);
      ctx.quadraticCurveTo(s.x - sz * 0.15, s.y - sz * 0.15, s.x, s.y - sz);
      ctx.fill();
      ctx.restore();
    }

    // Draw floating stars
    for (let i = stars.length - 1; i >= 0; i--) {
      const s = stars[i];
      s.y += s.vy;
      s.x += s.vx + Math.sin(s.wobble + frame * 0.03) * 0.3;
      s.rotation += s.rotSpeed;
      const age = frame - s.spawnFrame;
      const alpha = age < 20 ? age / 20 : Math.max(0, 1 - (age - 80) / 60);
      if (s.y < -30 || alpha <= 0) { stars.splice(i, 1); continue; }
      drawStar(s.x, s.y, s.size, s.color, s.rotation, alpha);
    }

    // Draw firework sparks
    for (let i = fireworks.length - 1; i >= 0; i--) {
      const p = fireworks[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= p.friction;
      p.vy *= p.friction;
      const age = frame - p.spawnFrame;
      const alpha = Math.max(0, 1 - age / 60);
      if (alpha <= 0) { fireworks.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
      ctx.fill();
      // Trail
      ctx.globalAlpha = alpha * 0.3;
      ctx.beginPath();
      ctx.arc(p.x - p.vx * 2, p.y - p.vy * 2, p.size * alpha * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Draw confetti (foreground)
    for (let i = confetti.length - 1; i >= 0; i--) {
      const p = confetti[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.99;
      p.rotation += p.rotSpeed;
      const age = frame - p.spawnFrame;
      const life = Math.max(0, 1 - age / 100);
      if (life <= 0) { confetti.splice(i, 1); continue; }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation * Math.PI / 180);
      ctx.globalAlpha = life;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 4;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      }
      ctx.restore();
    }

    const alive = confetti.length + fireworks.length + sparkles.length + stars.length;
    if (frame < maxFrames || alive > 0) {
      requestAnimationFrame(animate);
    } else {
      cvs.remove();
    }
  }
  requestAnimationFrame(animate);
}

function burstConfetti() {
  const cvs = document.createElement('canvas');
  cvs.className = 'confetti-canvas';
  cvs.width = window.innerWidth;
  cvs.height = window.innerHeight;
  document.body.appendChild(cvs);
  const ctx = cvs.getContext('2d');

  const colors = ['#00fff2', '#39ff14', '#ff2cf1', '#ffe600', '#ff6600', '#4488ff', '#b44aff'];
  const particles = [];

  // Spawn from edges — left, right, top
  for (let i = 0; i < 80; i++) {
    const side = Math.random();
    let x, y, vx, vy;
    if (side < 0.33) {
      // Left edge
      x = 0; y = Math.random() * cvs.height * 0.6;
      vx = 3 + Math.random() * 6; vy = -2 + Math.random() * 4;
    } else if (side < 0.66) {
      // Right edge
      x = cvs.width; y = Math.random() * cvs.height * 0.6;
      vx = -(3 + Math.random() * 6); vy = -2 + Math.random() * 4;
    } else {
      // Top
      x = Math.random() * cvs.width; y = 0;
      vx = -3 + Math.random() * 6; vy = 2 + Math.random() * 5;
    }
    particles.push({
      x, y, vx, vy,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 3 + Math.random() * 5,
      rotation: Math.random() * 360,
      rotSpeed: -6 + Math.random() * 12,
      gravity: 0.12 + Math.random() * 0.08,
      life: 1
    });
  }

  let frame = 0;
  const maxFrames = 90; // ~1.5s at 60fps

  function animate() {
    frame++;
    ctx.clearRect(0, 0, cvs.width, cvs.height);

    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.99;
      p.rotation += p.rotSpeed;
      p.life = Math.max(0, 1 - frame / maxFrames);

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation * Math.PI / 180);
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 4;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    });

    if (frame < maxFrames) {
      requestAnimationFrame(animate);
    } else {
      cvs.remove();
    }
  }
  requestAnimationFrame(animate);
}

// ===== AVATAR =====
function randomizeAvatar() {
  myAvatar = getRandomAvatar();
  renderAvatar(document.getElementById('homeAvatar'), myAvatar, 80);
}

function cycleAvatarColor() {
  const idx = AVATAR_COLORS.indexOf(myAvatar.color);
  myAvatar.color = AVATAR_COLORS[(idx + 1) % AVATAR_COLORS.length];
  renderAvatar(document.getElementById('homeAvatar'), myAvatar, 80);
}

function cycleAvatarEyes() {
  myAvatar.eyes = (myAvatar.eyes + 1) % 10;
  renderAvatar(document.getElementById('homeAvatar'), myAvatar, 80);
}

function cycleAvatarMouth() {
  myAvatar.mouth = (myAvatar.mouth + 1) % 10;
  renderAvatar(document.getElementById('homeAvatar'), myAvatar, 80);
}

function prevAvatarPart(part) {
  if (part === 'eyes') {
    myAvatar.eyes = (myAvatar.eyes - 1 + 10) % 10;
  } else if (part === 'mouth') {
    myAvatar.mouth = (myAvatar.mouth - 1 + 10) % 10;
  }
  renderAvatar(document.getElementById('homeAvatar'), myAvatar, 80);
}

function nextAvatarPart(part) {
  if (part === 'eyes') {
    myAvatar.eyes = (myAvatar.eyes + 1) % 10;
  } else if (part === 'mouth') {
    myAvatar.mouth = (myAvatar.mouth + 1) % 10;
  }
  renderAvatar(document.getElementById('homeAvatar'), myAvatar, 80);
}

// ===== ROOM =====
function createRoom() {
  myName = document.getElementById('playerName').value.trim();
  if (!myName) myName = getRandomName();

  socket.emit('createRoom', { name: myName, avatar: myAvatar }, (res) => {
    if (res.error) { showToast(res.error, 'error'); return; }
    myId = socket.id;
    currentRoom = res.roomId;
    isHost = true;
    showLobby(res);
  });
}

function joinRoom() {
  myName = document.getElementById('playerName').value.trim();
  if (!myName) myName = getRandomName();

  const roomId = document.getElementById('joinRoomId').value.trim().toUpperCase();
  if (!roomId) { showToast('Enter room code', 'warning'); return; }

  socket.emit('joinRoom', { roomId, name: myName, avatar: myAvatar }, (res) => {
    if (res.error) { showToast(res.error, 'error'); return; }
    myId = socket.id;
    currentRoom = res.roomId;
    isHost = res.room.hostId === myId;

    if (res.room.state === 'lobby') {
      showLobby(res);
    } else {
      enterGameScreen(() => {
        if (res.drawingData && res.drawingData.length > 0) {
          canvas.replayDrawing(res.drawingData);
        }
        updateGamePlayers(res.room.players);
        if (res.room.currentRound) {
          document.getElementById('roundNum').textContent = res.room.currentRound;
          document.getElementById('totalRounds').textContent = res.room.totalRounds;
        }
        if (res.hint) document.getElementById('wordHint').textContent = res.hint;
      });
    }
  });
}

// ===== LOBBY =====
function showLobby(data) {
  switchScreen('lobbyScreen');
  gameState = 'lobby';

  document.getElementById('lobbyRoomCode').textContent = data.roomId;
  const s = data.room.settings;
  document.getElementById('settingPlayers').value = s.maxPlayers;
  document.getElementById('settingRounds').value = s.rounds;
  document.getElementById('settingDrawTime').value = s.drawTime;
  document.getElementById('settingHints').value = s.hints;
  document.getElementById('settingWordCount').value = s.wordCount || 3;
  document.getElementById('lobbyMaxPlayers').textContent = s.maxPlayers === 999 ? '∞' : s.maxPlayers;

  const settingsPanel = document.getElementById('settingsPanel');
  settingsPanel.querySelectorAll('select, textarea, input').forEach(el => { el.disabled = !isHost; });

  if (isHost) {
    ['settingPlayers', 'settingRounds', 'settingDrawTime', 'settingHints', 'settingWordCount'].forEach(id => {
      const el = document.getElementById(id);
      el.removeEventListener('change', sendSettings);
      el.addEventListener('change', sendSettings);
    });
    const cw = document.getElementById('settingCustomWords');
    cw.removeEventListener('input', debouncedSendSettings);
    cw.addEventListener('input', debouncedSendSettings);
    const co = document.getElementById('settingCustomOnly');
    co.removeEventListener('change', sendSettings);
    co.addEventListener('change', sendSettings);
  }

  updateLobbyPlayers(data.room.players, data.room.hostId);
  updateLobbyButtons();
}

function updateLobbyPlayers(players, hostId) {
  const container = document.getElementById('lobbyPlayers');
  container.innerHTML = '';
  players.forEach(p => {
    const card = document.createElement('div');
    card.className = 'lobby-player-card' + (p.id === hostId ? ' host' : '');
    card.innerHTML = `
      <div class="player-avatar" id="lobbyAvatar-${p.id}"></div>
      <div class="player-name">${esc(p.name)}</div>
      ${p.id === hostId ? '<div class="host-badge">HOST</div>' : ''}
    `;
    container.appendChild(card);
    const el = document.getElementById(`lobbyAvatar-${p.id}`);
    if (el) renderAvatar(el, p.avatar, 40);
  });
  document.getElementById('lobbyPlayerCount').textContent = players.length;
}

function updateLobbyButtons() {
  const btn = document.getElementById('startGameBtn');
  const wait = document.getElementById('waitingText');
  if (isHost) {
    btn.style.display = 'inline-flex';
    wait.style.display = 'none';
    btn.disabled = false;
  } else {
    btn.style.display = 'none';
    wait.style.display = 'block';
  }
}

const debouncedSendSettings = debounce(sendSettings, 500);
function sendSettings() {
  const raw = document.getElementById('settingCustomWords').value;
  const words = raw.split(',').map(w => w.trim()).filter(w => w.length > 0);
  socket.emit('updateSettings', {
    settings: {
      maxPlayers: parseInt(document.getElementById('settingPlayers').value),
      rounds: parseInt(document.getElementById('settingRounds').value),
      drawTime: parseInt(document.getElementById('settingDrawTime').value),
      hints: parseInt(document.getElementById('settingHints').value),
      wordCount: parseInt(document.getElementById('settingWordCount').value),
      customWords: words,
      useCustomWordsOnly: document.getElementById('settingCustomOnly').checked
    }
  });
}

function copyInviteLink() {
  navigator.clipboard.writeText(`${location.origin}?room=${currentRoom}`).then(() => showToast('Link copied!', 'success'));
}

function startGame() {
  socket.emit('startGame', null, (res) => {
    if (res?.error) showToast(res.error, 'error');
  });
}

// ===== GAME SCREEN =====
// This ensures canvas is created AFTER the screen is visible and laid out
function enterGameScreen(callback) {
  if (gameState === 'game' && canvas) {
    // Already in game, just resize
    canvas.resize();
    if (callback) callback();
    return;
  }

  switchScreen('gameScreen');
  gameState = 'game';

  // Wait for layout to settle, then create canvas
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!canvas) {
        canvas = new DrawingCanvas('drawingCanvas', 'canvasContainer');
        canvas.onDraw = (d) => socket.emit('draw', d);
        canvas.onFill = (d) => socket.emit('fill', d);
        setupDrawingTools();
      } else {
        canvas.resize();
      }
      if (callback) callback();
    });
  });
}

function setupDrawingTools() {
  const palette = document.getElementById('colorPalette');
  palette.innerHTML = '';
  COLORS.forEach(color => {
    const btn = document.createElement('button');
    btn.className = 'color-btn' + (color === '#000000' ? ' active' : '');
    btn.style.backgroundColor = color;
    if (color === '#FFFFFF') btn.style.border = '1.5px solid #ccc';
    btn.addEventListener('click', () => {
      palette.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      canvas.setColor(color);
      if (canvas.currentTool === 'eraser') setTool('pencil');
    });
    palette.appendChild(btn);
  });

  const sizes = document.getElementById('brushSizes');
  sizes.innerHTML = '';
  SIZES.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'size-btn' + (i === 1 ? ' active' : '');
    btn.style.width = (s.display + 8) + 'px';
    btn.style.height = (s.display + 8) + 'px';
    const dot = document.createElement('span');
    dot.className = 'size-dot';
    dot.style.width = Math.max(4, s.display * 0.5) + 'px';
    dot.style.height = Math.max(4, s.display * 0.5) + 'px';
    btn.appendChild(dot);
    btn.addEventListener('click', () => {
      sizes.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      canvas.setSize(s.size);
    });
    sizes.appendChild(btn);
  });
}

function setTool(tool) {
  if (!canvas) return;
  canvas.setTool(tool);
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  const el = document.getElementById('tool' + tool.charAt(0).toUpperCase() + tool.slice(1));
  if (el) el.classList.add('active');
}

function undoDraw() {
  if (!canvas) return;
  canvas.undo();
  socket.emit('undoDraw');
}

function clearCanvasAction() {
  if (!canvas) return;
  canvas.clearCanvas();
  socket.emit('clearCanvas');
}

// ===== PLAYERS =====
function updateGamePlayers(players) {
  const panel = document.getElementById('playersPanel');
  panel.innerHTML = '';
  const sorted = [...players].sort((a, b) => b.score - a.score);

  sorted.forEach((p, idx) => {
    const item = document.createElement('div');
    let cls = 'player-item';
    if (p.isDrawing) cls += ' drawing';
    if (p.hasGuessed) cls += ' guessed';
    item.className = cls;

    const rankCls = idx === 0 ? 'first' : idx === 1 ? 'second' : idx === 2 ? 'third' : '';
    let status = '';
    if (p.isDrawing) status = '<div class="player-status drawing-status">Drawing</div>';
    else if (p.hasGuessed) status = '<div class="player-status guessed-status">Guessed</div>';

    item.innerHTML = `
      <div class="rank ${rankCls}">#${idx + 1}</div>
      <div class="player-avatar-small" id="ga-${p.id}"></div>
      <div class="player-info">
        <div class="player-name-text">${esc(p.name)}${p.id === myId ? ' (You)' : ''}</div>
        <div class="player-score-text">${p.score} pts</div>
        ${status}
      </div>
      ${p.roundScore > 0 ? `<div class="round-score">+${p.roundScore}</div>` : ''}
      ${p.id !== myId ? `<button class="kick-btn" onclick="voteKick('${p.id}')">✕</button>` : ''}
    `;
    panel.appendChild(item);
    const av = document.getElementById(`ga-${p.id}`);
    if (av) renderAvatar(av, p.avatar, 32);
  });
}

// ===== TIMER =====
function startTimer(seconds) {
  stopTimer();
  let remaining = seconds;
  const txt = document.getElementById('timerText');
  const circle = document.getElementById('timerCircle');
  txt.textContent = remaining;
  circle.classList.remove('warning');

  timerInterval = setInterval(() => {
    remaining--;
    txt.textContent = Math.max(0, remaining);
    if (remaining <= 10) {
      circle.classList.add('warning');
      // Sound effects for countdown
      if (remaining <= 5 && remaining > 0) {
        gameAudio.playWarningBeep();
      } else if (remaining > 5) {
        gameAudio.playTick();
      }
    }
    if (remaining <= 0) clearInterval(timerInterval);
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ===== CHAT =====
function sendChat() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('chatMessage', { message: msg });
  input.value = '';
}

function addChat(data) {
  const container = document.getElementById('chatMessages');
  const el = document.createElement('div');

  if (data.system) {
    el.className = `chat-msg system-msg ${data.type || ''}-msg`;
    el.textContent = data.text;
  } else if (data.close) {
    el.className = 'chat-msg close-msg';
    el.textContent = data.text;
  } else {
    el.className = 'chat-msg' + (data.guessed ? ' guessed-msg' : '');
    el.innerHTML = `<span class="msg-name" style="color:${data.color || '#6366f1'}">${esc(data.name)}:</span> ${esc(data.message)}`;
  }

  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  while (container.children.length > 200) container.removeChild(container.firstChild);
}

// ===== OVERLAYS =====
function showOverlay(id) {
  document.querySelectorAll('.overlay').forEach(o => o.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}
function hideOverlays() {
  document.querySelectorAll('.overlay').forEach(o => o.classList.remove('active'));
}

function showWordChoices(words) {
  const c = document.getElementById('wordChoicesContainer');
  c.innerHTML = '';
  words.forEach(word => {
    const btn = document.createElement('button');
    btn.className = 'word-choice-btn';
    btn.textContent = word;
    btn.addEventListener('click', () => {
      gameAudio.playWordSelect();
      socket.emit('selectWord', { word });
      hideOverlays();
    });
    c.appendChild(btn);
  });

  let cd = 15;
  document.getElementById('chooseCountdown').textContent = cd;
  if (chooseInterval) clearInterval(chooseInterval);
  chooseInterval = setInterval(() => {
    cd--;
    document.getElementById('chooseCountdown').textContent = Math.max(0, cd);
    if (cd <= 0) clearInterval(chooseInterval);
  }, 1000);

  showOverlay('wordChoiceOverlay');
}

function showTurnEnd(word, players) {
  document.getElementById('revealedWord').textContent = word || '???';
  const board = document.getElementById('turnScoreBoard');
  board.innerHTML = '';
  [...players].sort((a, b) => b.roundScore - a.roundScore).forEach(p => {
    const e = document.createElement('div');
    e.className = 'score-entry' + (p.roundScore === 0 ? ' no-guess' : '');
    e.innerHTML = `<span class="entry-name">${esc(p.name)}</span><span class="entry-score">${p.roundScore > 0 ? '+' + p.roundScore : '—'}</span>`;
    board.appendChild(e);
  });
  showOverlay('turnEndOverlay');
}

function showGameOver(rankings) {
  const podium = document.getElementById('podium');
  podium.innerHTML = '';
  const order = [1, 0, 2];
  const cls = ['second', 'first', 'third'];
  order.forEach((rank, i) => {
    if (!rankings[rank]) return;
    const p = rankings[rank];
    const el = document.createElement('div');
    el.className = `podium-place ${cls[i]}`;
    el.innerHTML = `
      <div class="podium-avatar" id="pod-${rank}"></div>
      <div class="podium-name">${esc(p.name)}</div>
      <div class="podium-score">${p.score} pts</div>
      <div class="podium-bar">#${rank + 1}</div>
    `;
    podium.appendChild(el);
    setTimeout(() => {
      const a = document.getElementById(`pod-${rank}`);
      if (a) renderAvatar(a, p.avatar, 52);
    }, 10);
  });

  const rem = document.getElementById('remainingRankings');
  rem.innerHTML = '';
  rankings.slice(3).forEach(p => {
    const r = document.createElement('div');
    r.className = 'ranking-row';
    r.innerHTML = `<span class="rank-num">#${p.rank}</span><span class="rank-name">${esc(p.name)}</span><span class="rank-score">${p.score}</span>`;
    rem.appendChild(r);
  });

  document.getElementById('playAgainBtn').style.display = isHost ? 'inline-flex' : 'none';
  showOverlay('gameOverOverlay');
}

function playAgain() { socket.emit('playAgain'); }
function voteKick(id) { socket.emit('voteKick', { targetId: id }); showToast('Vote submitted', 'warning'); }

// ===== SOCKET EVENTS =====

socket.on('playerJoined', (data) => {
  gameAudio.playJoin();
  if (gameState === 'lobby') {
    const c = document.getElementById('lobbyPlayers');
    const card = document.createElement('div');
    card.className = 'lobby-player-card';
    card.innerHTML = `
      <div class="player-avatar" id="lobbyAvatar-${data.player.id}"></div>
      <div class="player-name">${esc(data.player.name)}</div>
    `;
    c.appendChild(card);
    renderAvatar(document.getElementById(`lobbyAvatar-${data.player.id}`), data.player.avatar, 40);
    document.getElementById('lobbyPlayerCount').textContent = data.playerCount;
  }
});

socket.on('playerLeft', (data) => {
  isHost = data.newHostId === myId;
  if (gameState === 'lobby') {
    updateLobbyPlayers(data.players, data.newHostId);
    updateLobbyButtons();
  } else {
    updateGamePlayers(data.players);
  }
});

socket.on('settingsUpdated', (data) => {
  document.getElementById('settingPlayers').value = data.settings.maxPlayers;
  document.getElementById('settingRounds').value = data.settings.rounds;
  document.getElementById('settingDrawTime').value = data.settings.drawTime;
  document.getElementById('settingHints').value = data.settings.hints;
  document.getElementById('settingWordCount').value = data.settings.wordCount || 3;
  document.getElementById('lobbyMaxPlayers').textContent = data.settings.maxPlayers === 999 ? '∞' : data.settings.maxPlayers;
});

// CRITICAL: turnStart - switch to game screen, then handle state
// NOTE: wordChoices may fire BEFORE turnStart, so drawer may already have
// the word choice overlay visible. We must NOT hide it.
socket.on('turnStart', (data) => {
  isDrawer = data.drawer.id === myId;

  enterGameScreen(() => {
    canvas.clearCanvas();
    canvas.disable();
    stopTimer();

    document.getElementById('roundNum').textContent = data.round;
    document.getElementById('totalRounds').textContent = data.totalRounds;
    document.getElementById('wordHint').textContent = '';
    document.getElementById('yourWordDisplay').style.display = 'none';
    document.getElementById('drawingTools').style.display = 'none';
    document.getElementById('chatInput').disabled = false;
    document.getElementById('chatInput').placeholder = 'Type your guess here...';

    // Show reaction bar during game
    document.getElementById('reactionBar').style.display = 'flex';

    // Reset confetti guard for new turn
    hasConfettiedThisRound = false;

    updateGamePlayers(data.players);

    if (isDrawer) {
      // Don't hide overlays - wordChoices event shows the pick overlay
      // and it may already be visible. If not yet, wordChoices handler will show it.
    } else {
      // For non-drawers, hide any stale overlays and show "choosing" overlay
      hideOverlays();
      document.getElementById('choosingDrawerName').textContent = data.drawer.name;
      showOverlay('choosingOverlay');
    }

    addChat({ system: true, text: `${data.drawer.name} is choosing a word!`, type: 'correct' });
  });
});

// Word choices for drawer
socket.on('wordChoices', (data) => {
  // Make sure we're in game screen first
  enterGameScreen(() => {
    showWordChoices(data.words);
  });
});

// Drawing phase
socket.on('drawingStart', (data) => {
  hideOverlays();
  if (chooseInterval) clearInterval(chooseInterval);

  gameAudio.playDrawingStart();

  document.getElementById('wordHint').textContent = data.hint;
  startTimer(data.drawTime);
  updateGamePlayers(data.players);

  if (!isDrawer) {
    if (canvas) canvas.disable();
    document.getElementById('drawingTools').style.display = 'none';
    document.getElementById('chatInput').disabled = false;
    document.getElementById('chatInput').placeholder = 'Type your guess here...';
    document.getElementById('chatInput').focus();
  }
});

// Drawer gets their word - enable drawing
socket.on('yourWord', (data) => {
  hideOverlays();
  isDrawer = true;

  document.getElementById('yourWordDisplay').style.display = 'block';
  document.getElementById('yourWordText').textContent = data.word;
  document.getElementById('drawingTools').style.display = 'flex';
  document.getElementById('chatInput').disabled = true;
  document.getElementById('chatInput').placeholder = 'You are drawing!';

  if (canvas) {
    canvas.clearCanvas();
    canvas.enable();
    // Force resize in case canvas was created with bad dimensions
    canvas.resize();
    setTool('pencil');
  }
});

// Remote drawing
socket.on('draw', (data) => { if (canvas) canvas.receiveDrawData(data); });
socket.on('fill', (data) => { if (canvas) canvas.receiveFill(data); });
socket.on('clearCanvas', () => { if (canvas) canvas.clearCanvas(); });
socket.on('redrawCanvas', (data) => { if (canvas) canvas.replayDrawing(data); });

socket.on('hintUpdate', (data) => {
  if (!isDrawer) document.getElementById('wordHint').textContent = data.hint;
});

socket.on('chatMessage', (data) => {
  addChat({ name: data.playerName, message: data.message, guessed: data.guessed, color: data.guessed ? '#22c55e' : '#6366f1' });
});

socket.on('systemMessage', (data) => {
  addChat({ system: true, text: data.text, type: data.type });
});

socket.on('correctGuess', (data) => {
  gameAudio.playDing();
  triggerShake('guess');
  updateGamePlayers(data.players);
});

socket.on('youGuessedCorrectly', (data) => {
  document.getElementById('wordHint').textContent = data.word.split('').join(' ');
  document.getElementById('chatInput').disabled = true;
  document.getElementById('chatInput').placeholder = 'You guessed it!';
  showToast('Correct!', 'success');

  // Confetti burst — once per round
  if (!hasConfettiedThisRound) {
    hasConfettiedThisRound = true;
    burstConfetti();
  }
});

socket.on('screenShake', (data) => {
  triggerShake('67');
  addChat({ system: true, text: `${data.playerName} triggered the 67 shake! 🫨` });
});

socket.on('closeGuess', (data) => { addChat({ close: true, text: data.message }); });

socket.on('turnEnd', (data) => {
  stopTimer();
  gameAudio.playTurnEnd();
  if (canvas) canvas.disable();
  document.getElementById('drawingTools').style.display = 'none';
  document.getElementById('yourWordDisplay').style.display = 'none';
  document.getElementById('reactionBar').style.display = 'none';
  document.getElementById('chatInput').disabled = false;
  document.getElementById('chatInput').placeholder = 'Type your guess here...';
  isDrawer = false;
  showTurnEnd(data.word, data.players);
  updateGamePlayers(data.players);
});

socket.on('gameOver', (data) => {
  stopTimer();
  gameAudio.playFanfare();
  if (canvas) canvas.disable();
  document.getElementById('drawingTools').style.display = 'none';
  document.getElementById('yourWordDisplay').style.display = 'none';
  document.getElementById('reactionBar').style.display = 'none';
  isDrawer = false;
  showGameOver(data.rankings);
  victoryShow();
});

// Reactions from other players
socket.on('reaction', (data) => {
  spawnFloatingReaction(data.emoji);
});

socket.on('backToLobby', (data) => {
  gameState = 'lobby';
  switchScreen('lobbyScreen');
  updateLobbyPlayers(data.room.players, data.room.hostId);
  isHost = data.room.hostId === myId;
  updateLobbyButtons();
  hideOverlays();
  stopTimer();
  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('reactionBar').style.display = 'none';
});

socket.on('kicked', (data) => {
  document.getElementById('kickReason').textContent = data.reason;
  document.getElementById('kickedModal').classList.add('active');
});

socket.on('kickVoteUpdate', (data) => {
  addChat({ system: true, text: `${data.voterName} voted to kick ${data.targetName} (${data.votes}/${data.needed})`, type: 'kick' });
});

socket.on('disconnect', (reason) => {
  showToast('Disconnected. Reconnecting...', 'error');
  // After server restart (e.g. Render "Session ID unknown") force a clean reconnect
  if (reason === 'transport error' || reason === 'transport close') {
    setTimeout(() => { socket.connect(); }, 1500);
  }
});
socket.on('connect', () => { if (currentRoom) showToast('Reconnected!', 'success'); });

// ===== UTILITY =====
function switchScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 2500);
}

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function debounce(fn, delay) {
  let t;
  return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); };
}
