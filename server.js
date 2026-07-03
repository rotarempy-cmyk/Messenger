const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors()); // Разрешаем запросы с других сайтов (нашего фронтенда)

const server = http.createServer(app);

// Настраиваем Socket.io с поддержкой CORS
const io = new Server(server, {
    cors: {
        origin: "*", // В продакшене лучше указать конкретный URL твоего сайта
        methods: ["GET", "POST"]
    }
});

// Слушаем подключения клиентов
io.on('connection', (socket) => {
    console.log('Пользователь подключился:', socket.id);

    // Слушаем событие отправки сообщения
    socket.on('send_message', (data) => {
        // Пересылаем сообщение ВСЕМ подключенным пользователям
        io.emit('receive_message', data);
    });

    socket.on('disconnect', () => {
        console.log('Пользователь отключился:', socket.id);
    });
});

// Порт для работы (Render сам назначит порт через process.env.PORT)
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});