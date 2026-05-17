const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { Server } = require('socket.io');
const http = require('http');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Adjust for production
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Database Connection
mongoose.connect(process.env.MONGODB_URI).then(() => {
    console.log('Connected to MongoDB');
}).catch(err => {
    console.error('MongoDB connection error:', err);
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/score', require('./routes/score'));

app.get('/', (req, res) => {
    res.send('SD-Combat Backend with Sockets is running');
});

// --- PVP SOCKET LOGIC ---
const rooms = new Map(); // RoomCode -> { players, hostId, timer, status }

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function generateLootManifest(count) {
    const keys = ['pistol', 'smg', 'rifle', 'shotgun', 'sniper', 'launcher', 'machinegun', 'tacticalshotgun', 'grenade', 'medkit'];
    const manifest = [];
    for (let i = 0; i < count; i++) {
        manifest.push(keys[Math.floor(Math.random() * keys.length)]);
    }
    return manifest;
}

io.on('connection', (socket) => {
    console.log(`[Socket] User connected: ${socket.id}`);

    socket.on('create_room', (data, callback) => {
        const code = generateRoomCode();
        const player = { id: socket.id, name: data.name, appearance: data.appearance, isReady: false };
        
        rooms.set(code, {
            players: [player],
            hostId: socket.id,
            status: 'lobby',
            countdown: 0
        });

        socket.join(code);
        console.log(`[PvP] Room ${code} created by ${data.name}`);
        callback({ success: true, code });
        emitRoomUpdate(code);
    });

    socket.on('join_room', (data, callback) => {
        const room = rooms.get(data.code);
        if (!room) return callback({ success: false, message: 'Room not found' });
        if (room.status !== 'lobby') return callback({ success: false, message: 'Match in progress' });
        if (room.players.length >= 8) return callback({ success: false, message: 'Room full' });

        const player = { id: socket.id, name: data.name, appearance: data.appearance, isReady: false };
        room.players.push(player);
        
        socket.join(data.code);
        console.log(`[PvP] ${data.name} joined room ${data.code}`);
        callback({ success: true });
        emitRoomUpdate(data.code);
    });

    socket.on('player_update', (data) => {
        // Broadcast movement/aim to everyone else in the room
        socket.to(data.code).emit('player_event', {
            type: 'update',
            id: socket.id,
            ...data
        });

        // Handle specific game events like kills
        if (data.event === 'kill') {
            const room = rooms.get(data.code);
            if (room && room.scores) {
                if (room.scores[data.killerId]) room.scores[data.killerId].kills++;
                if (room.scores[data.victimId]) room.scores[data.victimId].deaths++;
                
                io.to(data.code).emit('leaderboard_update', room.scores);
                console.log(`[PvP] ${data.killerId} killed ${data.victimId} in room ${data.code}`);
            }
        }
    });

    socket.on('pickup_loot', (data) => {
        // Broadcast to everyone that this loot point is now empty
        io.to(data.code).emit('loot_removed', { pointIndex: data.pointIndex });

        const room = rooms.get(data.code);
        if (!room) return;

        // Server-authoritative respawn timer (15 seconds)
        setTimeout(() => {
            if (rooms.has(data.code)) {
                const keys = ['pistol', 'smg', 'rifle', 'shotgun', 'sniper', 'launcher', 'machinegun', 'tacticalshotgun', 'grenade', 'medkit'];
                const randomKey = keys[Math.floor(Math.random() * keys.length)];
                io.to(data.code).emit('respawn_loot', { pointIndex: data.pointIndex, weaponKey: randomKey });
            }
        }, 15000);
    });

    socket.on('set_ready', (data) => {
        const room = rooms.get(data.code);
        if (!room) return;

        // Prevent unready during the 4s lock
        if (room.countdown > 0 && room.countdown <= 4 && !data.isReady) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.isReady = data.isReady;
            emitRoomUpdate(data.code);
            checkLobbyReady(data.code);
        }
    });

    socket.on('disconnect', () => {
        rooms.forEach((room, code) => {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                
                if (room.players.length === 0) {
                    if (room.timer) clearInterval(room.timer);
                    rooms.delete(code);
                } else {
                    if (room.hostId === socket.id) {
                        room.hostId = room.players[0].id;
                    }
                    emitRoomUpdate(code);
                    checkLobbyReady(code);
                }
            }
        });
    });
});

function emitRoomUpdate(code) {
    const room = rooms.get(code);
    if (!room) return;

    // Send ONLY serializable data to avoid circular reference crashes
    io.to(code).emit('room_updated', {
        players: room.players,
        hostId: room.hostId,
        status: room.status,
        countdown: room.countdown
    });
}

function checkLobbyReady(code) {
    const room = rooms.get(code);
    if (!room) return;

    const allReady = room.players.length >= 2 && room.players.every(p => p.isReady);

    if (allReady && !room.timer) {
        room.countdown = 7;
        room.timer = setInterval(() => {
            room.countdown--;
            io.to(code).emit('countdown_tick', room.countdown);

            if (room.countdown <= 0) {
                clearInterval(room.timer);
                room.timer = null;
                room.status = 'in_game';
                
                // Initialize Scores
                room.scores = {};
                room.players.forEach(p => {
                    room.scores[p.id] = { name: p.name, kills: 0, deaths: 0 };
                });

                io.to(code).emit('match_starting', {
                    lootManifest: generateLootManifest(100)
                });

                // Start 5 Minute Match Timer
                room.matchTime = 300; 
                room.timer = setInterval(() => {
                    if (room.matchTime > 0) {
                        room.matchTime--;
                        io.to(code).emit('timer_update', room.matchTime);
                    } else {
                        clearInterval(room.timer);
                        room.timer = null;
                        room.status = 'results';
                        io.to(code).emit('match_ended', room.scores);
                    }
                }, 1000);
            }
        }, 1000);
    } else if (!allReady && room.timer) {
        clearInterval(room.timer);
        room.timer = null;
        room.countdown = 0;
        io.to(code).emit('countdown_tick', 0);
    }
}

// Add event listener inside io.on('connection') for kills
// I need to find where to insert it.

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
