const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
app.use(cors());

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error('КРИТИЧЕСКАЯ ОШИБКА: Переменная окружения MONGODB_URI не задана в Secrets!');
} else {
    mongoose.connect(MONGODB_URI)
        .then(() => console.log('Успешное подключение к MongoDB Atlas'))
        .catch(err => console.error('Ошибка подключения к БД:', err));
}

// ================= СХЕМЫ БАЗЫ ДАННЫХ =================

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    avatarUrl: { type: String, default: '' }
});
const User = mongoose.model('GigaUser', UserSchema);

// Схема для хранения сессий устройств
const SessionSchema = new mongoose.Schema({
    username: { type: String, required: true },
    token: { type: String, required: true, unique: true },
    userAgent: { type: String, default: 'Unknown Device' },
    ip: { type: String, default: '0.0.0.0' },
    lastSeen: { type: Date, default: Date.now }
});
const Session = mongoose.model('GigaSession', SessionSchema);

const ChatSchema = new mongoose.Schema({
    participants: [{ type: String }]
});
const Chat = mongoose.model('GigaChat', ChatSchema);

const MessageSchema = new mongoose.Schema({
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'GigaChat', required: true },
    sender: { type: String, required: true },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('GigaMessage', MessageSchema);

const FriendshipSchema = new mongoose.Schema({
    sender: { type: String, required: true },
    receiver: { type: String, required: true },
    status: { type: String, enum: ['pending', 'accepted'], default: 'pending' }
});
const Friendship = mongoose.model('GigaFriendship', FriendshipSchema);

// Middleware для валидации токена сессии
async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Токен отсутствует' });

    try {
        const session = await Session.findOne({ token });
        if (!session) return res.status(403).json({ error: 'Сессия недействительна или завершена' });
        
        // Обновляем IP и время активности при запросе
        session.ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || session.ip;
        session.lastSeen = new Date();
        await session.save();

        req.username = session.username;
        req.token = token;
        next();
    } catch (e) {
        res.status(500).json({ error: 'Ошибка аутентификации' });
    }
}

// ================= HTTP ЭНДПОИНТЫ =================

app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const defaultAvatar = `letter:${username}`;
        
        const newUser = new User({ username, password: hashedPassword, avatarUrl: defaultAvatar });
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

        // Создаем долговечный токен устройства
        const token = crypto.randomBytes(32).toString('hex');
        const userAgent = req.headers['user-agent'] || 'Unknown Device';
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '0.0.0.0';

        const newSession = new Session({ username: user.username, token, userAgent, ip });
        await newSession.save();

        res.json({ 
            username: user.username, 
            avatarUrl: user.avatarUrl || `letter:${user.username}`,
            token: token
        });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Проверка существующей сессии при загрузке страницы
app.post('/api/auth/verify', authenticateToken, async (req, res) => {
    try {
        const user = await User.findOne({ username: req.username });
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        res.json({ username: user.username, avatarUrl: user.avatarUrl || `letter:${user.username}`, token: req.token });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка проверки сессии' });
    }
});

// Выход из конкретной сессии
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    try {
        await Session.deleteOne({ token: req.token });
        res.json({ message: 'Выход совершен успешно' });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка выхода' });
    }
});

// Получение списка всех устройств/сессий пользователя
app.get('/api/security/devices', authenticateToken, async (req, res) => {
    try {
        const sessions = await Session.find({ username: req.username }).sort({ lastSeen: -1 });
        const devices = sessions.map(s => ({
            id: s._id,
            userAgent: s.userAgent,
            ip: s.ip,
            lastSeen: s.lastSeen,
            isCurrent: s.token === req.token
        }));
        res.json(devices);
    } catch (e) {
        res.status(500).json({ error: 'Ошибка получения устройств' });
    }
});

// Удаление сессии конкретного устройства
app.delete('/api/security/devices/:id', authenticateToken, async (req, res) => {
    try {
        const targetSession = await Session.findById(req.params.id);
        if (!targetSession || targetSession.username !== req.username) {
            return res.status(404).json({ error: 'Сессия не найдена' });
        }
        
        await Session.findByIdAndDelete(req.params.id);
        res.json({ message: 'Устройство успешно отключено' });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка удаления устройства' });
    }
});

