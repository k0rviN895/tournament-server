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
        console.error('[DB] Ошибка подключения к TigerData:', err.message);
    } else {
        console.log('[DB] Успешное подключение к TigerData!');
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
            tournament_id VARCHAR(10) REFERENCES tournaments(room_code) ON DELETE CASCADE,
            nickname VARCHAR(50) NOT NULL,
            best_score FLOAT DEFAULT 0,
            attempts INT DEFAULT 0,
            joined_at TIMESTAMP DEFAULT NOW()
        );
    `;

    const createLeaderboardTable = `
        CREATE TABLE IF NOT EXISTS leaderboard (
            id SERIAL PRIMARY KEY,
            user_id INT REFERENCES players(id) ON DELETE CASCADE,
            username VARCHAR(50) NOT NULL,
            full_name VARCHAR(100) NOT NULL,
            best_score FLOAT DEFAULT 0,
            updated_at TIMESTAMP DEFAULT NOW()
        );
    `;

    try {
        await pool.query(createPlayersTable);
        await pool.query(createStatsTable);
        await pool.query(createTournamentsTable);
        await pool.query(createTournamentPlayersTable);
        await pool.query(createLeaderboardTable);

        await pool.query(`
            ALTER TABLE tournament_players DROP CONSTRAINT IF EXISTS tournament_players_tournament_id_nickname_key;
            ALTER TABLE tournament_players ADD CONSTRAINT tournament_players_tournament_id_nickname_key UNIQUE (tournament_id, nickname);
        `);

        await pool.query(`
            ALTER TABLE leaderboard DROP CONSTRAINT IF EXISTS leaderboard_user_id_key;
            ALTER TABLE leaderboard ADD CONSTRAINT leaderboard_user_id_key UNIQUE (user_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_leaderboard_best_score ON leaderboard (best_score DESC);
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
    console.log('[API] POST /api/register получен');
    const { full_name, username, email, password, vuz } = req.body;

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
        const userVuz = vuz || '';

        const result = await client.query(
            `INSERT INTO players (full_name, username, email, password_hash, role, vuz)
             VALUES ($1, $2, $3, $4, 'user', $5) RETURNING id`,
            [full_name, username, email, password_hash, userVuz]
        );

        const userId = result.rows[0].id;
        console.log(`[API] Пользователь создан с id=${userId}`);

        // ===== СОЗДАНИЕ СТАТИСТИКИ =====
        await client.query('INSERT INTO player_stats (user_id, max_score, attempts_count) VALUES ($1, 0, 0)', [userId]);

        const secret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
        const token = jwt.sign({ userId, username, role: 'user' }, secret, { expiresIn: '30d' });

        res.status(201).json({ token, userId, username, role: 'user' });
    } catch (err) {
        console.error('[API] Ошибка регистрации:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/api/login', async (req, res) => {
    console.log('[API] POST /api/login получен');
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
        console.error('[API] Ошибка входа:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// API ДЛЯ ПРОФИЛЯ
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

app.put('/api/user/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    console.log(`[API] PUT /api/user/${userId} получен`);

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
        const secret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
        decoded = jwt.verify(token, secret);
    } catch (err) {
        return res.status(401).json({ error: 'Неверный токен' });
    }

    if (decoded.userId !== userId) {
        return res.status(403).json({ error: 'Доступ запрещён' });
    }

    const { full_name, email, vuz } = req.body;

    if (!full_name || !email) {
        console.log('[API] ФИО или Email отсутствуют');
        return res.status(400).json({ error: 'ФИО и Email обязательны' });
    }

    if (!email.includes('@') || !email.includes('.')) {
        console.log('[API] Неверный формат Email');
        return res.status(400).json({ error: 'Неверный формат Email' });
    }

    const client = await pool.connect();
    try {
        await client.query(
            'UPDATE players SET full_name = $1, email = $2, vuz = $3 WHERE id = $4',
            [full_name, email, vuz || '', userId]
        );

        console.log(`[API] Профиль пользователя ${userId} обновлён`);
        res.json({ success: true, message: 'Профиль обновлён' });
    } catch (err) {
        console.error('[API] Ошибка обновления профиля:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// API ДЛЯ СТАТИСТИКИ
// ========================
app.get('/api/user/:userId/stats', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT user_id, max_score, attempts_count FROM player_stats WHERE user_id = $1',
            [userId]
        );

        if (result.rows.length === 0) {
            await client.query(
                'INSERT INTO player_stats (user_id, max_score, attempts_count) VALUES ($1, 0, 0)',
                [userId]
            );
            return res.json({ user_id: userId, max_score: 0, attempts_count: 0 });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('[API] Ошибка получения статистики:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.put('/api/user/:userId/stats', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const { score } = req.body;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const client = await pool.connect();
    try {
        const existing = await client.query(
            'SELECT attempts_count FROM player_stats WHERE user_id = $1',
            [userId]
        );

        if (existing.rows.length === 0) {
            await client.query(
                'INSERT INTO player_stats (user_id, max_score, attempts_count) VALUES ($1, $2, 1)',
                [userId, score || 0]
            );
        } else {
            await client.query(
                'UPDATE player_stats SET attempts_count = attempts_count + 1, max_score = GREATEST(max_score, $1) WHERE user_id = $2',
                [score || 0, userId]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[API] Ошибка обновления статистики:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// API ДЛЯ СТАТИСТИКИ (БЕЗ АВТОРИЗАЦИИ - ФОРСИРОВАННЫЙ)
// ========================
app.put('/api/user/:userId/stats/force', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const { score } = req.body;

    console.log(`[API] FORCE PUT /api/user/${userId}/stats/force получен, score=${score}`);

    const client = await pool.connect();
    try {
        const existing = await client.query(
            'SELECT attempts_count FROM player_stats WHERE user_id = $1',
            [userId]
        );

        if (existing.rows.length === 0) {
            await client.query(
                'INSERT INTO player_stats (user_id, max_score, attempts_count) VALUES ($1, $2, 1)',
                [userId, score || 0]
            );
        } else {
            await client.query(
                'UPDATE player_stats SET attempts_count = attempts_count + 1, max_score = GREATEST(max_score, $1) WHERE user_id = $2',
                [score || 0, userId]
            );
        }

        console.log(`[API] FORCE Статистика обновлена для userId=${userId}`);
        res.json({ success: true, attempts_count: existing.rows[0]?.attempts_count + 1 || 1 });
    } catch (err) {
        console.error('[API] FORCE Ошибка обновления статистики:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
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

app.get('/api/tournament/players/:roomCode', async (req, res) => {
    const { roomCode } = req.params;

    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT nickname, best_score, attempts
             FROM tournament_players
             WHERE tournament_id = $1
             ORDER BY best_score DESC`,
            [roomCode]
        );

        res.json({ items: result.rows });
    } catch (err) {
        console.error('[API] Ошибка получения игроков:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

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

    const { room_code, game_name, max_players, lifetime_minutes } = req.body;
    const safeGameName = game_name && game_name !== 'undefined' ? game_name : 'Турнир';

    if (!room_code || room_code.length < 4 || room_code.length > 10) {
        return res.status(400).json({ error: 'Код комнаты должен быть от 4 до 10 символов' });
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

        res.status(201).json({ success: true, tournament_id: result.rows[0].id, room_code, message: 'Турнир создан' });
    } catch (err) {
        console.error('[API] Ошибка создания турнира:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/api/admin/start-tournament/:roomCode', async (req, res) => {
    const { roomCode } = req.params;
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
        const tournament = await client.query(
            'SELECT lifetime_minutes FROM tournaments WHERE room_code = $1 AND status = $2',
            [roomCode, 'waiting']
        );

        if (tournament.rows.length === 0) {
            return res.status(404).json({ error: 'Турнир не найден или уже начат' });
        }

        const lifetimeMinutes = tournament.rows[0].lifetime_minutes;
        const now = new Date();
        const endTime = new Date(now.getTime() + (lifetimeMinutes * 60 * 1000));

        const result = await client.query(
            'UPDATE tournaments SET status = $1, end_time = $2 WHERE room_code = $3 AND status = $4 RETURNING end_time',
            ['active', endTime, roomCode, 'waiting']
        );

        const endTimeISO = result.rows[0].end_time.toISOString();
        io.to(`admin_${roomCode}`).emit('tournament_started');

        res.json({ success: true, end_time: endTimeISO });
    } catch (err) {
        console.error('[API] Ошибка старта турнира:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/api/admin/end-tournament/:roomCode', async (req, res) => {
    const { roomCode } = req.params;
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

        res.json({ success: true });
    } catch (err) {
        console.error('[API] Ошибка завершения турнира:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.get('/api/admin/export-tournament/:roomCode', async (req, res) => {
    const { roomCode } = req.params;

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
        console.error('[API] Ошибка экспорта:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// API ДЛЯ МОИХ ИГР (MyGames)
// ========================
app.get('/api/admin/my-tournaments', async (req, res) => {
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
        const result = await client.query(
            `SELECT id, room_code, game_name, status,
                    TO_CHAR(created_at, 'DD.MM.YYYY HH24:MI') as created_date,
                    end_time,
                    max_players
             FROM tournaments
             WHERE admin_id = $1
             ORDER BY created_at DESC`,
            [admin.userId]
        );

        res.json({ items: result.rows });
    } catch (err) {
        console.error('[API] Ошибка получения турниров:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// API ДЛЯ ЛИДЕРБОРДА
// ========================
app.get('/api/leaderboard', async (req, res) => {
    console.log('[API] GET /api/leaderboard получен');

    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT
                ROW_NUMBER() OVER (ORDER BY best_score DESC) as rank,
                username,
                full_name,
                best_score
             FROM leaderboard
             ORDER BY best_score DESC
             LIMIT 100`
        );

        console.log(`[API] Лидерборд отправлен: ${result.rows.length} записей`);
        res.json({ items: result.rows });
    } catch (err) {
        console.error('[API] Ошибка получения лидерборда:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/api/leaderboard/update', async (req, res) => {
    console.log('[API] POST /api/leaderboard/update получен');

    const { userId, username, fullName, score } = req.body;

    if (!userId || !username || score === undefined) {
        console.log('[API] Не хватает данных');
        return res.status(400).json({ error: 'Не хватает данных' });
    }

    console.log(`[API] Обновление лидерборда: ${username} (ID: ${userId}) - ${score}м`);

    const client = await pool.connect();
    try {
        const existing = await client.query(
            'SELECT best_score FROM leaderboard WHERE user_id = $1',
            [userId]
        );

        if (existing.rows.length > 0) {
            const currentBest = existing.rows[0].best_score;
            console.log(`[API] Текущий рекорд: ${currentBest}м`);

            if (score > currentBest) {
                await client.query(
                    'UPDATE leaderboard SET best_score = $1, full_name = $2, updated_at = NOW() WHERE user_id = $3',
                    [score, fullName, userId]
                );
                console.log(`[API] Обновлён рекорд: ${username} - ${score}м (было ${currentBest}м)`);
            } else {
                console.log(`[API] Рекорд не обновлён: ${username} - ${score}м < ${currentBest}м`);
            }
        } else {
            console.log(`[API] Создание новой записи для пользователя ${username}`);
            await client.query(
                'INSERT INTO leaderboard (user_id, username, full_name, best_score, updated_at) VALUES ($1, $2, $3, $4, NOW())',
                [userId, username, fullName, score]
            );
            console.log(`[API] Добавлен новый игрок в лидерборд: ${username} - ${score}м`);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[API] Ошибка обновления лидерборда:', err);
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
    });

    socket.on('join_tournament_player', (roomCode) => {
        socket.join(`player_${roomCode}`);
        if (!tournaments.has(roomCode)) {
            tournaments.set(roomCode, { players: new Map(), active: false });
        }
        console.log(`[SERVER] Игрок подключился к турниру ${roomCode}`);
    });

    socket.on('start_tournament', (roomCode) => {
        const tournament = tournaments.get(roomCode);
        if (tournament) {
            tournament.active = true;
            io.to(`player_${roomCode}`).emit('tournament_started');
            io.to(`admin_${roomCode}`).emit('tournament_started');
            console.log(`[SERVER] Турнир ${roomCode} начат`);
        }
    });

    socket.on('end_tournament', (roomCode) => {
        const tournament = tournaments.get(roomCode);
        if (tournament) {
            tournament.active = false;
            io.to(`player_${roomCode}`).emit('tournament_ended');
            io.to(`admin_${roomCode}`).emit('tournament_ended');
            console.log(`[SERVER] Турнир ${roomCode} завершён`);
        }
    });

    socket.on('pause_tournament', (roomCode) => {
        console.log(`[SERVER] Турнир ${roomCode} поставлен на паузу`);
        io.to(`player_${roomCode}`).emit('tournament_paused');
        io.to(`admin_${roomCode}`).emit('tournament_paused');
    });

    socket.on('resume_tournament', (roomCode) => {
        console.log(`[SERVER] Турнир ${roomCode} возобновлён`);
        io.to(`player_${roomCode}`).emit('tournament_resumed');
        io.to(`admin_${roomCode}`).emit('tournament_resumed');
    });

    socket.on('get_tournament_status', (roomCode) => {
        const tournament = tournaments.get(roomCode);
        const isActive = tournament ? tournament.active : false;
        socket.emit('tournament_status', { active: isActive });
        console.log(`[SERVER] Отправлен статус турнира ${roomCode}: active=${isActive}`);
    });

    socket.on('submit_score', async (data) => {
        const { roomCode, nickname, score, fullName } = data;
        console.log(`[SERVER] Результат: ${nickname} -> ${score} м (турнир ${roomCode})`);

        let tournament = tournaments.get(roomCode);
        if (!tournament) {
            tournament = { players: new Map(), active: false };
            tournaments.set(roomCode, tournament);
        }

        const player = tournament.players.get(nickname) || {
            best_score: 0,
            attempts: 0,
            full_name: fullName || nickname
        };

        player.attempts++;
        player.best_score = Math.max(player.best_score, score);
        if (fullName) {
            player.full_name = fullName;
        }
        tournament.players.set(nickname, player);

        const players = Array.from(tournament.players.entries())
            .map(([n, d]) => ({
                nickname: n,
                full_name: d.full_name || n,
                best_score: d.best_score,
                attempts: d.attempts
            }))
            .sort((a, b) => b.best_score - a.best_score);

        io.to(`admin_${roomCode}`).emit('tournament_update', players);
        io.to(`player_${roomCode}`).emit('tournament_update', players);

        try {
            await pool.query(
                `INSERT INTO tournament_players (tournament_id, nickname, best_score, attempts)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (tournament_id, nickname)
                 DO UPDATE SET best_score = EXCLUDED.best_score, attempts = EXCLUDED.attempts`,
                [roomCode, nickname, player.best_score, player.attempts]
            );
            console.log(`[DB] Результат сохранён: ${nickname} - ${player.best_score}м`);
        } catch (err) {
            console.error('[DB] Ошибка сохранения:', err);
        }
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

// ========================
// ЗАПУСК СЕРВЕРА
// ========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[SERVER] Сервер запущен на порту ${PORT}`);
    console.log(`[SERVER] Адрес: http://localhost:${PORT}`);
});