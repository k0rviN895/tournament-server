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
// ОТКЛЮЧАЕМ SSL ПРОВЕРКУ ДЛЯ TIGERDATA
// ========================

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ========================
// ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ (TigerData)
// ========================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,
        require: false
    }
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
// НАСТРОЙКА EMAIL (SENDSAY)
// ========================

const SENDS_API_KEY = '18W37LhemdLzoElNUJZRj4qkHsuoK6k_nxEU1rX_aO8TButz9mrGA59fXAq_mpZLO3hVRs-8792gmeE03LhwIWw';
const SENDS_FROM_EMAIL = process.env.SENDSAY_FROM_EMAIL || 'debuggerurfu@gmail.com';
const SENDS_FROM_NAME = process.env.SENDSAY_FROM_NAME || 'DEBUGGER Game';

console.log('[EMAIL] Sendsay API Key set:', !!SENDS_API_KEY);
console.log('[EMAIL] Отправитель:', SENDS_FROM_EMAIL);

// ========================
// ОТПРАВКА ПИСЕМ ЧЕРЕЗ SENDSAY (ИСПРАВЛЕННАЯ ВЕРСИЯ)
// ========================

async function sendVerificationEmail(email, token) {
    try {
        const serverUrl = process.env.SERVER_URL || 'https://your-server.onrender.com';
        const verificationLink = `${serverUrl}/api/verify-email?token=${token}`;
        
        const html = `
            <h1>Подтверждение регистрации</h1>
            <p>Для завершения регистрации в игре DEBUGGER нажмите на кнопку ниже:</p>
            <a href="${verificationLink}" 
               style="display:inline-block; padding:12px 24px; background:#4CAF50; color:white; text-decoration:none; border-radius:4px; font-size:16px;">
                ✅ Подтвердить почту
            </a>
            <p>Или перейдите по ссылке:</p>
            <p><a href="${verificationLink}">${verificationLink}</a></p>
            <p>Ссылка действительна в течение 24 часов.</p>
            <p>Если вы не регистрировались в игре, просто проигнорируйте это письмо.</p>
        `;

        // Правильный формат для Sendsay API
        const requestBody = {
            action: 'issue.send',
            apikey: SENDS_API_KEY,
            email: {
                from: {
                    email: SENDS_FROM_EMAIL,
                    name: SENDS_FROM_NAME
                },
                to: [{ email: email }],
                subject: 'Подтверждение регистрации в DEBUGGER',
                message: {
                    html: html
                }
            }
        };

        // Отправляем POST-запрос с правильным Content-Type
        const response = await fetch('https://api.sendsay.ru/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const data = await response.json();

        if (data && data.status === 'ok') {
            console.log(`[EMAIL] ✅ Письмо отправлено на ${email} через Sendsay`);
            return true;
        } else if (data && data.errors) {
            console.error('[EMAIL] ❌ Ошибка Sendsay:', data.errors);
            // Если ошибка "unsupportedapiversion", пробуем другой формат
            if (data.errors.some(e => e.id === 'error/api/unsupportedapiversion')) {
                console.log('[EMAIL] 🔄 Пробуем альтернативный формат...');
                return await sendVerificationEmailAlt(email, token);
            }
            return false;
        } else {
            console.error('[EMAIL] ❌ Неизвестный ответ Sendsay:', data);
            return false;
        }
    } catch (err) {
        console.error('[EMAIL] ❌ Ошибка отправки письма через Sendsay:', err.message);
        return false;
    }
}

// Альтернативный метод (через URL-encoded параметры)
async function sendVerificationEmailAlt(email, token) {
    try {
        const serverUrl = process.env.SERVER_URL || 'https://your-server.onrender.com';
        const verificationLink = `${serverUrl}/api/verify-email?token=${token}`;
        
        const html = `
            <h1>Подтверждение регистрации</h1>
            <p>Для завершения регистрации в игре DEBUGGER нажмите на кнопку ниже:</p>
            <a href="${verificationLink}" 
               style="display:inline-block; padding:12px 24px; background:#4CAF50; color:white; text-decoration:none; border-radius:4px; font-size:16px;">
                ✅ Подтвердить почту
            </a>
            <p>Или перейдите по ссылке:</p>
            <p><a href="${verificationLink}">${verificationLink}</a></p>
            <p>Ссылка действительна в течение 24 часов.</p>
        `;

        const params = new URLSearchParams();
        params.append('action', 'issue.send');
        params.append('apikey', SENDS_API_KEY);
        params.append('from.email', SENDS_FROM_EMAIL);
        params.append('from.name', SENDS_FROM_NAME);
        params.append('to[0]', email);
        params.append('subject', 'Подтверждение регистрации в DEBUGGER');
        params.append('message.html', html);

        const response = await fetch('https://api.sendsay.ru/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params
        });

        const data = await response.json();

        if (data && data.status === 'ok') {
            console.log(`[EMAIL] ✅ Письмо отправлено на ${email} через Sendsay (alt)`);
            return true;
        } else {
            console.error('[EMAIL] ❌ Ошибка Sendsay (alt):', data);
            return false;
        }
    } catch (err) {
        console.error('[EMAIL] ❌ Ошибка отправки письма через Sendsay (alt):', err.message);
        return false;
    }
}

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
            email_confirmed BOOLEAN DEFAULT FALSE,
            email_verification_token TEXT,
            email_verification_sent_at TIMESTAMP,
            reset_token TEXT,
            reset_token_sent_at TIMESTAMP,
            last_login TIMESTAMP DEFAULT NOW(),
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

    const createUserAchievementsTable = `
        CREATE TABLE IF NOT EXISTS user_achievements (
            id SERIAL PRIMARY KEY,
            user_id INT REFERENCES players(id) ON DELETE CASCADE,
            achievement_id VARCHAR(50) NOT NULL,
            unlocked_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id, achievement_id)
        );
    `;

    const createPlayerRunsTable = `
        CREATE TABLE IF NOT EXISTS player_runs (
            id SERIAL PRIMARY KEY,
            user_id INT REFERENCES players(id) ON DELETE CASCADE,
            run_date DATE DEFAULT CURRENT_DATE,
            score INT DEFAULT 0,
            coins INT DEFAULT 0,
            deaths INT DEFAULT 0,
            character_id VARCHAR(50) DEFAULT '',
            is_perfect BOOLEAN DEFAULT FALSE
        );
    `;

    try {
        await pool.query(createPlayersTable);
        await pool.query(createStatsTable);
        await pool.query(createTournamentsTable);
        await pool.query(createTournamentPlayersTable);
        await pool.query(createLeaderboardTable);
        await pool.query(createUserAchievementsTable);
        await pool.query(createPlayerRunsTable);

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

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_user_achievements_user_id ON user_achievements (user_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_player_runs_user_date ON player_runs (user_id, run_date);
        `);

        await pool.query(`
            UPDATE players SET email_confirmed = TRUE WHERE email IS NOT NULL;
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

async function checkAndUnlockAchievement(client, userId, achievementId) {
    const check = await client.query(
        'SELECT id FROM user_achievements WHERE user_id = $1 AND achievement_id = $2',
        [userId, achievementId]
    );

    if (check.rows.length === 0) {
        await client.query(
            'INSERT INTO user_achievements (user_id, achievement_id) VALUES ($1, $2)',
            [userId, achievementId]
        );
        console.log(`[API] Достижение ${achievementId} разблокировано для пользователя ${userId}`);
        return true;
    }
    return false;
}

// ========================
// API ДЛЯ РЕГИСТРАЦИИ
// ========================

app.post('/api/register', async (req, res) => {
    console.log('[API] POST /api/register получен');
    const { full_name, username, email, password, vuz } = req.body;

    if (!full_name || !username || !email || !password) {
        return res.status(400).json({ error: 'Все поля обязательны' });
    }

    const client = await pool.connect();

    try {
        const check = await client.query(
            'SELECT id, email_confirmed FROM players WHERE username = $1 OR email = $2',
            [username, email]
        );

        if (check.rows.length > 0) {
            return res.status(409).json({ error: 'Имя пользователя или email уже заняты' });
        }

        const password_hash = await bcrypt.hash(password, 10);
        const userVuz = vuz || '';

        const token = crypto.randomBytes(32).toString('hex');
        const tokenSentAt = new Date();

        const result = await client.query(
            `INSERT INTO players (full_name, username, email, password_hash, role, vuz, 
             email_confirmed, email_verification_token, email_verification_sent_at)
             VALUES ($1, $2, $3, $4, 'user', $5, FALSE, $6, $7) RETURNING id`,
            [full_name, username, email, password_hash, userVuz, token, tokenSentAt]
        );

        const userId = result.rows[0].id;
        console.log(`[API] Пользователь создан с id=${userId}, ожидает подтверждения`);

        await client.query('INSERT INTO player_stats (user_id, max_score, attempts_count) VALUES ($1, 0, 0)', [userId]);

        await sendVerificationEmail(email, token);

        res.status(201).json({
            success: true,
            message: 'Регистрация успешна! Подтвердите почту по ссылке в письме.',
            requiresVerification: true,
            userId: userId
        });

    } catch (err) {
        console.error('[API] Ошибка регистрации:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// API ДЛЯ ВХОДА
// ========================

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

        if (!user.email_confirmed) {
            return res.status(403).json({
                error: 'Почта не подтверждена',
                requiresVerification: true,
                message: 'Подтвердите почту по ссылке в письме'
            });
        }

        await client.query('UPDATE players SET last_login = NOW() WHERE id = $1', [user.id]);

        const secret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
        const token = jwt.sign(
            { userId: user.id, username: user.username, role: user.role },
            secret,
            { expiresIn: '30d' }
        );

        res.json({ token, userId: user.id, username: user.username, role: user.role });

    } catch (err) {
        console.error('[API] Ошибка входа:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

// ========================
// ПОДТВЕРЖДЕНИЕ ПОЧТЫ ПО ССЫЛКЕ
// ========================

app.get('/api/verify-email', async (req, res) => {
    console.log('[API] GET /api/verify-email получен');
    const { token } = req.query;

    if (!token) {
        return res.status(400).send('❌ Токен не указан');
    }

    const client = await pool.connect();

    try {
        const result = await client.query(
            'SELECT id, email_verification_token, email_verification_sent_at FROM players WHERE email_verification_token = $1',
            [token]
        );

        if (result.rows.length === 0) {
            return res.status(404).send('❌ Неверный или просроченный токен');
        }

        const user = result.rows[0];

        const sentAt = new Date(user.email_verification_sent_at);
        const now = new Date();
        const hoursDiff = (now - sentAt) / (1000 * 60 * 60);

        if (hoursDiff > 24) {
            return res.status(400).send('❌ Ссылка истекла. Запросите новую.');
        }

        await client.query(
            'UPDATE players SET email_confirmed = TRUE, email_verification_token = NULL WHERE id = $1',
            [user.id]
        );

        console.log(`[API] ✅ Почта пользователя ${user.id} подтверждена`);

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Почта подтверждена</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                    .container { max-width: 500px; margin: 0 auto; }
                    .success { color: #4CAF50; font-size: 48px; }
                    h1 { color: #333; }
                    p { color: #666; font-size: 18px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="success">✅</div>
                    <h1>Почта успешно подтверждена!</h1>
                    <p>Теперь вы можете войти в игру DEBUGGER.</p>
                    <p>Вернитесь в игру и авторизуйтесь.</p>
                </div>
            </body>
            </html>
        `);

    } catch (err) {
        console.error('[API] Ошибка подтверждения почты:', err);
        res.status(500).send('❌ Ошибка сервера');
    } finally {
        client.release();
    }
});

// ========================
// ВОССТАНОВЛЕНИЕ ПАРОЛЯ
// ========================

app.post('/api/forgot-password', async (req, res) => {
    console.log('[API] POST /api/forgot-password получен');
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Введите email' });
    }

    const client = await pool.connect();

    try {
        const result = await client.query(
            'SELECT id, email_confirmed FROM players WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Пользователь с таким email не найден' });
        }

        const user = result.rows[0];

        if (!user.email_confirmed) {
            return res.status(400).json({ error: 'Почта не подтверждена. Сначала подтвердите почту.' });
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const tokenSentAt = new Date();

        await client.query(
            'UPDATE players SET reset_token = $1, reset_token_sent_at = $2 WHERE id = $3',
            [code, tokenSentAt, user.id]
        );

        await sendResetCodeEmail(email, code);

        res.json({
            success: true,
            userId: user.id,
            message: 'Код для восстановления отправлен на почту'
        });

    } catch (err) {
        console.error('[API] Ошибка восстановления пароля:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/api/reset-password', async (req, res) => {
    console.log('[API] POST /api/reset-password получен');
    const { userId, token, newPassword } = req.body;

    if (!userId || !token || !newPassword) {
        return res.status(400).json({ error: 'Не хватает данных' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
    }

    const client = await pool.connect();

    try {
        const result = await client.query(
            'SELECT reset_token, reset_token_sent_at FROM players WHERE id = $1',
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        const user = result.rows[0];

        if (user.reset_token !== token) {
            return res.status(400).json({ error: 'Неверный код восстановления' });
        }

        const tokenSentAt = new Date(user.reset_token_sent_at);
        const now = new Date();
        const hoursDiff = (now - tokenSentAt) / (1000 * 60 * 60);

        if (hoursDiff > 1) {
            return res.status(400).json({ error: 'Код истёк. Запросите новый.' });
        }

        const password_hash = await bcrypt.hash(newPassword, 10);

        await client.query(
            'UPDATE players SET password_hash = $1, reset_token = NULL WHERE id = $2',
            [password_hash, userId]
        );

        console.log(`[API] Пароль пользователя ${userId} успешно сброшен`);

        res.json({ success: true, message: 'Пароль успешно изменён' });

    } catch (err) {
        console.error('[API] Ошибка сброса пароля:', err);
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
             VALUES ($1, $2, $3, $4, $5, 'waiting') RETURNING id`,
            [room_code, safeGameName, admin.userId, max_players, lifetime_minutes]
        );

        res.status(201).json({
            success: true,
            tournament_id: result.rows[0].id,
            room_code: room_code,
            message: 'Турнир создан'
        });
    } catch (err) {
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
// API ДЛЯ ДОСТИЖЕНИЙ
// ========================

app.get('/api/achievements/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const client = await pool.connect();

    try {
        const result = await client.query(
            'SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = $1',
            [userId]
        );

        const playerData = await client.query(
            `SELECT last_login,
             (SELECT COUNT(*) FROM player_runs WHERE user_id = $1) as total_runs,
             (SELECT COUNT(*) FROM player_runs WHERE user_id = $1 AND is_perfect = TRUE) as perfect_runs,
             (SELECT COUNT(*) FROM player_runs WHERE user_id = $1 AND run_date = CURRENT_DATE) as today_runs,
             (SELECT COUNT(*) FROM user_achievements WHERE user_id = $1) as total_achievements
             FROM players WHERE id = $1`,
            [userId]
        );

        const achievements = result.rows.map(row => row.achievement_id);
        const data = playerData.rows[0] || {};

        res.json({
            unlocked: achievements,
            last_login: data.last_login,
            total_runs: parseInt(data.total_runs) || 0,
            perfect_runs: parseInt(data.perfect_runs) || 0,
            today_runs: parseInt(data.today_runs) || 0,
            total_achievements: parseInt(data.total_achievements) || 0
        });
    } catch (err) {
        console.error('[API] Ошибка получения достижений:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/api/achievements/unlock', async (req, res) => {
    const { userId, achievementId } = req.body;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    if (!userId || !achievementId) {
        return res.status(400).json({ error: 'Не хватает данных' });
    }

    const client = await pool.connect();

    try {
        const check = await client.query(
            'SELECT id FROM user_achievements WHERE user_id = $1 AND achievement_id = $2',
            [userId, achievementId]
        );

        if (check.rows.length > 0) {
            return res.json({ success: true, already_unlocked: true });
        }

        await client.query(
            'INSERT INTO user_achievements (user_id, achievement_id) VALUES ($1, $2)',
            [userId, achievementId]
        );

        console.log(`[API] Достижение ${achievementId} разблокировано для пользователя ${userId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[API] Ошибка разблокировки достижения:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/api/achievements/save-run', async (req, res) => {
    const { userId, score, coins, deaths, characterId } = req.body;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const client = await pool.connect();

    try {
        const isPerfect = score >= 1000;

        await client.query(
            `INSERT INTO player_runs (user_id, run_date, score, coins, deaths, character_id, is_perfect)
             VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)`,
            [userId, score, coins, deaths, characterId, isPerfect]
        );

        const todayRuns = await client.query(
            'SELECT COUNT(*) as count FROM player_runs WHERE user_id = $1 AND run_date = CURRENT_DATE',
            [userId]
        );

        if (parseInt(todayRuns.rows[0].count) >= 24) {
            await checkAndUnlockAchievement(client, userId, 'hackathon');
        }

        const perfectRuns = await client.query(
            `SELECT COUNT(*) as count FROM player_runs
             WHERE user_id = $1 AND is_perfect = TRUE
             ORDER BY id DESC LIMIT 15`,
            [userId]
        );

        if (parseInt(perfectRuns.rows[0].count) >= 15) {
            await checkAndUnlockAchievement(client, userId, 'perfect');
        }

        const lastRuns = await client.query(
            `SELECT character_id FROM player_runs
             WHERE user_id = $1
             ORDER BY id DESC LIMIT 5`,
            [userId]
        );

        if (lastRuns.rows.length >= 5) {
            const firstChar = lastRuns.rows[0].character_id;
            let allSame = true;

            for (const row of lastRuns.rows) {
                if (row.character_id !== firstChar) {
                    allSame = false;
                    break;
                }
            }

            if (allSame && firstChar && firstChar !== '') {
                await checkAndUnlockAchievement(client, userId, 'traditions');
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[API] Ошибка сохранения забега:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/api/achievements/check-vacation', async (req, res) => {
    const { userId } = req.body;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const client = await pool.connect();

    try {
        const result = await client.query(
            'SELECT last_login FROM players WHERE id = $1',
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        const lastLogin = result.rows[0].last_login;
        const now = new Date();
        const diffDays = Math.floor((now - new Date(lastLogin)) / (1000 * 60 * 60 * 24));

        if (diffDays >= 3) {
            await checkAndUnlockAchievement(client, userId, 'vacation');
            res.json({ success: true, unlocked: true, diffDays });
        } else {
            res.json({ success: true, unlocked: false, diffDays });
        }
    } catch (err) {
        console.error('[API] Ошибка проверки отпуска:', err);
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
    console.log(`[SERVER] Текущее UTC время: ${new Date().toISOString()}`);
    console.log(`[EMAIL] Отправка писем через Sendsay с: ${SENDS_FROM_EMAIL}`);
});