const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Room, GAME_STATES } = require('./server/Room');
const { generateHint } = require('./server/words');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6, // 5MB for drawing data
  pingTimeout: 30000,
  pingInterval: 10000
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Room storage
const rooms = new Map();
const playerRooms = new Map(); // socketId -> roomId
const playerReactionTimes = new Map(); // socketId -> last reaction timestamp
const player67Used = new Map(); // socketId -> round number (track 67 meme usage per round)

// Cleanup inactive rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, id) => {
    if (room.players.size === 0 && now - room.createdAt > 300000) {
      room.clearTimers();
      rooms.delete(id);
    }
  });
}, 300000);

// API routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/rooms', (req, res) => {
  const publicRooms = [];
  rooms.forEach((room, id) => {
    if (room.state === GAME_STATES.LOBBY && room.players.size < room.settings.maxPlayers) {
      publicRooms.push({
        id: room.id,
        playerCount: room.players.size,
        maxPlayers: room.settings.maxPlayers,
        hostName: room.players.get(room.hostId)?.name || 'Unknown'
      });
    }
  });
  res.json(publicRooms);
});

// Socket.IO handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Create room
  socket.on('createRoom', ({ name, avatar, settings }, callback) => {
    const roomId = generateRoomId();
    const room = new Room(roomId, socket.id, settings);
    const result = room.addPlayer(socket.id, name, avatar);

    if (result.error) {
      return callback({ error: result.error });
    }

    rooms.set(roomId, room);
    playerRooms.set(socket.id, roomId);
    socket.join(roomId);

    callback({ roomId, room: room.toJSON(), player: result.player.toJSON() });
  });

  // Join room
  socket.on('joinRoom', ({ roomId, name, avatar }, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      return callback({ error: 'Room not found' });
    }

    if (room.settings.maxPlayers !== 999 && room.players.size >= room.settings.maxPlayers) {
      return callback({ error: 'Room is full' });
    }

    const result = room.addPlayer(socket.id, name, avatar);
    if (result.error) {
      return callback({ error: result.error });
    }

    playerRooms.set(socket.id, roomId);
    socket.join(roomId);

    // Notify others
    socket.to(roomId).emit('playerJoined', {
      player: result.player.toJSON(),
      playerCount: room.players.size
    });

    // Send current game state to joining player
    const gameState = {
      roomId,
      room: room.toJSON(),
      player: result.player.toJSON(),
      drawingData: room.drawingData
    };

    if (room.state === GAME_STATES.DRAWING && room.currentWord) {
      gameState.hint = generateHint(room.currentWord, 0);
      gameState.wordLength = room.currentWord.length;
    }

    // System message
    io.to(roomId).emit('systemMessage', {
      text: `${name} joined the game!`,
      type: 'join'
    });

    callback(gameState);
  });

  // Update settings (host only)
  socket.on('updateSettings', ({ settings }) => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;

    const updatedSettings = room.updateSettings(settings);
    io.to(roomId).emit('settingsUpdated', { settings: updatedSettings });
  });

  // Start game (host only)
  socket.on('startGame', (_, callback) => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) {
      return callback?.({ error: 'Not authorized' });
    }

    const result = room.startGame();
    if (result.error) {
      return callback?.({ error: result.error });
    }

    // Send word choices only to drawer
    io.to(result.drawer.id).emit('wordChoices', {
      words: result.wordChoices,
      round: result.round,
      totalRounds: result.totalRounds
    });

    // Notify everyone about the turn
    io.to(roomId).emit('turnStart', {
      drawer: result.drawer,
      round: result.round,
      totalRounds: result.totalRounds,
      state: result.state,
      players: room.toJSON().players
    });

    // Auto-select timer (15 seconds to choose)
    room.chooseTimer = setTimeout(() => {
      if (room.state === GAME_STATES.CHOOSING) {
        const wordResult = room.autoSelectWord();
        if (wordResult) {
          startDrawingPhase(roomId, room, wordResult);
        }
      }
    }, 15000);

    callback?.({ success: true });
  });

  // Word selected by drawer
  socket.on('selectWord', ({ word }) => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || room.currentDrawer !== socket.id) return;

    if (room.chooseTimer) {
      clearTimeout(room.chooseTimer);
      room.chooseTimer = null;
    }

    const result = room.selectWord(socket.id, word);
    if (!result) return;

    startDrawingPhase(roomId, room, result);
  });

  // Drawing events
  socket.on('draw', (data) => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || room.currentDrawer !== socket.id) return;

    room.drawingData.push(data);
    socket.to(roomId).emit('draw', data);
  });

  socket.on('clearCanvas', () => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || room.currentDrawer !== socket.id) return;

    room.drawingData = [];
    socket.to(roomId).emit('clearCanvas');
  });

  socket.on('undoDraw', () => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || room.currentDrawer !== socket.id) return;

    // Remove last stroke
    const lastStrokeEnd = room.drawingData.length - 1;
    let lastStrokeStart = lastStrokeEnd;
    for (let i = lastStrokeEnd; i >= 0; i--) {
      if (room.drawingData[i].type === 'start') {
        lastStrokeStart = i;
        break;
      }
    }
    room.drawingData = room.drawingData.slice(0, lastStrokeStart);
    io.to(roomId).emit('redrawCanvas', room.drawingData);
  });

  socket.on('fill', (data) => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || room.currentDrawer !== socket.id) return;

    room.drawingData.push({ ...data, type: 'fill' });
    socket.to(roomId).emit('fill', data);
  });

  // Chat / Guess
  socket.on('chatMessage', ({ message }) => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    // Check if it's a guess
    if (room.state === GAME_STATES.DRAWING && !player.isDrawing && !player.hasGuessed) {
      const result = room.checkGuess(socket.id, message);

      if (result && result.correct) {
        // Correct guess
        io.to(roomId).emit('correctGuess', {
          player: player.toJSON(),
          players: room.toJSON().players
        });

        io.to(roomId).emit('systemMessage', {
          text: `${player.name} guessed the word!`,
          type: 'correct'
        });

        // Privately tell the player
        socket.emit('youGuessedCorrectly', { word: room.currentWord });

        // Check if all guessed
        if (result.allGuessed) {
          endTurnAndProceed(roomId, room);
        }

        return;
      }

      if (result && result.type === 'close') {
        // Close guess - only tell the guesser
        socket.emit('closeGuess', { message: `'${message}' is close!` });
        return;
      }

      if (result && result.type === 'filtered') {
        // Don't show filtered messages
        return;
      }
    }

    // 67 meme — screen shake (once per user per round)
    if (message.includes('67')) {
      const roundKey = `${socket.id}-${room.currentRound}`;
      if (!player67Used.has(roundKey)) {
        player67Used.set(roundKey, true);
        io.to(roomId).emit('screenShake', { playerName: player.name, type: '67' });
      }
    }

    // Regular chat message (or already guessed)
    if (player.hasGuessed) {
      // Only show to other guessed players and drawer
      room.players.forEach((p, pid) => {
        if (p.hasGuessed || p.isDrawing) {
          io.to(pid).emit('chatMessage', {
            playerId: socket.id,
            playerName: player.name,
            message: message,
            guessed: true
          });
        }
      });
    } else {
      io.to(roomId).emit('chatMessage', {
        playerId: socket.id,
        playerName: player.name,
        message: message,
        guessed: false
      });
    }
  });

  // Vote kick
  socket.on('voteKick', ({ targetId }) => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return;

    const result = room.voteKick(socket.id, targetId);
    if (!result) return;

    const target = room.players.get(targetId);
    const voter = room.players.get(socket.id);

    if (result.kicked) {
      io.to(targetId).emit('kicked', { reason: 'You were voted out by other players' });
      io.to(roomId).emit('systemMessage', {
        text: `${target?.name || 'Player'} was kicked from the game`,
        type: 'kick'
      });

      // Remove player
      handlePlayerLeave(targetId, roomId);
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) {
        targetSocket.leave(roomId);
        playerRooms.delete(targetId);
      }
    } else {
      io.to(roomId).emit('kickVoteUpdate', {
        targetId: targetId,
        targetName: target?.name,
        voterName: voter?.name,
        votes: result.votes,
        needed: result.needed
      });
    }
  });

  // Update avatar
  socket.on('updateAvatar', ({ avatar }) => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player) {
      player.avatar = avatar;
      io.to(roomId).emit('playerUpdated', { player: player.toJSON() });
    }
  });

  // Emoji reactions
  socket.on('sendReaction', ({ emoji }) => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return;

    // Rate limit: 1 reaction per second per player
    const lastTime = playerReactionTimes.get(socket.id) || 0;
    if (Date.now() - lastTime < 1000) return;
    playerReactionTimes.set(socket.id, Date.now());

    const player = room.players.get(socket.id);
    // Broadcast to all in room (including sender for visual confirmation)
    io.to(roomId).emit('reaction', {
      emoji,
      playerName: player?.name || 'Unknown'
    });
  });

  // Play again
  socket.on('playAgain', () => {
    const roomId = playerRooms.get(socket.id);
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;

    room.state = GAME_STATES.LOBBY;
    room.currentRound = 0;
    room.currentDrawerIndex = -1;
    room.usedWords = [];
    room.drawingData = [];
    room.players.forEach(p => {
      p.score = 0;
      p.roundScore = 0;
      p.hasGuessed = false;
      p.isDrawing = false;
    });

    io.to(roomId).emit('backToLobby', { room: room.toJSON() });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    playerReactionTimes.delete(socket.id);
    // Clean up 67 meme tracking for this player
    for (const key of player67Used.keys()) {
      if (key.startsWith(socket.id)) player67Used.delete(key);
    }
    const roomId = playerRooms.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        const player = room.players.get(socket.id);
        if (player) {
          io.to(roomId).emit('systemMessage', {
            text: `${player.name} left the game`,
            type: 'leave'
          });
        }
        handlePlayerLeave(socket.id, roomId);
      }
      playerRooms.delete(socket.id);
    }
  });
});

