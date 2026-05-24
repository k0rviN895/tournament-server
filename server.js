const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// ========================
// ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ (TigerData)
// ========================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('[DB] ❌ Ошибка подключения к TigerData:', err.message);
    } else {
        console.log('[DB] ✅ Успешное подключение к TigerData!');
        release();
    }
});

async function initDb() {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS tournament_results (
            id SERIAL PRIMARY KEY,
            tournament_id VARCHAR(10) NOT NULL,
            winner_name VARCHAR(50) NOT NULL,
            winner_score FLOAT NOT NULL,
            participants JSONB NOT NULL,
            finished_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_tournament_id ON tournament_results(tournament_id);
    `;
    try {
        await pool.query(createTableQuery);
        console.log('[DB] Таблица tournament_results готова.');
    } catch (err) {
        console.error('[DB] Ошибка инициализации таблицы:', err);
    }
}

// ========================
// ХРАНИЛИЩЕ КОМНАТ
// ========================
const rooms = new Map();

// ========================
// SOCKET.IO ОБРАБОТЧИКИ
// ========================
io.on('connection', (socket) => {
    console.log(`[SERVER] Игрок подключился: ${socket.id}`);

    // ---- СОЗДАНИЕ КОМНАТЫ ----
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

    // ---- ПРИСОЕДИНЕНИЕ К КОМНАТЕ ----
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

    // ---- ПЕРЕКЛЮЧЕНИЕ ГОТОВНОСТИ ----
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

    // ---- ВЫХОД ИЗ КОМНАТЫ ----
    socket.on('leave_room', (roomId) => {
        handleLeave(socket, roomId);
    });

    // ---- СТАРТ ГОНКИ (только админ) ----
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

        const allReady = room.players.every(p => p.isReady);
        console.log(`[SERVER] Все игроки готовы? ${allReady}`);
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
        console.log(`[SERVER] Гонка в комнате ${roomId} начнётся через 5 секунд (seed=${room.seed})`);
    });

    // ---- ФИНИШ ИГРОКА (сохранение в БД) ----
    socket.on('player_finished', async (data) => {
        const { roomId, distance } = data;
        console.log(`[SERVER] 📥 player_finished: комната=${roomId}, дистанция=${distance}`);

        const room = rooms.get(roomId);
        if (!room) {
            console.log(`[SERVER] Комната ${roomId} не найдена`);
            return;
        }

        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.finished) {
            console.log(`[SERVER] Игрок ${socket.id} уже финишировал или не найден`);
            return;
        }

        player.distance = distance;
        player.finished = true;
        console.log(`[SERVER] ✅ Финиш: ${player.name}, дистанция=${distance}`);

        const allFinished = room.players.every(p => p.finished);
        if (allFinished) {
            const results = [...room.players].sort((a, b) => b.distance - a.distance);
            io.to(roomId).emit('show_results', results);
            console.log(`[SERVER] 🏁 Все финишировали, отправлены результаты`);

            // ---- СОХРАНЕНИЕ В БАЗУ ДАННЫХ ----
            try {
                const winner = results[0];
                const participantsJson = JSON.stringify(results.map(p => ({ name: p.name, score: p.distance })));
                const insertQuery = `
                    INSERT INTO tournament_results (tournament_id, winner_name, winner_score, participants)
                    VALUES ($1, $2, $3, $4)
                `;
                await pool.query(insertQuery, [roomId, winner.name, winner.distance, participantsJson]);
                console.log(`[DB] ✅ Результаты турнира ${roomId} сохранены. Победитель: ${winner.name} (${winner.distance})`);
            } catch (dbError) {
                console.error('[DB] ❌ Ошибка сохранения результатов турнира:', dbError);
            }

            room.state = 'finished';
            console.log(`[SERVER] Гонка в комнате ${roomId} завершена`);
        }
    });

    // ---- ОТКЛЮЧЕНИЕ ИГРОКА ----
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

// ========================
// API: ПОЛУЧИТЬ ИСТОРИЮ ТУРНИРОВ
// ========================
app.get('/api/tournaments', async (req, res) => {
    console.log('[API] Запрос истории турниров');
    try {
        const query = `
            SELECT tournament_id, winner_name, winner_score, participants, finished_at
            FROM tournament_results
            ORDER BY finished_at DESC
            LIMIT 20
        `;
        const result = await pool.query(query);
        console.log(`[API] Отправлено ${result.rows.length} записей`);
        res.json(result.rows);
    } catch (err) {
        console.error('[API] Ошибка получения истории:', err);
        res.status(500).json({ error: 'Ошибка сервера при получении истории' });
    }
});

// ========================
// ЗАПУСК СЕРВЕРА
// ========================
initDb();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[SERVER] Сервер запущен на порту ${PORT}`);
    console.log(`[SERVER] Адрес: http://localhost:${PORT}`);
});