const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
app.use(cors());

app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ limit: '3mb', extended: true }));

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

// ================= ВАЛИДАЦИЯ ВХОДНЫХ ДАННЫХ =================
// Важно: НИКОГДА не передавать req.body поля напрямую в mongoose-запросы
// без проверки типа — иначе возможна NoSQL-инъекция вида { "$ne": null }.

function isValidString(v, { min = 1, max = 500 } = {}) {
    return typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;
}

// Юзернейм: только буквы/цифры/подчёркивание/дефис, 3-20 символов
const USERNAME_REGEX = /^[a-zA-Zа-яА-ЯёЁ0-9_\-]{3,20}$/;
function isValidUsername(v) {
    return typeof v === 'string' && USERNAME_REGEX.test(v);
}

function isValidPassword(v) {
    return typeof v === 'string' && v.length >= 6 && v.length <= 200;
}

// Аватар — только data-URI картинки, чтобы нельзя было подсунуть
// произвольный URL (трекинг пиксель, деанонимизация по IP при загрузке и т.д.)
function isValidAvatar(v) {
    return typeof v === 'string' && v.startsWith('data:image/') && v.length < 2_500_000;
}

function isValidObjectId(v) {
    return typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
}

// ================= ПРОСТОЙ RATE LIMIT (без доп. зависимостей) =================
// Защита /login и /register от подбора пароля / спам-регистрации.

const rateBuckets = new Map();
function rateLimit(maxAttempts, windowMs) {
    return (req, res, next) => {
        const key = req.ip + ':' + req.path;
        const now = Date.now();
        let bucket = rateBuckets.get(key);
        if (!bucket || now - bucket.start > windowMs) {
            bucket = { count: 0, start: now };
        }
        bucket.count++;
        rateBuckets.set(key, bucket);
        if (bucket.count > maxAttempts) {
            return res.status(429).json({ error: 'Слишком много попыток. Попробуйте через минуту.' });
        }
        next();
    };
}
// Периодическая очистка старых бакетов, чтобы Map не росла бесконечно
setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateBuckets) {
        if (now - bucket.start > 5 * 60 * 1000) rateBuckets.delete(key);
    }
}, 5 * 60 * 1000);

// ================= СХЕМЫ БАЗЫ ДАННЫХ =================

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true, index: true },
    password: { type: String, required: true },
    avatarUrl: { type: String, default: '' }
});
const User = mongoose.model('GigaUser', UserSchema);

const SessionSchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },
    token: { type: String, required: true, unique: true },
    userAgent: { type: String, default: 'Unknown Device' },
    ip: { type: String, default: '0.0.0.0' },
    // TTL-индекс: сессии, к которым не обращались 30 дней, удаляются сами -
    // не остаётся вечных токенов "в никуда".
    lastSeen: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
});
const Session = mongoose.model('GigaSession', SessionSchema);

const ChatSchema = new mongoose.Schema({
    participants: [{ type: String, index: true }]
});
ChatSchema.index({ participants: 1 });
const Chat = mongoose.model('GigaChat', ChatSchema);

const MessageSchema = new mongoose.Schema({
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'GigaChat', required: true },
    sender: { type: String, required: true },
    text: { type: String, required: true, maxlength: 4000 },
    timestamp: { type: Date, default: Date.now }
});
MessageSchema.index({ chatId: 1, timestamp: -1 });
const Message = mongoose.model('GigaMessage', MessageSchema);

const FriendshipSchema = new mongoose.Schema({
    sender: { type: String, required: true, index: true },
    receiver: { type: String, required: true, index: true },
    status: { type: String, enum: ['pending', 'accepted'], default: 'pending' }
});
const Friendship = mongoose.model('GigaFriendship', FriendshipSchema);

// ================= АУТЕНТИФИКАЦИЯ (HTTP) =================
// Username пользователя ВСЕГДА берём из проверенной сессии (req.username),
// а не из тела запроса — иначе любой клиент мог бы действовать от чужого имени.