// Helper functions
function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Ensure unique
  if (rooms.has(id)) return generateRoomId();
  return id;
}

function startDrawingPhase(roomId, room, result) {
  // Send to everyone except drawer
  io.to(roomId).emit('drawingStart', {
    state: result.state,
    wordLength: result.wordLength,
    hint: result.hint,
    drawTime: result.drawTime,
    players: room.toJSON().players
  });

  // Send actual word to drawer
  io.to(room.currentDrawer).emit('yourWord', { word: room.currentWord });

  // Set up hint timer
  if (room.settings.hints > 0) {
    const hintInterval = (room.settings.drawTime * 1000) / (room.settings.hints + 1);
    let hintCount = 0;

    room.hintTimer = setInterval(() => {
      hintCount++;
      if (hintCount <= room.settings.hints) {
        const hint = room.getHint();
        if (hint) {
          io.to(roomId).emit('hintUpdate', { hint });
        }
      }
    }, hintInterval);
  }

  // Turn timer
  room.turnTimer = setTimeout(() => {
    endTurnAndProceed(roomId, room);
  }, room.settings.drawTime * 1000);
}

function endTurnAndProceed(roomId, room) {
  const turnResult = room.endTurn();

  io.to(roomId).emit('turnEnd', {
    word: turnResult.word,
    scores: turnResult.scores,
    players: room.toJSON().players
  });

  // Wait 4 seconds then next turn
  setTimeout(() => {
    if (room.players.size < 2) {
      const endResult = room.endGame();
      io.to(roomId).emit('gameOver', endResult);
      return;
    }

    const nextResult = room.nextTurn();
    if (nextResult.state === GAME_STATES.GAME_OVER) {
      io.to(roomId).emit('gameOver', nextResult);
      return;
    }

    // Send word choices to new drawer
    io.to(nextResult.drawer.id).emit('wordChoices', {
      words: nextResult.wordChoices,
      round: nextResult.round,
      totalRounds: nextResult.totalRounds
    });

    io.to(roomId).emit('turnStart', {
      drawer: nextResult.drawer,
      round: nextResult.round,
      totalRounds: nextResult.totalRounds,
      state: nextResult.state,
      players: room.toJSON().players
    });

    // Auto-select timer
    room.chooseTimer = setTimeout(() => {
      if (room.state === GAME_STATES.CHOOSING) {
        const wordResult = room.autoSelectWord();
        if (wordResult) {
          startDrawingPhase(roomId, room, wordResult);
        }
      }
    }, 15000);
  }, 4000);
}

