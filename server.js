const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
app.use(express.json());

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

// ========================
// ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ
// ========================
async function initDb() {
    const createPlayersTable = `
        CREATE TABLE IF NOT EXISTS players (
            id SERIAL PRIMARY KEY,
            full_name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            email VARCHAR(100) UNIQUE,
            password_hash TEXT NOT NULL,
            role VARCHAR(20) DEFAULT 'user',
            vuz TEXT DEFAULT '',
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
        console.log('[DB] Все таблицы готовы.');
    } catch (err) {
        console.error('[DB] Ошибка инициализации таблиц:', err);
    }
}
initDb();

// ========================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ========================
async function verifyAdmin(token) {
    try {
        const secret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
        const decoded = jwt.verify(token, secret);
        const client = await pool.connect();
        const res = await client.query('SELECT role FROM players WHERE id = $1', [decoded.userId]);
        client.release();
        if (res.rows.length === 0 || res.rows[0].role !== 'admin') return null;
        return decoded;
    } catch (err) {
        return null;
    }
}

// ========================
// API ДЛЯ АВТОРИЗАЦИИ
// ========================

app.post('/api/register', async (req, res) => {
    console.log('[API] 📥 POST /api/register получен');
    
    const { full_name, username, email, password, vuz } = req.body;
    
    if (!full_name || !username || !email || !password) {
        console.log('[API] ❌ Ошибка: не все обязательные поля заполнены');
        return res.status(400).json({ error: 'Все поля (ФИО, логин, email, пароль) обязательны' });
    }

    const client = await pool.connect();
    try {
        const check = await client.query('SELECT id FROM players WHERE username = $1 OR email = $2', [username, email]);
        if (check.rows.length > 0) {
            console.log('[API] ❌ Пользователь с таким логином или email уже существует');
            return res.status(409).json({ error: 'Имя пользователя или email уже заняты' });
        }

        const password_hash = await bcrypt.hash(password, 10);
        const userVuz = vuz || '';
        
        const result = await client.query(
            `INSERT INTO players (full_name, username, email, password_hash, role, vuz) 
             VALUES ($1, $2, $3, $4, 'user', $5) RETURNING id`,
            [full_name, username, email, password_hash, userVuz]
        );
        const userId = result.rows[0].id;
        console.log(`[API] ✅ Пользователь создан с id=${userId}`);

        await client.query('INSERT INTO player_stats (user_id) VALUES ($1)', [userId]);

        const secret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
        const token = jwt.sign({ userId, username, role: 'user' }, secret, { expiresIn: '30d' });

        console.log('[API] ✅ Регистрация успешна, токен отправлен');
        res.status(201).json({ token, userId, username, role: 'user' });
    } catch (err) {
        console.error('[API] ❌ Ошибка сервера:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/api/login', async (req, res) => {
    console.log('[API] 📥 POST /api/login получен');
    
    const { username, password } = req.body;
    if (!username || !password) {
        console.log('[API] ❌ Ошибка: логин или пароль не указаны');
        return res.status(400).json({ error: 'Логин и пароль обязательны' });
    }

    const client = await pool.connect();
    try {
        const result = await client.query('SELECT * FROM players WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            console.log('[API] ❌ Пользователь не найден');
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }
        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            console.log('[API] ❌ Неверный пароль');
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const secret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
        const token = jwt.sign({ userId: user.id, username: user.username, role: user.role }, secret, { expiresIn: '30d' });

        console.log(`[API] ✅ Вход выполнен для пользователя ${username}`);
        res.json({ token, userId: user.id, username: user.username, role: user.role });
    } catch (err) {
        console.error('[API] ❌ Ошибка сервера:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// API ДЛЯ ПРОФИЛЯ ПОЛЬЗОВАТЕЛЯ
// ========================

app.get('/api/user/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    console.log(`[API] 📥 GET /api/user/${userId} получен`);
    
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log('[API] ❌ Отсутствует или неверный токен');
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT id, full_name, username, email, vuz, role FROM players WHERE id = $1',
            [userId]
        );
        if (result.rows.length === 0) {
            console.log('[API] ❌ Пользователь не найден');
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        console.log('[API] ✅ Профиль отправлен');
        res.json(result.rows[0]);
    } finally {
        client.release();
    }
});

// ========================
// API ДЛЯ ОБНОВЛЕНИЯ СТАТИСТИКИ
// ========================

app.post('/api/update-stats', async (req, res) => {
    console.log('[API] 📥 POST /api/update-stats получен');
    const { userId, score } = req.body;
    if (!userId || score === undefined) {
        console.log('[API] ❌ Не хватает данных');
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
        console.log(`[API] ✅ Статистика обновлена: max_score=${newMax}, attempts_count=${newAttempts}`);
        res.json({ max_score: newMax, attempts_count: newAttempts });
    } catch (err) {
        console.error('[API] ❌ Ошибка обновления статистики:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// API ДЛЯ АДМИНИСТРАТОРА (СОЗДАНИЕ ТУРНИРА)
// ========================

app.post('/api/admin/create-tournament', async (req, res) => {
    console.log('[API] 📥 POST /api/admin/create-tournament получен');
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log('[API] ❌ Отсутствует токен');
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const token = authHeader.split(' ')[1];
    const admin = await verifyAdmin(token);
    if (!admin) {
        console.log('[API] ❌ Доступ запрещён (не администратор)');
        return res.status(403).json({ error: 'Доступ только для администраторов' });
    }

    const { room_code, max_players, lifetime_minutes } = req.body;
    
    if (!room_code || room_code.length !== 6) {
        return res.status(400).json({ error: 'Код комнаты должен быть 6 символов' });
    }
    if (!max_players || max_players < 2 || max_players > 10) {
        return res.status(400).json({ error: 'Максимум игроков от 2 до 10' });
    }
    if (!lifetime_minutes || ![5, 10, 15].includes(lifetime_minutes)) {
        return res.status(400).json({ error: 'Время должно быть 5, 10 или 15 минут' });
    }

    const client = await pool.connect();
    try {
        const existing = await client.query(
            'SELECT id FROM tournaments WHERE room_code = $1 AND status != $2',
            [room_code, 'finished']
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Комната с таким кодом уже существует' });
        }

        const result = await client.query(
            `INSERT INTO tournaments (room_code, admin_id, max_players, lifetime_minutes, status)
             VALUES ($1, $2, $3, $4, 'waiting')
             RETURNING id`,
            [room_code, admin.userId, max_players, lifetime_minutes]
        );
        
        console.log(`[API] ✅ Турнир создан с id=${result.rows[0].id}, код=${room_code}`);
        res.status(201).json({
            success: true,
            tournament_id: result.rows[0].id,
            room_code: room_code,
            message: 'Турнир успешно создан'
        });
        
    } catch (err) {
        console.error('[API] ❌ Ошибка создания турнира:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// WEBSOCKET ОБРАБОТЧИКИ ДЛЯ ТУРНИРОВ
// ========================

// Хранилище активных турниров (в памяти)
const tournaments = new Map();

io.on('connection', (socket) => {
    console.log(`[SERVER] Подключился: ${socket.id}`);

    // Админ подключается к турниру
    socket.on('join_tournament_admin', (roomCode) => {
        socket.join(`admin_${roomCode}`);
        console.log(`[SERVER] Админ подключился к турниру ${roomCode}`);
        sendTournamentUpdate(roomCode);
    });

    // Игрок подключается к турниру
    socket.on('join_tournament_player', (roomCode) => {
        socket.join(`player_${roomCode}`);
        console.log(`[SERVER] Игрок подключился к турниру ${roomCode}`);
        sendTournamentUpdate(roomCode);
    });

    // Админ начинает турнир
    socket.on('start_tournament', (roomCode) => {
        const tournament = tournaments.get(roomCode);
        if (tournament) {
            tournament.active = true;
            io.to(`player_${roomCode}`).emit('tournament_started');
            io.to(`admin_${roomCode}`).emit('tournament_started');
            console.log(`[SERVER] Турнир ${roomCode} начат`);
        }
    });

    // Админ завершает турнир
    socket.on('end_tournament', (roomCode) => {
        const tournament = tournaments.get(roomCode);
        if (tournament) {
            tournament.active = false;
            io.to(`player_${roomCode}`).emit('tournament_ended');
            io.to(`admin_${roomCode}`).emit('tournament_ended');
            console.log(`[SERVER] Турнир ${roomCode} завершён`);
        }
    });

    // Игрок отправляет результат
    socket.on('submit_score', (data) => {
        const { roomCode, nickname, score } = data;
        console.log(`[SERVER] Результат: ${nickname} -> ${score} м (турнир ${roomCode})`);
        
        let tournament = tournaments.get(roomCode);
        if (!tournament) {
            tournament = { players: new Map(), active: false };
            tournaments.set(roomCode, tournament);
        }
        
        const player = tournament.players.get(nickname) || { best_score: 0, attempts: 0 };
        player.attempts++;
        player.best_score = Math.max(player.best_score, score);
        tournament.players.set(nickname, player);
        
        sendTournamentUpdate(roomCode);
    });

    // Выход из турнира
    socket.on('leave_tournament', (roomCode) => {
        socket.leave(`player_${roomCode}`);
        socket.leave(`admin_${roomCode}`);
        console.log(`[SERVER] Пользователь покинул турнир ${roomCode}`);
    });

    // Отключение
    socket.on('disconnect', () => {
        console.log(`[SERVER] Отключился: ${socket.id}`);
    });
});

function sendTournamentUpdate(roomCode) {
    const tournament = tournaments.get(roomCode);
    if (!tournament) return;
    
    const players = Array.from(tournament.players.entries()).map(([nickname, data]) => ({
        nickname,
        best_score: data.best_score,
        attempts: data.attempts
    }));
    
    io.to(`admin_${roomCode}`).emit('tournament_update', players);
    io.to(`player_${roomCode}`).emit('tournament_update', players);
}

// ========================
// ЗАПУСК СЕРВЕРА
// ========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[SERVER] Сервер запущен на порту ${PORT}`);
    console.log(`[SERVER] Адрес: http://localhost:${PORT}`);
});