async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Токен отсутствует' });

    try {
        const session = await Session.findOne({ token });
        if (!session) return res.status(403).json({ error: 'Сессия недействительна или завершена' });

        // Обновляем lastSeen/ip не на КАЖДЫЙ запрос, а не чаще раза в минуту -
        // это сильно снижает число записей в БД при частом опросе с фронта.
        const now = Date.now();
        const currentIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || session.ip;
        if (now - session.lastSeen.getTime() > 60_000 || session.ip !== currentIp) {
            session.ip = currentIp;
            session.lastSeen = new Date();
            await session.save();
        }

        req.username = session.username;
        req.token = token;
        next();
    } catch (e) {
        res.status(500).json({ error: 'Ошибка аутентификации' });
    }
}

// ================= HTTP ЭНДПОИНТЫ =================

app.post('/api/register', rateLimit(15, 60_000), async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!isValidUsername(username)) {
            return res.status(400).json({ error: 'Имя пользователя: 3-20 символов, буквы/цифры/_/-' });
        }
        if (!isValidPassword(password)) {
            return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const defaultAvatar = '';

        const newUser = new User({ username, password: hashedPassword, avatarUrl: defaultAvatar });
        await newUser.save();
        res.status(201).json({ message: 'Пользователь создан' });
    } catch (error) {
        res.status(400).json({ error: 'Имя пользователя уже занято или ошибка данных' });
    }
});

app.post('/api/login', rateLimit(15, 60_000), async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!isValidString(username) || !isValidString(password)) {
            return res.status(400).json({ error: 'Заполните все поля' });
        }

        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

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

app.post('/api/auth/verify', authenticateToken, async (req, res) => {
    try {
        const user = await User.findOne({ username: req.username }).lean();
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        res.json({ username: user.username, avatarUrl: user.avatarUrl || `letter:${user.username}`, token: req.token });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка проверки сессии' });
    }
});

app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    try {
        await Session.deleteOne({ token: req.token });
        res.json({ message: 'Выход совершен успешно' });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка выхода' });
    }
});