function handlePlayerLeave(socketId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const wasDrawing = room.currentDrawer === socketId;
  room.removePlayer(socketId);

  if (room.players.size === 0) {
    room.clearTimers();
    rooms.delete(roomId);
    return;
  }

  io.to(roomId).emit('playerLeft', {
    playerId: socketId,
    players: room.toJSON().players,
    newHostId: room.hostId
  });

  // If drawer left during drawing, end turn
  if (wasDrawing && (room.state === GAME_STATES.DRAWING || room.state === GAME_STATES.CHOOSING)) {
    if (room.players.size >= 2) {
      // Adjust drawer index
      room.currentDrawerIndex = Math.max(0, room.currentDrawerIndex - 1);
      endTurnAndProceed(roomId, room);
    } else {
      const endResult = room.endGame();
      io.to(roomId).emit('gameOver', endResult);
    }
  }

  // If only 1 player left during game, end it
  if (room.players.size < 2 && room.state !== GAME_STATES.LOBBY) {
    const endResult = room.endGame();
    io.to(roomId).emit('gameOver', endResult);
  }
}

const PORT = process.env.PORT || 3000;

// When running locally (e.g. `node server.js`), start the HTTP server.
// On Vercel, this file is imported as a module and the exported server
// is used as the handler, so we avoid calling listen() there.
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Scribble clone server running on http://localhost:${PORT}`);
  });
}

module.exports = server;
