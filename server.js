const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// เก็บข้อมูลห้องและผู้เล่น
const gameRooms = new Map();
const playerSockets = new Map();
const socketToPlayer = new Map(); // เก็บ mapping socket → player info

// ฟังก์ชันสร้างรหัสห้อง
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// ฟังก์ชันตรวจสอบตัวเลข
function validateNumber(num) {
    if (!num || num.length !== 4) return false;
    if (!/^\d{4}$/.test(num)) return false;
    
    const digits = num.split('');
    const uniqueDigits = [...new Set(digits)];
    return uniqueDigits.length === 4;
}

// ฟังก์ชันตรวจสอบการทาย
function checkGuess(guess, secret) {
    let correctPosition = 0;
    let correctNumber = 0;
    
    const guessDigits = guess.split('');
    const secretDigits = secret.split('');
    
    // ตรวจสอบตำแหน่งถูก
    for (let i = 0; i < 4; i++) {
        if (guessDigits[i] === secretDigits[i]) {
            correctPosition++;
        }
    }
    
    // ตรวจสอบตัวเลขที่มีอยู่ในคำตอบ
    const secretCount = {};
    const guessCount = {};
    
    secretDigits.forEach(digit => {
        secretCount[digit] = (secretCount[digit] || 0) + 1;
    });
    
    guessDigits.forEach(digit => {
        guessCount[digit] = (guessCount[digit] || 0) + 1;
    });
    
    Object.keys(guessCount).forEach(digit => {
        if (secretCount[digit]) {
            correctNumber += Math.min(guessCount[digit], secretCount[digit]);
        }
    });
    
    return { correctPosition, correctNumber };
}

// ฟังก์ชันสร้าง clean players object
function createCleanPlayersObject(players) {
    const cleanPlayers = {};
    Object.keys(players).forEach(key => {
        const player = players[key];
        cleanPlayers[key] = {
            id: player.id,
            playerNumber: player.playerNumber,
            nickname: player.nickname,
            ready: player.ready,
            connected: player.connected,
            tempDisconnected: player.tempDisconnected || false
        };
    });
    return cleanPlayers;
}

// ฟังก์ชันบันทึก session สำหรับ reconnect
function savePlayerSession(socket, roomCode, playerNumber) {
    const sessionData = {
        socketId: socket.id,
        roomCode: roomCode,
        playerNumber: playerNumber,
        timestamp: Date.now()
    };
    
    // เก็บใน memory สำหรับ demo (production ควรใช้ Redis)
    socket.playerSession = sessionData;
    socketToPlayer.set(socket.id, sessionData);
    
    console.log(`💾 บันทึก session: ${socket.id} → Player ${playerNumber} in Room ${roomCode}`);
}

// ฟังก์ชันหาผู้เล่นจาก session
function findPlayerBySession(roomCode, playerNumber) {
    const room = gameRooms.get(roomCode);
    if (!room) return null;
    
    // ค้นหาผู้เล่นจาก playerNumber
    for (const [socketId, player] of Object.entries(room.players)) {
        if (player.playerNumber === playerNumber) {
            return { socketId, player };
        }
    }
    
    return null;
}

// ฟังก์ชันจัดการ reconnection
function handleReconnection(socket, roomCode, playerNumber) {
    const room = gameRooms.get(roomCode);
    if (!room) {
        return { success: false, message: 'ไม่พบห้อง' };
    }
    
    const playerInfo = findPlayerBySession(roomCode, playerNumber);
    if (!playerInfo) {
        return { success: false, message: 'ไม่พบข้อมูลผู้เล่น' };
    }
    
    const { socketId: oldSocketId, player } = playerInfo;
    
    // อัปเดตข้อมูลผู้เล่น
    player.id = socket.id;
    player.connected = true;
    player.tempDisconnected = false;
    player.lastSeen = new Date();
    player.reconnectedAt = new Date();
    
    // ย้ายข้อมูลผู้เล่นไปยัง socket ใหม่
    room.players[socket.id] = player;
    if (oldSocketId !== socket.id) {
        delete room.players[oldSocketId];
    }
    
    // อัปเดต mappings
    playerSockets.set(socket.id, roomCode);
    savePlayerSession(socket, roomCode, playerNumber);
    socket.join(roomCode);
    
    // หยุด countdown timer
    if (room.disconnectTimers && room.disconnectTimers.has(playerNumber)) {
        clearTimeout(room.disconnectTimers.get(playerNumber));
        room.disconnectTimers.delete(playerNumber);
    }
    
    console.log(`🔄 Reconnect สำเร็จ: Player ${playerNumber} in Room ${roomCode}`);
    
    return { 
        success: true, 
        gameState: room.gameState,
        players: createCleanPlayersObject(room.players),
        mySecret: room.gameState.secrets[socket.id] // ส่งตัวเลขลับกลับไป
    };
}

