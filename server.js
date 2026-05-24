const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
app.use(express.json()); // для парсинга JSON в API-запросах

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

// Инициализация таблиц (если их нет)
async function initDb() {
    const createPlayersTable = `
        CREATE TABLE IF NOT EXISTS players (
            id SERIAL PRIMARY KEY,
            full_name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `;
    const createStatsTable = `
        CREATE TABLE IF NOT EXISTS player_stats (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
            max_score INTEGER DEFAULT 0,
            attempts_count INTEGER DEFAULT 0
        );
    `;
    try {
        await pool.query(createPlayersTable);
        await pool.query(createStatsTable);
        console.log('[DB] Таблицы players и player_stats готовы.');
    } catch (err) {
        console.error('[DB] Ошибка инициализации таблиц:', err);
    }
}
initDb();

// ========================
// ХРАНИЛИЩЕ КОМНАТ (WebSocket)
// ========================
const rooms = new Map();

// ========================
// SOCKET.IO ОБРАБОТЧИКИ (без изменений)
// ========================
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
            console.log(`[SERVER] Отправитель не админ (админ: ${room.admin})`);
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
            return;
        }

        if (player.finished) {
            console.log(`[SERVER] Игрок ${player.name} уже финишировал`);
            return;
        }

        player.distance = distance;
        player.finished = true;
        console.log(`[SERVER] ✅ Финиш: ${player.name}, дистанция=${distance}`);

        const allFinished = room.players.every(p => p.finished);
        if (allFinished) {
            const results = [...room.players].sort((a, b) => b.distance - a.distance);
            io.to(roomId).emit('show_results', results);
            console.log(`[SERVER] 🎉 Все финишировали, отправлены результаты`);
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

// ========================
// API ДЛЯ РЕГИСТРАЦИИ, ВХОДА И СТАТИСТИКИ
// ========================

// Регистрация
app.post('/api/register', async (req, res) => {
    const { full_name, username, password } = req.body;
    if (!full_name || !username || !password) {
        return res.status(400).json({ error: 'Все поля обязательны' });
    }

    const client = await pool.connect();
    try {
        const check = await client.query('SELECT id FROM players WHERE username = $1', [username]);
        if (check.rows.length > 0) {
            return res.status(409).json({ error: 'Имя пользователя уже занято' });
        }

        const password_hash = await bcrypt.hash(password, 10);
        const result = await client.query(
            'INSERT INTO players (full_name, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
            [full_name, username, password_hash]
        );
        const userId = result.rows[0].id;

        await client.query('INSERT INTO player_stats (user_id) VALUES ($1)', [userId]);

        const secret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
        const token = jwt.sign({ userId, username }, secret, { expiresIn: '30d' });

        res.status(201).json({ token, userId, username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// Логин
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Логин и пароль обязательны' });
    }

    const client = await pool.connect();
    try {
        const result = await client.query('SELECT * FROM players WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }
        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const secret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
        const token = jwt.sign({ userId: user.id, username: user.username }, secret, { expiresIn: '30d' });

        res.json({ token, userId: user.id, username: user.username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// Обновление статистики после игры
app.post('/api/update-stats', async (req, res) => {
    const { userId, score } = req.body;
    if (!userId || score === undefined) {
        return res.status(400).json({ error: 'Не хватает данных' });
    }

    const client = await pool.connect();
    try {
        let stats = await client.query('SELECT max_score, attempts_count FROM player_stats WHERE user_id = $1', [userId]);
        if (stats.rows.length === 0) {
            await client.query('INSERT INTO player_stats (user_id) VALUES ($1)', [userId]);
            stats = await client.query('SELECT max_score, attempts_count FROM player_stats WHERE user_id = $1', [userId]);
        }
        const oldMax = stats.rows[0].max_score;
        const oldAttempts = stats.rows[0].attempts_count;
        const newMax = Math.max(score, oldMax);
        const newAttempts = oldAttempts + 1;

        await client.query(
            'UPDATE player_stats SET max_score = $1, attempts_count = $2 WHERE user_id = $3',
            [newMax, newAttempts, userId]
        );
        res.json({ max_score: newMax, attempts_count: newAttempts });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// ЗАПУСК СЕРВЕРА
// ========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[SERVER] Сервер запущен на порту ${PORT}`);
    console.log(`[SERVER] Адрес: http://localhost:${PORT}`);
});