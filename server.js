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

// Инициализация таблиц (если их нет)
async function initDb() {
    const createPlayersTable = `
        CREATE TABLE IF NOT EXISTS players (
            id SERIAL PRIMARY KEY,
            full_name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            email VARCHAR(100) UNIQUE,
            password_hash TEXT NOT NULL,
            role VARCHAR(20) DEFAULT 'user',
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
    const createTournamentsTable = `
        CREATE TABLE IF NOT EXISTS tournaments (
            id SERIAL PRIMARY KEY,
            room_code VARCHAR(10) UNIQUE NOT NULL,
            admin_id INT REFERENCES players(id),
            max_players INT DEFAULT 4,
            lifetime_minutes INT DEFAULT 5,
            status VARCHAR(20) DEFAULT 'waiting',
            created_at TIMESTAMP DEFAULT NOW()
        );
    `;
    const createTournamentParticipantsTable = `
        CREATE TABLE IF NOT EXISTS tournament_participants (
            id SERIAL PRIMARY KEY,
            tournament_id INT REFERENCES tournaments(id) ON DELETE CASCADE,
            user_id INT REFERENCES players(id),
            best_score FLOAT DEFAULT 0,
            attempts INT DEFAULT 0,
            joined_at TIMESTAMP DEFAULT NOW()
        );
    `;
    try {
        await pool.query(createPlayersTable);
        await pool.query(createStatsTable);
        await pool.query(createTournamentsTable);
        await pool.query(createTournamentParticipantsTable);
        console.log('[DB] Все таблицы готовы.');
    } catch (err) {
        console.error('[DB] Ошибка инициализации таблиц:', err);
    }
}
initDb();

// ========================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ========================

// Middleware для проверки JWT и роли admin
async function verifyAdmin(token) {
    try {
        const secret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
        const decoded = jwt.verify(token, secret);
        
        const client = await pool.connect();
        const res = await client.query('SELECT role FROM players WHERE id = $1', [decoded.userId]);
        client.release();
        
        if (res.rows.length === 0 || res.rows[0].role !== 'admin') {
            return null;
        }
        return decoded;
    } catch (err) {
        return null;
    }
}

// ========================
// API ДЛЯ АВТОРИЗАЦИИ
// ========================

// Регистрация
app.post('/api/register', async (req, res) => {
    const { full_name, username, email, password } = req.body;
    if (!full_name || !username || !email || !password) {
        return res.status(400).json({ error: 'Все поля обязательны' });
    }

    const client = await pool.connect();
    try {
        const check = await client.query('SELECT id FROM players WHERE username = $1 OR email = $2', [username, email]);
        if (check.rows.length > 0) {
            return res.status(409).json({ error: 'Имя пользователя или email уже заняты' });
        }

        const password_hash = await bcrypt.hash(password, 10);
        const result = await client.query(
            'INSERT INTO players (full_name, username, email, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [full_name, username, email, password_hash, 'user']
        );
        const userId = result.rows[0].id;

        await client.query('INSERT INTO player_stats (user_id) VALUES ($1)', [userId]);

        const secret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
        const token = jwt.sign({ userId, username, role: 'user' }, secret, { expiresIn: '30d' });

        res.status(201).json({ token, userId, username, role: 'user' });
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
        const token = jwt.sign({ userId: user.id, username: user.username, role: user.role }, secret, { expiresIn: '30d' });

        res.json({ token, userId: user.id, username: user.username, role: user.role });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// API ДЛЯ АДМИНИСТРАТОРА (ТУРНИРЫ)
// ========================

app.post('/api/admin/create-tournament', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const token = authHeader.split(' ')[1];
    const admin = await verifyAdmin(token);
    if (!admin) {
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
        
        res.status(201).json({
            success: true,
            tournament_id: result.rows[0].id,
            room_code: room_code,
            message: 'Турнир успешно создан'
        });
        
    } catch (err) {
        console.error('[API] Ошибка создания турнира:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// API ДЛЯ ИГРОКОВ (ПОЛУЧЕНИЕ ТУРНИРОВ)
// ========================

app.get('/api/tournaments', async (req, res) => {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT t.id, t.room_code, t.max_players, t.lifetime_minutes, t.status, 
                    COUNT(tp.id) as current_players
             FROM tournaments t
             LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
             WHERE t.status != 'finished'
             GROUP BY t.id`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[API] Ошибка получения турниров:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// ОБНОВЛЕНИЕ СТАТИСТИКИ ИГРОКА (ПОСЛЕ ИГРЫ)
// ========================

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
// WEBSOCKET ОБРАБОТЧИКИ (ДЛЯ ОБЫЧНЫХ КОМНАТ)
// ========================

const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`[SERVER] Игрок подключился: ${socket.id}`);
    
    // Простая комната (без турнира) – можно оставить для обычной игры
    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        // ... (оставьте старую логику, если нужна)
    });
    
    socket.on('join_room', (data) => {
        // ... (старая логика)
    });
    
    socket.on('disconnect', () => {
        console.log(`[SERVER] Игрок отключился: ${socket.id}`);
    });
});

// ========================
// ЗАПУСК СЕРВЕРА
// ========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[SERVER] Сервер запущен на порту ${PORT}`);
    console.log(`[SERVER] Адрес: http://localhost:${PORT}`);
});