app.post('/api/user/profile', async (req, res) => {
    try {
        const { username } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        
        res.json({ username: user.username, avatarUrl: user.avatarUrl || `letter:${user.username}` });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/user/relationship', async (req, res) => {
    try {
        const { myUsername, targetUsername } = req.body;
        const rel = await Friendship.findOne({
            $or: [
                { sender: myUsername, receiver: targetUsername },
                { sender: targetUsername, receiver: myUsername }
            ]
        });

        if (!rel) return res.json({ status: 'none' });
        if (rel.status === 'accepted') return res.json({ status: 'friends' });
        if (rel.sender === myUsername) return res.json({ status: 'sent' });
        return res.json({ status: 'received', requestId: rel._id });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка проверки отношений' });
    }
});

app.post('/api/search-users', async (req, res) => {
    try {
        const { username } = req.body;
        const user = await User.findOne({ username: username.trim() });
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        res.json({ username: user.username, avatarUrl: user.avatarUrl || `letter:${user.username}` });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка поиска' });
    }
});

app.post('/api/chats', async (req, res) => {
    try {
        const { myUsername, targetUsername } = req.body;

        if (targetUsername) {
            let chat = await Chat.findOne({
                participants: { $all: [myUsername, targetUsername] }
            });
            if (!chat) {
                chat = new Chat({ participants: [myUsername, targetUsername] });
                await chat.save();
            }
            return res.json(chat);
        } 
        
        const myChats = await Chat.find({ participants: myUsername });
        if (!myChats || myChats.length === 0) return res.json([]);

        const chatsWithDetails = await Promise.all(myChats.map(async (chat) => {
            const participants = chat.participants || [];
            const targetUser = participants.find(p => p !== myUsername) || myUsername;
            const userDoc = await User.findOne({ username: targetUser });
            
            return {
                _id: chat._id,
                participants: participants,
                targetUser: targetUser,
                avatarUrl: userDoc && userDoc.avatarUrl ? userDoc.avatarUrl : `letter:${targetUser}`
            };
        }));

        res.json(chatsWithDetails);
    } catch (error) {
        console.error("Ошибка в эндпоинте /api/chats:", error);
        res.status(500).json({ error: 'Ошибка при работе с чатами' });
    }
});

app.post('/api/friends/request', async (req, res) => {
    try {
        const { myUsername, targetUsername } = req.body;
        if (myUsername === targetUsername) return res.status(400).json({ error: 'Нельзя добавить себя' });

        const existing = await Friendship.findOne({
            $or: [ { sender: myUsername, receiver: targetUsername }, { sender: targetUsername, receiver: myUsername } ]
        });

        if (existing) {
            if (existing.status === 'accepted') return res.status(400).json({ error: 'Вы уже друзья' });
            if (existing.sender === myUsername) return res.status(400).json({ error: 'Заявка уже отправлена' });
            return res.status(400).json({ error: 'У вас есть входящая заявка от него' });
        }

        const newRequest = new Friendship({ sender: myUsername, receiver: targetUsername, status: 'pending' });
        await newRequest.save();
        res.json({ message: 'Заявка успешно отправлена' });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка отправки заявки' });
    }
});

app.post('/api/friends/requests/incoming', async (req, res) => {
    try {
        const { myUsername } = req.body;
        const requests = await Friendship.find({ receiver: myUsername, status: 'pending' });
        
        const detailedRequests = await Promise.all(requests.map(async (r) => {
            const senderUser = await User.findOne({ username: r.sender });
            return {
                _id: r._id,
                sender: r.sender,
                avatarUrl: senderUser && senderUser.avatarUrl ? senderUser.avatarUrl : `letter:${r.sender}`
            };
        }));
        
        res.json(detailedRequests);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка получения заявок' });
    }
});

app.post('/api/friends/respond', async (req, res) => {
    try {
        const { requestId, action } = req.body;
        const request = await Friendship.findById(requestId);
        if (!request) return res.status(404).json({ error: 'Заявка не найдена' });

        if (action === 'accept') {
            request.status = 'accepted';
            await request.save();
            res.json({ message: 'Заявка принята' });
        } else if (action === 'reject') {
            await Friendship.findByIdAndDelete(requestId);
            res.json({ message: 'Заявка отклонена' });
        } else {
            res.status(400).json({ error: 'Неверное действие' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Ошибка обработки заявки' });
    }
});

app.post('/api/friends/list', async (req, res) => {
    try {
        const { myUsername } = req.body;
        const friendships = await Friendship.find({
            $or: [{ sender: myUsername }, { receiver: myUsername }],
            status: 'accepted'
        });

        const friendNames = friendships.map(f => f.sender === myUsername ? f.receiver : f.sender);
        
        const friendsWithAvatars = await Promise.all(friendNames.map(async (name) => {
            const fUser = await User.findOne({ username: name });
            return {
                username: name,
                avatarUrl: fUser && fUser.avatarUrl ? fUser.avatarUrl : `letter:${name}`
            };
        }));

        res.json(friendsWithAvatars);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка получения списка друзей' });
    }
});

app.post('/api/settings/update-avatar', async (req, res) => {
    try {
        const { username, avatarUrl } = req.body;
        if (!avatarUrl) return res.status(400).json({ error: 'Укажите аватарку или файл' });

        const user = await User.findOneAndUpdate({ username }, { avatarUrl }, { new: true });
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

        res.json({ message: 'Аватарка успешно обновлена', avatarUrl: user.avatarUrl });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка обновления аватарки' });
    }
});

app.post('/api/settings/change-password', async (req, res) => {
    try {
        const { username, oldPassword, newPassword } = req.body;
        if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Заполните все поля' });

        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) return res.status(400).json({ error: 'Неверный старый пароль' });

        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

        res.json({ message: 'Пароль успешно изменен' });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка смены пароля' });
    }
});

// ================= ВЕБ-СОКЕТЫ =================
io.on('connection', (socket) => {
    console.log('Подключился к GIGA сети:', socket.id);

    socket.on('join_chat', async ({ chatId }) => {
        const rooms = Array.from(socket.rooms);
        rooms.forEach(room => {
            if (room !== socket.id) socket.leave(room);
        });
        socket.join(chatId);

        try {
            const history = await Message.find({ chatId }).sort({ timestamp: -1 }).limit(100);
            socket.emit('load_history', history.reverse());
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('send_message', async (data) => {
        try {
            const { chatId, sender, text } = data;
            const newMessage = new Message({ chatId, sender, text });
            await newMessage.save();
            io.to(chatId).emit('receive_message', newMessage);
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('disconnect', () => {
        console.log('Пользователь отключился:', socket.id);
    });
});

const PORT = 7860;
server.listen(PORT, '0.0.0.0', () => console.log(`GIGA Сервер успешно запущен на порту ${PORT}`));