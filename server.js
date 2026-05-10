const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Хранилище комнат
const rooms = new Map();

io.on('connection', (socket) => {
    console.log('Игрок подключился:', socket.id);

    // Создание комнаты
    socket.on('create_room', (playerName) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        
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
        
        // НОВОЕ: отправляем обновлённый список игроков (с админом)
        io.to(roomId).emit('room_update', room.players);
        
        console.log(`Комната ${roomId} создана игроком ${playerName}`);
    });

    // Присоединение к комнате
    socket.on('join_room', (data) => {
        const { roomId, playerName } = data;
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
        console.log(`${playerName} присоединился к комнате ${roomId}`);
    });

    // Переключение готовности
    socket.on('player_ready', (roomId) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.isReady = !player.isReady;
            console.log(`Игрок ${player.name} переключил готовность: ${player.isReady}`);
            io.to(roomId).emit('room_update', room.players);
        } else {
            console.log(`Игрок с сокетом ${socket.id} не найден в комнате ${roomId}`);
        }
    });

    // Выход из комнаты
    socket.on('leave_room', (roomId) => {
        handleLeave(socket, roomId);
    });

    // Старт гонки (только админ)
    socket.on('start_race', (roomId) => {
        const room = rooms.get(roomId);
        if (!room || socket.id !== room.admin) return;
        
        const allReady = room.players.every(p => p.isReady);
        if (!allReady) {
            socket.emit('error', 'Не все игроки готовы');
            return;
        }
        
        room.state = 'countdown';
        room.seed = Date.now();
        room.startTime = Date.now() + 5000;
        
        io.to(roomId).emit('start_countdown', {
            seed: room.seed,
            startServerTime: room.startTime
        });
        
        console.log(`Гонка в комнате ${roomId} начнётся через 5 секунд`);
    });

    // Финиш игрока
    socket.on('player_finished', (data) => {
        const { roomId, distance } = data;
        const room = rooms.get(roomId);
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.finished) return;
        
        player.distance = distance;
        player.finished = true;
        
        const allFinished = room.players.every(p => p.finished);
        if (allFinished) {
            const results = [...room.players].sort((a, b) => b.distance - a.distance);
            io.to(roomId).emit('show_results', results);
            room.state = 'finished';
            console.log(`Гонка в комнате ${roomId} завершена`);
        }
    });

    // Отключение игрока
    socket.on('disconnect', () => {
        for (let [roomId, room] of rooms) {
            const playerInRoom = room.players.find(p => p.id === socket.id);
            if (playerInRoom) {
                handleLeave(socket, roomId);
                break;
            }
        }
        console.log('Игрок отключился:', socket.id);
    });
});

function handleLeave(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (socket.id === room.admin) {
        io.to(roomId).emit('room_closed', 'Администратор покинул комнату');
        rooms.delete(roomId);
        return;
    }
    
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(roomId);
    io.to(roomId).emit('room_update', room.players);
}

server.listen(3000, () => {
    console.log('Сервер запущен на порту 3000');
    console.log('Адрес: http://localhost:3000');
});