app.get('/api/security/devices', authenticateToken, async (req, res) => {
    try {
        const sessions = await Session.find({ username: req.username }).sort({ lastSeen: -1 }).lean();
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

app.delete('/api/security/devices/:id', authenticateToken, async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Некорректный id' });
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

// Требуем логин, чтобы нельзя было анонимно перебирать профили/юзернеймы
app.post('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const { username } = req.body;
        if (!isValidString(username)) return res.status(400).json({ error: 'Некорректные данные' });
        const user = await User.findOne({ username }).lean();
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

        res.json({ username: user.username, avatarUrl: user.avatarUrl || `letter:${user.username}` });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/user/relationship', authenticateToken, async (req, res) => {
    try {
        const myUsername = req.username;
        const { targetUsername } = req.body;
        if (!isValidString(targetUsername)) return res.status(400).json({ error: 'Некорректные данные' });

        const rel = await Friendship.findOne({
            $or: [
                { sender: myUsername, receiver: targetUsername },
                { sender: targetUsername, receiver: myUsername }
            ]
        }).lean();

        if (!rel) return res.json({ status: 'none' });
        if (rel.status === 'accepted') return res.json({ status: 'friends' });
        if (rel.sender === myUsername) return res.json({ status: 'sent' });
        return res.json({ status: 'received', requestId: rel._id });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка проверки отношений' });
    }
});

app.post('/api/search-users', authenticateToken, async (req, res) => {
    try {
        const { username } = req.body;
        if (!isValidString(username)) return res.status(400).json({ error: 'Некорректные данные' });
        const user = await User.findOne({ username: username.trim() }).lean();
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        res.json({ username: user.username, avatarUrl: user.avatarUrl || `letter:${user.username}` });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка поиска' });
    }
});

app.post('/api/chats', authenticateToken, async (req, res) => {
    try {
        const myUsername = req.username;
        const { targetUsername } = req.body;

        if (targetUsername) {
            if (!isValidString(targetUsername)) return res.status(400).json({ error: 'Некорректные данные' });
            let chat = await Chat.findOne({
                participants: { $all: [myUsername, targetUsername] }
            });
            if (!chat) {
                chat = new Chat({ participants: [myUsername, targetUsername] });
                await chat.save();
            }
            return res.json(chat);
        }

        const myChats = await Chat.find({ participants: myUsername }).lean();
        if (!myChats || myChats.length === 0) return res.json([]);

        // Батчим запрос аватаров одним запросом вместо N+1
        const targetNames = myChats.map(chat => {
            const participants = chat.participants || [];
            return participants.find(p => p !== myUsername) || myUsername;
        });
        const users = await User.find({ username: { $in: targetNames } }, 'username avatarUrl').lean();
        const avatarMap = new Map(users.map(u => [u.username, u.avatarUrl]));

        const chatsWithDetails = myChats.map((chat, i) => {
            const targetUser = targetNames[i];
            return {
                _id: chat._id,
                participants: chat.participants || [],
                targetUser,
                avatarUrl: avatarMap.get(targetUser) || `letter:${targetUser}`
            };
        });

        res.json(chatsWithDetails);
    } catch (error) {
        console.error("Ошибка в эндпоинте /api/chats:", error);
        res.status(500).json({ error: 'Ошибка при работе с чатами' });
    }
});

app.post('/api/friends/request', authenticateToken, async (req, res) => {
    try {
        const myUsername = req.username;
        const { targetUsername } = req.body;
        if (!isValidString(targetUsername)) return res.status(400).json({ error: 'Некорректные данные' });
        if (myUsername === targetUsername) return res.status(400).json({ error: 'Нельзя добавить себя' });

        const existing = await Friendship.findOne({
            $or: [{ sender: myUsername, receiver: targetUsername }, { sender: targetUsername, receiver: myUsername }]
        });

        if (existing) {
            if (existing.status === 'accepted') return res.status(400).json({ error: 'Вы уже друзья' });
            if (existing.sender === myUsername) return res.status(400).json({ error: 'Заявка уже отправлена' });
            return res.status(400).json({ error: 'У вас есть входящая заявка от него' });
        }

        const newRequest = new Friendship({ sender: myUsername, receiver: targetUsername, status: 'pending' });
        await newRequest.save();

        // Мгновенно уведомляем адресата через сокет, без ожидания опроса
        io.to(`user:${targetUsername}`).emit('friend_request_incoming');

        res.json({ message: 'Заявка успешно отправлена' });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка отправки заявки' });
    }
});

app.post('/api/friends/requests/incoming', authenticateToken, async (req, res) => {
    try {
        const myUsername = req.username;
        const requests = await Friendship.find({ receiver: myUsername, status: 'pending' }).lean();

        const senderNames = requests.map(r => r.sender);
        const users = await User.find({ username: { $in: senderNames } }, 'username avatarUrl').lean();
        const avatarMap = new Map(users.map(u => [u.username, u.avatarUrl]));

        const detailedRequests = requests.map(r => ({
            _id: r._id,
            sender: r.sender,
            avatarUrl: avatarMap.get(r.sender) || `letter:${r.sender}`
        }));

        res.json(detailedRequests);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка получения заявок' });
    }
});

app.post('/api/friends/respond', authenticateToken, async (req, res) => {
    try {
        const myUsername = req.username;
        const { requestId, action } = req.body;
        if (!isValidObjectId(requestId)) return res.status(400).json({ error: 'Некорректные данные' });

        const request = await Friendship.findById(requestId);
        if (!request) return res.status(404).json({ error: 'Заявка не найдена' });

        // КРИТИЧНО: без этой проверки любой мог принять/отклонить чужую заявку
        if (request.receiver !== myUsername) {
            return res.status(403).json({ error: 'Недоступно' });
        }

        if (action === 'accept') {
            request.status = 'accepted';
            await request.save();
            io.to(`user:${request.sender}`).emit('friend_request_accepted', { by: myUsername });
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

app.post('/api/friends/list', authenticateToken, async (req, res) => {
    try {
        const myUsername = req.username;
        const friendships = await Friendship.find({
            $or: [{ sender: myUsername }, { receiver: myUsername }],
            status: 'accepted'
        }).lean();

        const friendNames = friendships.map(f => f.sender === myUsername ? f.receiver : f.sender);
        const users = await User.find({ username: { $in: friendNames } }, 'username avatarUrl').lean();
        const avatarMap = new Map(users.map(u => [u.username, u.avatarUrl]));

        const friendsWithAvatars = friendNames.map(name => ({
            username: name,
            avatarUrl: avatarMap.get(name) || `letter:${name}`
        }));

        res.json(friendsWithAvatars);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка получения списка друзей' });
    }
});

app.post('/api/settings/update-avatar', authenticateToken, async (req, res) => {
    try {
        const { avatarUrl } = req.body;
        if (!isValidAvatar(avatarUrl)) return res.status(400).json({ error: 'Некорректное изображение' });

        const user = await User.findOneAndUpdate({ username: req.username }, { avatarUrl }, { new: true });
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

        res.json({ message: 'Аватарка успешно обновлена', avatarUrl: user.avatarUrl });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка обновления аватарки' });
    }
});

app.post('/api/settings/change-password', authenticateToken, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        if (!isValidString(oldPassword) || !isValidPassword(newPassword)) {
            return res.status(400).json({ error: 'Проверьте правильность заполнения полей (новый пароль от 6 символов)' });
        }

        const user = await User.findOne({ username: req.username });
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
// Аутентификация сокета: без валидного токена соединение не открывается.
// Это закрывает главную дыру старой версии — раньше кто угодно мог
// подключиться к сокету и слать сообщения от чужого имени в любой чат.

io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth && socket.handshake.auth.token;
        if (!isValidString(token)) return next(new Error('no_token'));
        const session = await Session.findOne({ token }).lean();
        if (!session) return next(new Error('invalid_token'));
        socket.username = session.username;
        next();
    } catch (e) {
        next(new Error('auth_error'));
    }
});

io.on('connection', (socket) => {
    console.log(`Подключился к GIGA сети: ${socket.username} (${socket.id})`);

    // Личная комната пользователя — для мгновенных пуш-уведомлений
    // (заявки в друзья и т.п.) без опроса сервера каждые несколько секунд.
    socket.join(`user:${socket.username}`);

    socket.on('join_chat', async ({ chatId }) => {
        try {
            if (!isValidObjectId(chatId)) return;
            const chat = await Chat.findById(chatId).lean();
            if (!chat || !chat.participants.includes(socket.username)) {
                socket.emit('chat_error', { error: 'Нет доступа к этому чату' });
                return;
            }

            const rooms = Array.from(socket.rooms);
            rooms.forEach(room => {
                if (room !== socket.id && room !== `user:${socket.username}`) socket.leave(room);
            });
            socket.join(chatId);
            socket.currentChatId = chatId;
            socket.currentChatParticipants = chat.participants;

            const history = await Message.find({ chatId }).sort({ timestamp: -1 }).limit(100).lean();
            socket.emit('load_history', { chatId, messages: history.reverse() });
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('send_message', async (data) => {
        try {
            const { chatId, text } = data;
            if (!isValidObjectId(chatId) || !isValidString(text, { max: 4000 })) return;

            // Проверяем, что отправитель реально участник этого чата -
            // sender берём ТОЛЬКО из аутентифицированного сокета, а не из data,
            // иначе можно было слать сообщения от чужого имени.
            let participants = socket.currentChatId === chatId ? socket.currentChatParticipants : null;
            if (!participants) {
                const chat = await Chat.findById(chatId).lean();
                if (!chat) return;
                participants = chat.participants;
            }
            if (!participants.includes(socket.username)) {
                socket.emit('chat_error', { error: 'Нет доступа к этому чату' });
                return;
            }

            const newMessage = new Message({ chatId, sender: socket.username, text: text.trim() });
            await newMessage.save();
            io.to(chatId).emit('receive_message', newMessage);
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('disconnect', () => {
        console.log('Пользователь отключился:', socket.username, socket.id);
    });
});

const PORT = 7860;
server.listen(PORT, '0.0.0.0', () => console.log(`GIGA Сервер успешно запущен на порту ${PORT}`));