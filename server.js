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
    console.log('[API] Тело запроса:', req.body);
    
    const { full_name, username, email, password, vuz } = req.body;
    
    // Проверка обязательных полей (vuz не обязателен)
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
    console.log('[API] Тело запроса:', req.body);
    
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
// API ДЛЯ ПОЛУЧЕНИЯ СПИСКА ТУРНИРОВ
// ========================

app.get('/api/tournaments', async (req, res) => {
    console.log('[API] 📥 GET /api/tournaments получен');
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
        console.log(`[API] ✅ Отправлено ${result.rows.length} турниров`);
        res.json(result.rows);
    } catch (err) {
        console.error('[API] ❌ Ошибка получения турниров:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// WEBSOCKET ОБРАБОТЧИКИ (для обычных комнат)
// ========================

const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`[SERVER] Игрок подключился: ${socket.id}`);
    
    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        console.log(`[SERVER] Создана комната: ${roomId}`);
    });
    
    socket.on('join_room', (data) => {
        console.log(`[SERVER] Присоединение к комнате: ${data.roomId}`);
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