// ฟังก์ชันจัดการเมื่อผู้เล่นหลุดการเชื่อมต่อ
function handlePlayerDisconnect(socket, roomCode) {
    const room = gameRooms.get(roomCode);
    if (!room || !room.players[socket.id]) return;
    
    const player = room.players[socket.id];
    player.connected = false;
    player.tempDisconnected = true;
    player.lastSeen = new Date();
    
    console.log(`📴 Player ${player.playerNumber} หลุดการเชื่อมต่อใน Room ${roomCode}`);
    
    // แจ้งผู้เล่นอื่น
    socket.to(roomCode).emit('playerDisconnected', {
        playerNumber: player.playerNumber,
        reconnectTimeLeft: 30
    });
    
    // ตั้ง timer สำหรับ auto-remove
    if (!room.disconnectTimers) room.disconnectTimers = new Map();
    
    const timer = setTimeout(() => {
        handlePlayerTimeout(roomCode, player.playerNumber);
    }, 30000); // 30 วินาที
    
    room.disconnectTimers.set(player.playerNumber, timer);
    
    // เริ่ม countdown
    startReconnectCountdown(roomCode, player.playerNumber, 30);
}

// ฟังก์ชัน countdown timer
function startReconnectCountdown(roomCode, playerNumber, duration) {
    let timeLeft = duration;
    
    const countdownInterval = setInterval(() => {
        timeLeft--;
        
        // ตรวจสอบว่าผู้เล่นกลับมาหรือยัง
        const room = gameRooms.get(roomCode);
        if (!room) {
            clearInterval(countdownInterval);
            return;
        }
        
        const playerReconnected = Object.values(room.players).some(p => 
            p.playerNumber === playerNumber && p.connected
        );
        
        if (playerReconnected) {
            clearInterval(countdownInterval);
            return;
        }
        
        // ส่งอัปเดตเวลา
        if (timeLeft > 0) {
            io.to(roomCode).emit('reconnectCountdown', {
                playerNumber: playerNumber,
                timeLeft: timeLeft
            });
        } else {
            clearInterval(countdownInterval);
        }
    }, 1000);
}

// ฟังก์ชันจัดการเมื่อหมดเวลา
function handlePlayerTimeout(roomCode, playerNumber) {
    const room = gameRooms.get(roomCode);
    if (!room) return;
    
    console.log(`⏰ Player ${playerNumber} หมดเวลาใน Room ${roomCode}`);
    
    // ลบผู้เล่นที่หมดเวลา
    const playersToRemove = Object.keys(room.players).filter(socketId => 
        room.players[socketId].playerNumber === playerNumber
    );
    
    playersToRemove.forEach(socketId => {
        delete room.players[socketId];
        delete room.gameState.secrets[socketId];
        playerSockets.delete(socketId);
    });
    
    // ตรวจสอบผู้เล่นที่เหลือ
    const remainingPlayers = Object.keys(room.players).length;
    
    if (remainingPlayers === 0) {
        // ไม่มีผู้เล่นเหลือ
        gameRooms.delete(roomCode);
        console.log(`🗑️ ลบ Room ${roomCode} (ไม่มีผู้เล่น)`);
    } else if (remainingPlayers === 1) {
        // เหลือผู้เล่นเพียงคนเดียว
        const remainingPlayer = Object.values(room.players)[0];
        
        io.to(roomCode).emit('gameEnd', {
            winner: remainingPlayer.playerNumber,
            winnerName: remainingPlayer.nickname,
            winningGuess: 'ชนะเนื่องจากอีกฝ่ายหลุดการเชื่อมต่อ',
            reason: 'opponent_timeout',
            history: room.gameState.history
        });
        
        console.log(`🏆 Player ${remainingPlayer.playerNumber} ชนะ (อีกฝ่าย timeout)`);
    }
    
    // ล้าง timer
    if (room.disconnectTimers && room.disconnectTimers.has(playerNumber)) {
        room.disconnectTimers.delete(playerNumber);
    }
}

