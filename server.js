const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ======================== БАЗА ДАННЫХ ========================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
    if (err) console.error('[DB] ❌ Ошибка:', err.message);
    else console.log('[DB] ✅ Успешное подключение!');
});

// Вспомогательные функции
async function getRoomPlayers(roomId) {
    const res = await pool.query(
        `SELECT socket_id, nickname, is_ready, finished, distance
         FROM room_players WHERE room_id = $1`,
        [roomId]
    );
    return res.rows;
}

// Автоочистка истекших комнат
setInterval(async () => {
    const result = await pool.query(`DELETE FROM rooms WHERE expires_at < NOW() RETURNING room_id`);
    if (result.rowCount > 0) console.log(`[CLEANUP] Удалено комнат: ${result.rowCount}`);
}, 60000);

// ======================== WEBSOCKET ========================
io.on('connection', (socket) => {
    console.log(`[SERVER] Подключился: ${socket.id}`);

    // СОЗДАНИЕ КОМНАТЫ
    socket.on('create_room', async (data) => {
        const { fullName, nickname, lifetimeMinutes } = data;
        if (!fullName || !nickname || !lifetimeMinutes) {
            socket.emit('error', 'Не все данные переданы');
            return;
        }
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const expiresAt = new Date(Date.now() + lifetimeMinutes * 60000);

        try {
            await pool.query('BEGIN');
            await pool.query(
                `INSERT INTO rooms (room_id, admin_socket_id, expires_at) VALUES ($1, $2, $3)`,
                [roomId, socket.id, expiresAt]
            );
            await pool.query(
                `INSERT INTO room_players (room_id, socket_id, full_name, nickname) VALUES ($1, $2, $3, $4)`,
                [roomId, socket.id, fullName, nickname]
            );
            await pool.query('COMMIT');

            socket.join(roomId);
            socket.emit('room_created', roomId);

            const players = await getRoomPlayers(roomId);
            io.to(roomId).emit('room_update', players.map(p => ({ id: p.socket_id, name: p.nickname, isReady: p.is_ready })));
            console.log(`[SERVER] Комната ${roomId} создана, админ: ${fullName} (${nickname}), истекает через ${lifetimeMinutes} мин`);
        } catch (err) {
            await pool.query('ROLLBACK');
            console.error(err);
            socket.emit('error', 'Не удалось создать комнату');
        }
    });

    // ПРИСОЕДИНЕНИЕ
    socket.on('join_room', async (data) => {
        const { roomId, fullName, nickname } = data;
        if (!roomId || !fullName || !nickname) {
            socket.emit('error', 'Не все данные переданы');
            return;
        }

        try {
            const room = await pool.query(`SELECT room_id FROM rooms WHERE room_id = $1 AND expires_at > NOW()`, [roomId]);
            if (room.rows.length === 0) {
                socket.emit('error', 'Комната не найдена или истекла');
                return;
            }

            await pool.query(
                `INSERT INTO room_players (room_id, socket_id, full_name, nickname) VALUES ($1, $2, $3, $4)`,
                [roomId, socket.id, fullName, nickname]
            );
            socket.join(roomId);
            socket.emit('room_joined', { roomId });

            const players = await getRoomPlayers(roomId);
            io.to(roomId).emit('room_update', players.map(p => ({ id: p.socket_id, name: p.nickname, isReady: p.is_ready })));
            console.log(`[SERVER] ${fullName} (${nickname}) присоединился к ${roomId}`);
        } catch (err) {
            console.error(err);
            socket.emit('error', 'Не удалось присоединиться');
        }
    });

    // ГОТОВНОСТЬ
    socket.on('player_ready', async (roomId) => {
        if (!roomId) return;
        try {
            await pool.query(
                `UPDATE room_players SET is_ready = NOT is_ready WHERE room_id = $1 AND socket_id = $2`,
                [roomId, socket.id]
            );
            const players = await getRoomPlayers(roomId);
            io.to(roomId).emit('room_update', players.map(p => ({ id: p.socket_id, name: p.nickname, isReady: p.is_ready })));
        } catch (err) { console.error(err); }
    });

    // СТАРТ ГОНКИ
    socket.on('start_race', async (roomId) => {
        const room = await pool.query(`SELECT admin_socket_id FROM rooms WHERE room_id = $1`, [roomId]);
        if (room.rows.length === 0 || room.rows[0].admin_socket_id !== socket.id) return;

        const seed = Date.now();
        const startTime = Date.now() + 1;
        await pool.query(`UPDATE rooms SET state = 'countdown', seed = $1, start_time = $2 WHERE room_id = $3`, [seed, startTime, roomId]);

        io.to(roomId).emit('start_countdown', { seed, startServerTime: startTime });
        console.log(`[SERVER] Гонка в ${roomId} стартует мгновенно (seed=${seed})`);
    });

    // ФИНИШ
    socket.on('player_finished', async (data) => {
        const { roomId, distance } = data;
        try {
            await pool.query(`UPDATE room_players SET distance = $1, finished = true WHERE room_id = $2 AND socket_id = $3`, [distance, roomId, socket.id]);

            const players = await getRoomPlayers(roomId);
            const allFinished = players.every(p => p.finished);
            if (allFinished) {
                const results = [...players].sort((a, b) => b.distance - a.distance);
                const winner = results[0];
                const participantsJson = JSON.stringify(results.map(p => ({ name: p.nickname, score: p.distance })));
                await pool.query(
                    `INSERT INTO tournament_results (tournament_id, winner_name, winner_score, participants) VALUES ($1, $2, $3, $4)`,
                    [roomId, winner.nickname, winner.distance, participantsJson]
                );
                io.to(roomId).emit('show_results', results.map(p => ({ name: p.nickname, distance: p.distance })));
                await pool.query(`UPDATE rooms SET state = 'finished' WHERE room_id = $1`, [roomId]);
                console.log(`[SERVER] Гонка ${roomId} завершена, победитель: ${winner.nickname}`);
            }
        } catch (err) { console.error(err); }
    });

    // ВЫХОД
    socket.on('leave_room', async (roomId) => {
        const room = await pool.query(`SELECT admin_socket_id FROM rooms WHERE room_id = $1`, [roomId]);
        if (room.rows.length === 0) return;

        if (socket.id === room.rows[0].admin_socket_id) {
            await pool.query(`DELETE FROM rooms WHERE room_id = $1`, [roomId]);
            io.to(roomId).emit('room_closed', 'Администратор покинул комнату');
        } else {
            await pool.query(`DELETE FROM room_players WHERE room_id = $1 AND socket_id = $2`, [roomId, socket.id]);
            const players = await getRoomPlayers(roomId);
            io.to(roomId).emit('room_update', players.map(p => ({ id: p.socket_id, name: p.nickname, isReady: p.is_ready })));
        }
        socket.leave(roomId);
    });

    // ОТКЛЮЧЕНИЕ
    socket.on('disconnect', async () => {
        const rows = await pool.query(`SELECT room_id FROM room_players WHERE socket_id = $1`, [socket.id]);
        for (const row of rows.rows) {
            await pool.query(`DELETE FROM rooms WHERE room_id = $1 AND admin_socket_id = $2`, [row.room_id, socket.id]);
            await pool.query(`DELETE FROM room_players WHERE socket_id = $1`, [socket.id]);
            io.to(row.room_id).emit('room_closed', 'Администратор отключился');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[SERVER] Запущен на порту ${PORT}`));