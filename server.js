const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`[SERVER] Игрок подключился: ${socket.id}`);

    socket.on('create_room', (playerName) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        console.log(`[SERVER] create_room: имя=${playerName}, комната=${roomId}`);

        const room = {
            id: roomId,
            admin: socket.id,
            players: [{
                id: socket.id,
                name: playerName,
                isReady: false,
                finished: false,
                distance: 0
            }],
            state: 'waiting',
            seed: null,
            startTime: null
        };

        rooms.set(roomId, room);
        socket.join(roomId);
        socket.emit('room_created', roomId);
        io.to(roomId).emit('room_update', room.players);
        console.log(`[SERVER] Комната ${roomId} создана, игроков: ${room.players.length}`);
    });

    socket.on('join_room', (data) => {
        const { roomId, playerName } = data;
        console.log(`[SERVER] join_room: комната=${roomId}, имя=${playerName}`);

        const room = rooms.get(roomId);
        if (!room) {
            socket.emit('error', 'Комната не найдена');
            return;
        }
        if (room.state !== 'waiting') {
            socket.emit('error', 'Игра уже началась');
            return;
        }

        room.players.push({
            id: socket.id,
            name: playerName,
            isReady: false,
            finished: false,
            distance: 0
        });

        socket.join(roomId);
        socket.emit('room_joined', { roomId: roomId });
        io.to(roomId).emit('room_update', room.players);
        console.log(`[SERVER] ${playerName} присоединился, всего игроков: ${room.players.length}`);
    });

    socket.on('player_ready', (roomId) => {
        const room = rooms.get(roomId);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.isReady = !player.isReady;
            console.log(`[SERVER] Готовность: ${player.name} -> ${player.isReady}`);
            io.to(roomId).emit('room_update', room.players);
        } else {
            console.log(`[SERVER] Игрок ${socket.id} не найден в комнате ${roomId}`);
        }
    });

    socket.on('leave_room', (roomId) => {
        handleLeave(socket, roomId);
    });

    socket.on('start_race', (roomId) => {
        console.log(`[SERVER] start_race получен для комнаты ${roomId}`);
        const room = rooms.get(roomId);
        if (!room) {
            console.log(`[SERVER] Комната ${roomId} не найдена`);
            return;
        }
        if (socket.id !== room.admin) {
            console.log(`[SERVER] Отправитель не админ (админ: ${room.admin}, отправитель: ${socket.id})`);
            socket.emit('error', 'Только администратор может начать гонку');
            return;
        }

        room.state = 'countdown';
        room.seed = Date.now();
        room.startTime = Date.now() + 1; // мгновенный старт

        io.to(roomId).emit('start_countdown', {
            seed: room.seed,
            startServerTime: room.startTime
        });
        console.log(`[SERVER] Гонка в комнате ${roomId} стартует мгновенно (seed=${room.seed})`);
    });

    socket.on('player_finished', async (data) => {
        const { roomId, distance } = data;
        console.log(`[SERVER] 📥 player_finished: комната=${roomId}, дистанция=${distance}, отправитель=${socket.id}`);

        const room = rooms.get(roomId);
        if (!room) {
            console.log(`[SERVER] Комната ${roomId} не найдена`);
            return;
        }

        const player = room.players.find(p => p.id === socket.id);
        if (!player) {
            console.log(`[SERVER] ❌ Игрок с id ${socket.id} не найден в комнате ${roomId}`);
            console.log(`[SERVER] Список игроков в комнате:`, room.players.map(p => ({ id: p.id, name: p.name })));
            return;
        }

        if (player.finished) {
            console.log(`[SERVER] Игрок ${player.name} уже финишировал`);
            return;
        }

        player.distance = distance;
        player.finished = true;
        console.log(`[SERVER] ✅ Финиш: ${player.name}, дистанция=${distance}`);

        // Проверка, все ли финишировали
        const allFinished = room.players.every(p => p.finished);
        console.log(`[SERVER] Все финишировали? ${allFinished}, игроков: ${room.players.length}`);

        if (allFinished) {
            const results = [...room.players].sort((a, b) => b.distance - a.distance);
            io.to(roomId).emit('show_results', results);
            console.log(`[SERVER] 🏁 Все финишировали, отправлены результаты`);
            room.state = 'finished';
            console.log(`[SERVER] Гонка в комнате ${roomId} завершена`);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[SERVER] Игрок отключился: ${socket.id}`);
        for (let [roomId, room] of rooms) {
            const playerInRoom = room.players.find(p => p.id === socket.id);
            if (playerInRoom) {
                handleLeave(socket, roomId);
                break;
            }
        }
    });
});

function handleLeave(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    if (socket.id === room.admin) {
        io.to(roomId).emit('room_closed', 'Администратор покинул комнату');
        rooms.delete(roomId);
        console.log(`[SERVER] Комната ${roomId} удалена (админ вышел)`);
        return;
    }

    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(roomId);
    io.to(roomId).emit('room_update', room.players);
    console.log(`[SERVER] Игрок удалён из комнаты ${roomId}, осталось игроков: ${room.players.length}`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[SERVER] Сервер запущен на порту ${PORT}`);
    console.log(`[SERVER] Адрес: http://localhost:${PORT}`);
});