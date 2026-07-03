const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// Подключение к MongoDB
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Успешное подключение к MongoDB Atlas'))
    .catch(err => console.error('Ошибка подключения к БД:', err));

// Схемы данных для БД (Ребрендинг под GIGA MESSENGER)
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true }
});
const User = mongoose.model('GigaUser', UserSchema);

const MessageSchema = new mongoose.Schema({
    sender: String,
    text: String,
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('GigaMessage', MessageSchema);

// HTTP Эндпоинты для Регистрации и Входа
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();
        res.status(201).json({ message: 'Пользователь создан' });
    } catch (error) {
        res.status(400).json({ error: 'Имя пользователя уже занято или ошибка данных' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }
        res.json({ username: user.username });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Работа с сокетами
io.on('connection', async (socket) => {
    console.log('Подключился к GIGA чату:', socket.id);

    try {
        const recentMessages = await Message.find().sort({ timestamp: -1 }).limit(50);
        socket.emit('load_history', recentMessages.reverse());
    } catch (err) {
        console.error(err);
    }

    socket.on('send_message', async (data) => {
        const newMessage = new Message({ sender: data.sender, text: data.text });
        await newMessage.save();
        io.emit('receive_message', data);
    });
});

const PORT = 7860;
server.listen(PORT, '0.0.0.0', () => console.log(`GIGA Сервер успешно запущен на порту ${PORT}`));