// Socket.IO Connection
io.on('connection', (socket) => {
    console.log(`🔗 เชื่อมต่อใหม่: ${socket.id}`);
    
    // สร้างห้องใหม่
    socket.on('createRoom', (callback) => {
        try {
            let roomCode;
            do {
                roomCode = generateRoomCode();
            } while (gameRooms.has(roomCode));
            
            const room = {
                code: roomCode,
                players: {},
                gameState: {
                    started: false,
                    currentPlayer: 1,
                    secrets: {},
                    history: []
                },
                createdAt: new Date(),
                disconnectTimers: new Map()
            };
            
            gameRooms.set(roomCode, room);
            
            room.players[socket.id] = {
                id: socket.id,
                playerNumber: 1,
                nickname: 'ผู้เล่น 1',
                ready: false,
                connected: true,
                lastSeen: new Date()
            };
            
            playerSockets.set(socket.id, roomCode);
            savePlayerSession(socket, roomCode, 1);
            socket.join(roomCode);
            
            console.log(`🏠 สร้าง Room: ${roomCode}`);
            
            // ส่งผลลัพธ์กลับทันที
            callback({
                success: true,
                roomCode: roomCode,
                playerNumber: 1
            });
            
            socket.emit('roomUpdate', {
                roomCode: roomCode,
                players: createCleanPlayersObject(room.players),
                gameState: room.gameState
            });
        } catch (error) {
            console.error('❌ Error ใน createRoom:', error);
            callback({ success: false, message: 'เกิดข้อผิดพลาดในการสร้างห้อง' });
        }
    });
    
    // เข้าร่วมห้อง
    socket.on('joinRoom', (data, callback) => {
        try {
            const { roomCode } = data;
            const room = gameRooms.get(roomCode);
            
            if (!room) {
                return callback({ success: false, message: 'ไม่พบห้องที่ระบุ' });
            }
            
            const playerCount = Object.keys(room.players).length;
            if (playerCount >= 2) {
                return callback({ success: false, message: 'ห้องเต็มแล้ว' });
            }
            
            if (room.gameState.started) {
                return callback({ success: false, message: 'เกมเริ่มแล้ว' });
            }
            
            room.players[socket.id] = {
                id: socket.id,
                playerNumber: 2,
                nickname: 'ผู้เล่น 2',
                ready: false,
                connected: true,
                lastSeen: new Date()
            };
            
            playerSockets.set(socket.id, roomCode);
            savePlayerSession(socket, roomCode, 2);
            socket.join(roomCode);
            
            console.log(`👥 เข้าร่วม Room: ${roomCode}`);
            
            // ส่งผลลัพธ์กลับทันที
            callback({
                success: true,
                roomCode: roomCode,
                playerNumber: 2
            });
            
            io.to(roomCode).emit('roomUpdate', {
                roomCode: roomCode,
                players: createCleanPlayersObject(room.players),
                gameState: room.gameState
            });
        } catch (error) {
            console.error('❌ Error ใน joinRoom:', error);
            callback({ success: false, message: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
        }
    });
    
    // ระบบ Reconnection
    socket.on('attemptReconnect', (data, callback) => {
        const { roomCode, playerNumber } = data;
        
        console.log(`🔄 ความพยายาม reconnect: Player ${playerNumber} → Room ${roomCode}`);
        
        const result = handleReconnection(socket, roomCode, playerNumber);
        
        if (result.success) {
            // แจ้งผู้เล่นอื่น
            socket.to(roomCode).emit('playerReconnected', {
                playerNumber: playerNumber
            });
            
            // หยุด countdown
            socket.to(roomCode).emit('stopReconnectCountdown', {
                playerNumber: playerNumber
            });
            
            callback(result);
        } else {
            callback(result);
        }
    });
    
    // ส่งตัวเลขลับ
    socket.on('submitSecret', (data, callback) => {
        try {
            const { secret } = data;
            const roomCode = playerSockets.get(socket.id);
            const room = gameRooms.get(roomCode);
            
            if (!room) {
                return callback({ success: false, message: 'ไม่พบห้อง' });
            }
            
            const player = room.players[socket.id];
            if (!player) {
                return callback({ success: false, message: 'ไม่พบผู้เล่น' });
            }
            
            if (player.ready) {
                return callback({ success: true, message: 'ส่งตัวเลขแล้ว' });
            }
            
            if (!validateNumber(secret)) {
                return callback({ 
                    success: false, 
                    message: 'ตัวเลขไม่ถูกต้อง (ต้องเป็น 4 หลัก ไม่ซ้ำ)' 
                });
            }
            
            room.gameState.secrets[socket.id] = secret;
            room.players[socket.id].ready = true;
            
            console.log(`✅ Player ${player.playerNumber} ส่งตัวเลขใน Room: ${roomCode}`);
            
            // ส่งผลลัพธ์กลับทันที
            callback({ success: true, message: 'ส่งตัวเลขสำเร็จ' });
            
            // ตรวจสอบความพร้อม
            const allPlayers = Object.values(room.players);
            const allPlayersReady = allPlayers.every(p => p.ready);
            const playerCount = allPlayers.length;
            
            if (allPlayersReady && playerCount === 2) {
                setTimeout(() => {
                    room.gameState.started = true;
                    room.gameState.currentPlayer = 1;
                    room.gameState.history = [];
                    room.gameState.startedAt = new Date();
                    
                    console.log(`🎮 เริ่มเกมใน Room: ${roomCode}`);
                    
                    io.to(roomCode).emit('gameStart', {
                        currentPlayer: room.gameState.currentPlayer,
                        startedAt: room.gameState.startedAt
                    });
                }, 500);
            }
            
            io.to(roomCode).emit('roomUpdate', {
                roomCode: roomCode,
                players: createCleanPlayersObject(room.players),
                gameState: {
                    started: room.gameState.started,
                    currentPlayer: room.gameState.currentPlayer
                }
            });
        } catch (error) {
            console.error('❌ Error ใน submitSecret:', error);
            callback({ success: false, message: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
        }
    });
    
    // ทายตัวเลข
    socket.on('makeGuess', (data, callback) => {
        try {
            const { guess } = data;
            const roomCode = playerSockets.get(socket.id);
            const room = gameRooms.get(roomCode);
            
            // ตรวจสอบพื้นฐาน
            if (!room || !room.gameState.started) {
                return callback({ success: false, message: 'เกมยังไม่เริ่ม' });
            }
            
            if (!validateNumber(guess)) {
                return callback({ 
                    success: false, 
                    message: 'ตัวเลขไม่ถูกต้อง (ต้องเป็น 4 หลัก ไม่ซ้ำ)' 
                });
            }
            
            const player = room.players[socket.id];
            if (!player) {
                return callback({ success: false, message: 'ไม่พบผู้เล่น' });
            }
            
            if (player.playerNumber !== room.gameState.currentPlayer) {
                return callback({ success: false, message: 'ไม่ใช่ตาของคุณ' });
            }
            
            // หาตัวเลขลับของอีกฝ่าย
            const opponentSocketId = Object.keys(room.players).find(id => 
                id !== socket.id
            );
            const opponentSecret = room.gameState.secrets[opponentSocketId];
            
            if (!opponentSecret) {
                return callback({ success: false, message: 'ไม่พบตัวเลขของอีกฝ่าย' });
            }
            
            const result = checkGuess(guess, opponentSecret);
            
            const historyItem = {
                player: player.playerNumber,
                playerName: player.nickname,
                guess: guess,
                result: result,
                isWin: result.correctPosition === 4,
                timestamp: new Date()
            };
            
            room.gameState.history.push(historyItem);
            
            console.log(`🎯 Player ${player.playerNumber} ทาย: ${guess} → ${result.correctPosition}หลัก ${result.correctNumber}ตัว`);
            
            // ส่งผลลัพธ์กลับทันที
            callback({ 
                success: true, 
                result: result,
                isWin: result.correctPosition === 4
            });
            
            if (result.correctPosition === 4) {
                room.gameState.winner = player.playerNumber;
                room.gameState.winningGuess = guess;
                
                io.to(roomCode).emit('gameEnd', {
                    winner: player.playerNumber,
                    winnerName: player.nickname,
                    winningGuess: guess,
                    history: room.gameState.history
                });
                
                console.log(`🏆 Player ${player.playerNumber} ชนะใน Room: ${roomCode}`);
            } else {
                room.gameState.currentPlayer = room.gameState.currentPlayer === 1 ? 2 : 1;
                
                io.to(roomCode).emit('turnChange', {
                    currentPlayer: room.gameState.currentPlayer,
                    lastGuess: historyItem,
                    history: room.gameState.history
                });
            }
        } catch (error) {
            console.error('❌ Error ใน makeGuess:', error);
            callback({ success: false, message: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
        }
    });
    
    // รีเซ็ตเกม
    socket.on('resetGame', () => {
        const roomCode = playerSockets.get(socket.id);
        const room = gameRooms.get(roomCode);
        
        if (!room) return;
        
        console.log(`🔄 รีเซ็ตเกมใน Room: ${roomCode}`);
        
        room.gameState = {
            started: false,
            currentPlayer: 1,
            secrets: {},
            history: [],
            winner: null,
            winningGuess: null
        };
        
        Object.values(room.players).forEach(player => {
            player.ready = false;
        });
        
        if (room.disconnectTimers) {
            for (const [playerNumber, timer] of room.disconnectTimers.entries()) {
                clearTimeout(timer);
            }
            room.disconnectTimers.clear();
        }
        
        io.to(roomCode).emit('gameReset', {
            players: createCleanPlayersObject(room.players),
            gameState: room.gameState
        });
    });
    
    // ออกจากห้อง
    socket.on('leaveRoom', () => {
        const roomCode = playerSockets.get(socket.id);
        if (roomCode) {
            const room = gameRooms.get(roomCode);
            if (room && room.players[socket.id]) {
                const player = room.players[socket.id];
                
                console.log(`🚪 Player ${player.playerNumber} ออกจาก Room: ${roomCode}`);
                
                delete room.players[socket.id];
                delete room.gameState.secrets[socket.id];
                
                if (room.disconnectTimers && room.disconnectTimers.has(player.playerNumber)) {
                    clearTimeout(room.disconnectTimers.get(player.playerNumber));
                    room.disconnectTimers.delete(player.playerNumber);
                }
                
                if (!room.gameState.started) {
                    room.gameState = {
                        started: false,
                        currentPlayer: 1,
                        secrets: {},
                        history: []
                    };
                    
                    Object.values(room.players).forEach(p => {
                        p.ready = false;
                    });
                }
                
                if (Object.keys(room.players).length === 0) {
                    if (room.disconnectTimers) {
                        for (const timer of room.disconnectTimers.values()) {
                            clearTimeout(timer);
                        }
                    }
                    gameRooms.delete(roomCode);
                    console.log(`🗑️ ลบ Room: ${roomCode}`);
                } else {
                    io.to(roomCode).emit('playerLeft', {
                        playerNumber: player.playerNumber
                    });
                    
                    io.to(roomCode).emit('roomUpdate', {
                        roomCode: roomCode,
                        players: createCleanPlayersObject(room.players),
                        gameState: room.gameState
                    });
                }
            }
            
            playerSockets.delete(socket.id);
            socketToPlayer.delete(socket.id);
            socket.leave(roomCode);
        }
    });
    
    // Ping/Pong สำหรับ heartbeat
    socket.on('ping', (callback) => {
        const roomCode = playerSockets.get(socket.id);
        if (roomCode) {
            const room = gameRooms.get(roomCode);
            if (room && room.players[socket.id]) {
                room.players[socket.id].lastSeen = new Date();
            }
        }
        callback('pong');
    });
    
    // ตัดการเชื่อมต่อ
    socket.on('disconnect', (reason) => {
        console.log(`❌ ตัดการเชื่อมต่อ: ${socket.id} (${reason})`);
        
        const roomCode = playerSockets.get(socket.id);
        if (roomCode) {
            handlePlayerDisconnect(socket, roomCode);
        }
        
        // ไม่ลบ mappings ทันที เพื่อให้ reconnect ได้
    });
});

// API สำหรับตรวจสอบสถานะ
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        rooms: gameRooms.size,
        players: playerSockets.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/api/rooms', (req, res) => {
    const rooms = Array.from(gameRooms.entries()).map(([code, room]) => ({
        code,
        players: Object.keys(room.players).length,
        started: room.gameState.started,
        createdAt: room.createdAt
    }));
    
    res.json({ rooms });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ทำความสะอาดห้องเก่า
setInterval(() => {
    const now = new Date();
    let cleanedRooms = 0;
    
    for (const [roomCode, room] of gameRooms.entries()) {
        const roomAge = now - room.createdAt;
        const hasActivePlayers = Object.values(room.players).some(p => p.connected);
        const playerCount = Object.keys(room.players).length;
        
        const shouldDelete = (
            (roomAge > 4 * 60 * 60 * 1000 && playerCount === 0) ||
            (!hasActivePlayers && playerCount === 0) ||
            (roomAge > 8 * 60 * 60 * 1000)
        );
        
        if (shouldDelete) {
            if (room.disconnectTimers) {
                for (const timer of room.disconnectTimers.values()) {
                    clearTimeout(timer);
                }
            }
            
            gameRooms.delete(roomCode);
            cleanedRooms++;
            
            console.log(`🗑️ ลบห้องเก่า: ${roomCode}`);
        }
    }
    
    if (cleanedRooms > 0) {
        console.log(`🧹 ทำความสะอาด: ${cleanedRooms} ห้อง`);
    }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server เริ่มทำงานที่พอร์ต ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`📊 Status: http://localhost:${PORT}/api/status`);
});

process.on('SIGTERM', () => {
    console.log('🛑 Server กำลังปิด...');
    server.close(() => {
        console.log('✅ Server ปิดเรียบร้อย');
    });
});