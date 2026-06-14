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
            room_code VARCHAR(20) UNIQUE NOT NULL,
            game_name VARCHAR(100) DEFAULT '',
            admin_id INT REFERENCES players(id),
            max_players INT DEFAULT 4,
            lifetime_minutes INT DEFAULT 5,
            status VARCHAR(20) DEFAULT 'waiting',
            end_time TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW()
        );
    `;

    const createTournamentPlayersTable = `
        CREATE TABLE IF NOT EXISTS tournament_players (
            id SERIAL PRIMARY KEY,
            tournament_id VARCHAR(20) REFERENCES tournaments(room_code) ON DELETE CASCADE,
            nickname VARCHAR(50) NOT NULL,
            best_score FLOAT DEFAULT 0,
            attempts INT DEFAULT 0,
            joined_at TIMESTAMP DEFAULT NOW()
        );
    `;

    try {
        await pool.query(createPlayersTable);
        await pool.query(createStatsTable);
        await pool.query(createTournamentsTable);
        await pool.query(createTournamentPlayersTable);
        
        // Добавляем UNIQUE constraint если его нет
        await pool.query(`
            ALTER TABLE tournament_players 
            DROP CONSTRAINT IF EXISTS tournament_players_tournament_id_nickname_key
        `);
        await pool.query(`
            ALTER TABLE tournament_players 
            ADD CONSTRAINT tournament_players_tournament_id_nickname_key 
            UNIQUE (tournament_id, nickname)
        `);
        
        console.log('[DB] Все таблицы готовы.');
    } catch (err) {
        console.error('[DB] Ошибка инициализации таблиц:', err);
    }
}

initDb();

// ========================
// АВТОМАТИЧЕСКОЕ ЗАВЕРШЕНИЕ ТУРНИРА ПО ТАЙМЕРУ
// ========================

setInterval(async () => {
    const now = new Date();
    try {
        const result = await pool.query(
            'UPDATE tournaments SET status = $1 WHERE status = $2 AND end_time < $3 RETURNING room_code',
            ['finished', 'active', now]
        );
        
        for (const row of result.rows) {
            io.to(`player_${row.room_code}`).emit('tournament_ended');
            io.to(`admin_${row.room_code}`).emit('tournament_ended');
            console.log(`[SERVER] Турнир ${row.room_code} автоматически завершён по таймеру`);
        }
    } catch (err) {
        console.error('[SERVER] Ошибка автоматического завершения:', err);
    }
}, 10000);

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
        return res.status(400).json({ error: 'Все поля (ФИО, логин, email, пароль) обязательны' });
    }

    const client = await pool.connect();
    try {
        const check = await client.query('SELECT id FROM players WHERE username = $1 OR email = $2', [username, email]);
        if (check.rows.length > 0) {
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
        await client.query('INSERT INTO player_stats (user_id) VALUES ($1)', [userId]);

        const secret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
        const token = jwt.sign({ userId, username, role: 'user' }, secret, { expiresIn: '30d' });

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
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT id, full_name, username, email, vuz, role FROM players WHERE id = $1',
            [userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        res.json(result.rows[0]);
    } finally {
        client.release();
    }
});

// ========================
// API ДЛЯ ТУРНИРОВ
// ========================

app.get('/api/tournament/:code', async (req, res) => {
    const { code } = req.params;
    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT room_code, game_name, end_time, status, max_players FROM tournaments WHERE room_code = $1',
            [code]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Турнир не найден' });
        }
        res.json(result.rows[0]);
    } finally {
        client.release();
    }
});

app.post('/api/admin/create-tournament', async (req, res) => {
    console.log('[API] 📥 POST /api/admin/create-tournament получен');
    
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const token = authHeader.split(' ')[1];
    const admin = await verifyAdmin(token);
    if (!admin) {
        return res.status(403).json({ error: 'Доступ только для администраторов' });
    }

    const { room_code, game_name, max_players, lifetime_minutes } = req.body;
    
    // Проверка на undefined
    const safeGameName = game_name && game_name !== 'undefined' ? game_name : 'Турнир';
    
    console.log(`[API] Параметры: room_code=${room_code}, game_name=${safeGameName}, max_players=${max_players}, lifetime_minutes=${lifetime_minutes}`);

    if (!room_code || room_code.length < 4 || room_code.length > 20) {
        return res.status(400).json({ error: 'Код должен быть от 4 до 20 символов' });
    }

    if (!max_players || max_players < 1 || max_players > 100) {
        return res.status(400).json({ error: 'Максимум игроков от 1 до 100' });
    }

    if (!lifetime_minutes || lifetime_minutes < 1 || lifetime_minutes > 1440) {
        return res.status(400).json({ error: 'Время должно быть от 1 до 1440 минут' });
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
            `INSERT INTO tournaments (room_code, game_name, admin_id, max_players, lifetime_minutes, status)
             VALUES ($1, $2, $3, $4, $5, 'waiting')
             RETURNING id`,
            [room_code, safeGameName, admin.userId, max_players, lifetime_minutes]
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

app.post('/api/admin/start-tournament/:roomCode', async (req, res) => {
    const { roomCode } = req.params;
    console.log(`[API] 📥 POST /api/admin/start-tournament/${roomCode} получен`);

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const token = authHeader.split(' ')[1];
    const admin = await verifyAdmin(token);
    if (!admin) {
        return res.status(403).json({ error: 'Доступ только для администраторов' });
    }

    const client = await pool.connect();
    try {
        // Получаем lifetime_minutes
        const tournament = await client.query(
            'SELECT lifetime_minutes FROM tournaments WHERE room_code = $1',
            [roomCode]
        );
        
        if (tournament.rows.length === 0) {
            return res.status(404).json({ error: 'Турнир не найден' });
        }
        
        const lifetimeMinutes = tournament.rows[0].lifetime_minutes;
        
        // Устанавливаем end_time в UTC
        const endTime = new Date();
        endTime.setUTCMinutes(endTime.getUTCMinutes() + lifetimeMinutes);
        
        console.log(`[API] Текущее UTC: ${new Date().toISOString()}`);
        console.log(`[API] lifetime_minutes: ${lifetimeMinutes}`);
        console.log(`[API] end_time UTC: ${endTime.toISOString()}`);
        
        const result = await client.query(
            'UPDATE tournaments SET status = $1, end_time = $2 WHERE room_code = $3 AND status = $4 RETURNING end_time',
            ['active', endTime, roomCode, 'waiting']
        );
        
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Турнир не найден или уже начат' });
        }
        
        const endTimeISO = result.rows[0].end_time.toISOString();
        
        io.to(`player_${roomCode}`).emit('tournament_started', { end_time: endTimeISO });
        io.to(`admin_${roomCode}`).emit('tournament_started');
        
        console.log(`[API] ✅ Турнир ${roomCode} начат, окончание: ${endTimeISO}`);
        res.json({ success: true, end_time: endTimeISO });
    } catch (err) {
        console.error('[API] ❌ Ошибка старта турнира:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/api/admin/end-tournament/:roomCode', async (req, res) => {
    const { roomCode } = req.params;
    console.log(`[API] 📥 POST /api/admin/end-tournament/${roomCode} получен`);

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const token = authHeader.split(' ')[1];
    const admin = await verifyAdmin(token);
    if (!admin) {
        return res.status(403).json({ error: 'Доступ только для администраторов' });
    }

    const client = await pool.connect();
    try {
        await client.query('UPDATE tournaments SET status = $1 WHERE room_code = $2', ['finished', roomCode]);
        io.to(`player_${roomCode}`).emit('tournament_ended');
        io.to(`admin_${roomCode}`).emit('tournament_ended');
        console.log(`[API] ✅ Турнир ${roomCode} завершён`);
        res.json({ success: true });
    } finally {
        client.release();
    }
});

app.get('/api/admin/export-tournament/:roomCode', async (req, res) => {
    const { roomCode } = req.params;
    console.log(`[API] 📥 GET /api/admin/export-tournament/${roomCode} получен`);

    const client = await pool.connect();
    try {
        const tournamentInfo = await client.query(
            'SELECT room_code, game_name FROM tournaments WHERE room_code = $1',
            [roomCode]
        );

        if (tournamentInfo.rows.length === 0) {
            return res.status(404).json({ error: 'Турнир не найден' });
        }

        const tournament = tournamentInfo.rows[0];
        const playersResult = await client.query(
            `SELECT tp.nickname, tp.best_score, tp.attempts, p.full_name
             FROM tournament_players tp
             LEFT JOIN players p ON tp.nickname = p.username
             WHERE tp.tournament_id = $1
             ORDER BY tp.best_score DESC`,
            [roomCode]
        );

        let csv = "Название турнира;Код комнаты;ФИО участника;Ник участника;Результат (метры);Попытки\n";
        
        for (const row of playersResult.rows) {
            const fullName = row.full_name || row.nickname;
            csv += `${tournament.game_name};${tournament.room_code};${fullName};${row.nickname};${row.best_score};${row.attempts}\n`;
        }

        if (playersResult.rows.length === 0) {
            csv += `${tournament.game_name};${tournament.room_code};Нет участников;;;\n`;
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="tournament_${roomCode}_results.csv"`);
        res.send('\uFEFF' + csv);
    } catch (err) {
        console.error('[API] ❌ Ошибка экспорта:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// WEBSOCKET ОБРАБОТЧИКИ
// ========================

const tournaments = new Map();

io.on('connection', (socket) => {
    console.log(`[SERVER] Подключился: ${socket.id}`);

    socket.on('join_tournament_admin', (roomCode) => {
        socket.join(`admin_${roomCode}`);
        if (!tournaments.has(roomCode)) {
            tournaments.set(roomCode, { players: new Map(), active: false });
        }
        console.log(`[SERVER] Админ подключился к турниру ${roomCode}`);
        sendTournamentUpdate(roomCode);
    });

    socket.on('join_tournament_player', (roomCode) => {
        socket.join(`player_${roomCode}`);
        if (!tournaments.has(roomCode)) {
            tournaments.set(roomCode, { players: new Map(), active: false });
        }
        console.log(`[SERVER] Игрок подключился к турниру ${roomCode}`);
        sendTournamentUpdate(roomCode);
    });

    socket.on('submit_score', async (data) => {
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

        // Сохраняем в базу с обработкой ошибок
        try {
            await pool.query(
                `INSERT INTO tournament_players (tournament_id, nickname, best_score, attempts)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (tournament_id, nickname) 
                 DO UPDATE SET best_score = EXCLUDED.best_score, attempts = EXCLUDED.attempts`,
                [roomCode, nickname, player.best_score, player.attempts]
            );
            console.log(`[DB] ✅ Результат сохранён: ${nickname} - ${player.best_score}м`);
        } catch (err) {
            console.error('[DB] ❌ Ошибка сохранения:', err);
        }

        sendTournamentUpdate(roomCode);
    });

    socket.on('leave_tournament', (roomCode) => {
        socket.leave(`player_${roomCode}`);
        socket.leave(`admin_${roomCode}`);
        console.log(`[SERVER] Пользователь покинул турнир ${roomCode}`);
    });

    socket.on('disconnect', () => {
        console.log(`[SERVER] Отключился: ${socket.id}`);
    });
});

function sendTournamentUpdate(roomCode) {
    const tournament = tournaments.get(roomCode);
    if (!tournament) return;

    const players = Array.from(tournament.players.entries())
        .map(([nickname, data]) => ({
            nickname,
            best_score: data.best_score,
            attempts: data.attempts
        }))
        .sort((a, b) => b.best_score - a.best_score);

    io.to(`admin_${roomCode}`).emit('tournament_update', players);
    io.to(`player_${roomCode}`).emit('tournament_update', players);
}

// ========================
// ЗАПУСК СЕРВЕРА
// ========================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[SERVER] Сервер запущен на порту ${PORT}`);
    console.log(`[SERVER] Текущее UTC время: ${new Date().toISOString()}`);
});