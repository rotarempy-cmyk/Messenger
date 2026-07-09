const BACKEND_URL = "https://rotarempy-messenger.hf.space"; 
const SOCKET_URL = "wss://rotarempy-messenger.hf.space";

let currentUser = null;
let currentUserAvatar = null;
let currentUserToken = null;
let activeChatId = null;
let socket = null;
let currentTab = 'chats';
let contextTargetChatId = null;
let currentGroupData = null; // Для хранения текущей группы в настройках

// ================= СИСТЕМА ТЕМ ОФОРМЛЕНИЯ =================

const THEME_STORAGE_KEY = 'giga_theme_v1';

const THEME_PRESETS = [
    { id: 'aurora',   name: 'Аврора',   bg: '#0f1117', surface: '#171a23', text: '#e8e9f2', accent: '#7c5cff' },
    { id: 'ocean',    name: 'Океан',    bg: '#0a141f', surface: '#101f2e', text: '#dbe8f0', accent: '#22c3c9' },
    { id: 'sunset',   name: 'Закат',    bg: '#1a1210', surface: '#241713', text: '#f3e5de', accent: '#ff7a45' },
    { id: 'forest',   name: 'Лес',      bg: '#0e1613', surface: '#16201a', text: '#dceae1', accent: '#33d399' },
    { id: 'rose',     name: 'Роза',     bg: '#170f14', surface: '#221620', text: '#f2e2ea', accent: '#f4478f' },
    { id: 'graphite', name: 'Графит',   bg: '#121212', surface: '#1c1c1e', text: '#ececec', accent: '#5b8def' },
    { id: 'noir',     name: 'Чёрный',   bg: '#000000', surface: '#0c0c0c', text: '#ffffff', accent: '#3d8bfd' },
    { id: 'daylight', name: 'Светлый',  bg: '#eef0f5', surface: '#ffffff', text: '#1b1e27', accent: '#5b5cf0' }
];

function hexToRgb(hex) {
    hex = (hex || '#000000').replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const num = parseInt(hex, 16) || 0;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}
function blendHex(hexA, hexB, ratio) {
    const a = hexToRgb(hexA), b = hexToRgb(hexB);
    return rgbToHex(a.r + (b.r - a.r) * ratio, a.g + (b.g - a.g) * ratio, a.b + (b.b - a.b) * ratio);
}
function relativeLuminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const [rs, gs, bs] = [r, g, b].map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}
function contrastText(hex) {
    return relativeLuminance(hex) > 0.5 ? '#14151a' : '#ffffff';
}
function rgbaFromHex(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function computeThemeVars({ bg, surface, text, accent }) {
    const accentText = contrastText(accent);
    const accentLum = relativeLuminance(accent);
    return {
        '--bg': bg,
        '--surface': surface,
        '--surface-2': blendHex(surface, text, 0.055),
        '--surface-hover': blendHex(surface, text, 0.09),
        '--surface-active': blendHex(surface, accent, 0.22),
        '--border': blendHex(surface, text, 0.14),
        '--text': text,
        '--text-secondary': rgbaFromHex(text, 0.64),
        '--text-muted': rgbaFromHex(text, 0.42),
        '--accent': accent,
        '--accent-hover': blendHex(accent, accentLum > 0.5 ? '#000000' : '#ffffff', 0.16),
        '--accent-text': accentText,
        '--msg-me-bg': accent,
        '--msg-me-text': accentText,
        '--msg-other-bg': blendHex(surface, text, 0.07),
        '--msg-other-text': text,
        '--danger': '#f0454f',
        '--success': '#33c17a',
        '--scrollbar-thumb': blendHex(surface, text, 0.2)
    };
}

function applyThemeVars(vars) {
    const root = document.documentElement;
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
}

function syncColorInputs(colors) {
    document.getElementById('color-bg').value = colors.bg;
    document.getElementById('color-surface').value = colors.surface;
    document.getElementById('color-text').value = colors.text;
    document.getElementById('color-accent').value = colors.accent;
}

function updatePresetGridActive(presetId) {
    document.querySelectorAll('.theme-preset-card').forEach(card => {
        card.classList.toggle('active', card.dataset.presetId === presetId);
    });
}

function applyPresetTheme(presetId, save = true) {
    const preset = THEME_PRESETS.find(p => p.id === presetId) || THEME_PRESETS[0];
    applyThemeVars(computeThemeVars(preset));
    updatePresetGridActive(preset.id);
    syncColorInputs(preset);
    if (save) localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ mode: 'preset', presetId: preset.id }));
}

function applyCustomTheme(colors, save = true) {
    applyThemeVars(computeThemeVars(colors));
    updatePresetGridActive(null);
    if (save) localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ mode: 'custom', colors }));
}

function renderThemePresetsGrid() {
    const grid = document.getElementById('theme-presets-grid');
    grid.innerHTML = '';
    THEME_PRESETS.forEach(preset => {
        const card = document.createElement('div');
        card.className = 'theme-preset-card';
        card.dataset.presetId = preset.id;
        card.innerHTML = `
            <div class="theme-preset-swatch">
                <span style="background:${preset.bg}"></span>
                <span style="background:${preset.surface}"></span>
                <span style="background:${preset.accent}"></span>
            </div>
            <div class="theme-preset-name">${preset.name}</div>
        `;
        card.addEventListener('click', () => applyPresetTheme(preset.id));
        grid.appendChild(card);
    });
}

function loadThemeFromStorage() {
    try {
        const raw = localStorage.getItem(THEME_STORAGE_KEY);
        if (!raw) { applyPresetTheme('aurora', false); return; }
        const data = JSON.parse(raw);
        if (data.mode === 'custom' && data.colors) {
            applyCustomTheme(data.colors, false);
            syncColorInputs(data.colors);
        } else {
            applyPresetTheme(data.presetId || 'aurora', false);
        }
    } catch (e) { applyPresetTheme('aurora', false); }
}

renderThemePresetsGrid();
loadThemeFromStorage();

document.getElementById('apply-custom-theme-btn').addEventListener('click', () => {
    const colors = {
        bg: document.getElementById('color-bg').value,
        surface: document.getElementById('color-surface').value,
        text: document.getElementById('color-text').value,
        accent: document.getElementById('color-accent').value
    };
    applyCustomTheme(colors);
});

document.getElementById('reset-theme-btn').addEventListener('click', () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    applyPresetTheme('aurora');
});

function switchSettingsTab(tabName) {
    document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('visible'));
    document.getElementById(`settings-tab-btn-${tabName}`).classList.add('active');
    document.getElementById(`settings-tab-${tabName}`).classList.add('visible');
}
document.getElementById('settings-tab-btn-profile').addEventListener('click', () => switchSettingsTab('profile'));
document.getElementById('settings-tab-btn-appearance').addEventListener('click', () => switchSettingsTab('appearance'));
document.getElementById('settings-tab-btn-account').addEventListener('click', () => switchSettingsTab('account'));

// Кэш последних загруженных списков — при переключении вкладок и даже
// после перезагрузки страницы показываем их МГНОВЕННО из localStorage,
// а свежие данные подтягиваем в фоне и обновляем и кэш, и экран.
const listCache = { chats: null, friends: null, requests: null };

function cacheStorageKey(tabName) {
    return `giga_cache_${tabName}_${currentUser}`;
}

function saveListCache(tabName, data) {
    listCache[tabName] = data;
    try {
        localStorage.setItem(cacheStorageKey(tabName), JSON.stringify(data));
    } catch (e) {
        // localStorage переполнен (например, слишком много крупных аватаров) -
        // не критично, просто не кэшируем на этот раз.
    }
}

function loadListCacheFromStorage(tabName) {
    try {
        const raw = localStorage.getItem(cacheStorageKey(tabName));
        if (raw) listCache[tabName] = JSON.parse(raw);
    } catch (e) {}
}

// Очередь локально отправленных (ещё не подтверждённых сервером)
// сообщений — нужна для оптимистичного рендера без дублей.
const pendingSentMessages = [];

// Кэш уже загруженных сообщений по chatId (в памяти, живёт до перезагрузки
// страницы). Позволяет при повторном открытии чата показать переписку
// мгновенно, не дожидаясь ответа сервера — сервер всё равно опрашивается
// в фоне и досылает изменения, если они были.
const messagesCache = new Map();

// Короткая "подпись" списка сообщений (по их id) — чтобы понять,
// пришло ли от сервера что-то новое, или это те же сообщения,
// что уже показаны из кэша (и тогда не нужно дёргать экран).
function messagesSignature(messages) {
    return messages.map(m => m._id).join(',');
}

function renderMessagesList(messages) {
    messagesContainer.innerHTML = '';
    lastRenderedSender = null;
    messages.forEach(msg => appendMessage(msg));
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}

// ================= ОБРЕЗКА АВАТАРОК =================
// Общий кроппер для аватарки профиля и групп: превью + перетаскивание + зум,
// результат — квадратная картинка (JPEG), готовая стать круглой аватаркой.

const avatarPickerState = {}; // key -> обрезанный dataURL, ждущий сохранения
const CROP_BOX = 260;
const CROP_OUTPUT = 320;

const avatarCropModal = document.getElementById('avatar-crop-modal');
const cropViewport = document.getElementById('crop-viewport');
const cropImageEl = document.getElementById('crop-image');
const cropZoomInput = document.getElementById('crop-zoom');

let cropState = { imgEl: null, iw: 0, ih: 0, zoom: 1, posX: 0, posY: 0, onDone: null };
let cropDragging = false, cropDragStartX = 0, cropDragStartY = 0, cropDragOrigX = 0, cropDragOrigY = 0;

function openAvatarCropper(file, onDone) {
    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            cropState = { imgEl: img, iw: img.naturalWidth, ih: img.naturalHeight, zoom: 1, posX: 0, posY: 0, onDone };
            cropImageEl.src = img.src;
            cropZoomInput.value = '1';
            updateCropTransform();
            avatarCropModal.style.display = 'flex';
        };
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
}

function cropCoverScale() {
    return Math.max(CROP_BOX / cropState.iw, CROP_BOX / cropState.ih);
}

function clampCropPan() {
    const scaleFactor = cropCoverScale() * cropState.zoom;
    const dw = cropState.iw * scaleFactor, dh = cropState.ih * scaleFactor;
    const maxX = Math.max(0, (dw - CROP_BOX) / 2);
    const maxY = Math.max(0, (dh - CROP_BOX) / 2);
    cropState.posX = Math.max(-maxX, Math.min(maxX, cropState.posX));
    cropState.posY = Math.max(-maxY, Math.min(maxY, cropState.posY));
}

function updateCropTransform() {
    clampCropPan();
    const scaleFactor = cropCoverScale() * cropState.zoom;
    const dw = cropState.iw * scaleFactor, dh = cropState.ih * scaleFactor;
    cropImageEl.style.width = dw + 'px';
    cropImageEl.style.height = dh + 'px';
    cropImageEl.style.transform = `translate(-50%, -50%) translate(${cropState.posX}px, ${cropState.posY}px)`;
}

cropZoomInput.addEventListener('input', () => {
    cropState.zoom = parseFloat(cropZoomInput.value);
    updateCropTransform();
});

cropViewport.addEventListener('pointerdown', (e) => {
    if (!cropState.imgEl) return;
    cropDragging = true;
    cropDragStartX = e.clientX; cropDragStartY = e.clientY;
    cropDragOrigX = cropState.posX; cropDragOrigY = cropState.posY;
    cropViewport.setPointerCapture(e.pointerId);
});
cropViewport.addEventListener('pointermove', (e) => {
    if (!cropDragging) return;
    cropState.posX = cropDragOrigX + (e.clientX - cropDragStartX);
    cropState.posY = cropDragOrigY + (e.clientY - cropDragStartY);
    updateCropTransform();
});
window.addEventListener('pointerup', () => { cropDragging = false; });

document.getElementById('crop-cancel-btn').addEventListener('click', () => {
    avatarCropModal.style.display = 'none';
});

document.getElementById('crop-apply-btn').addEventListener('click', () => {
    const canvas = document.createElement('canvas');
    canvas.width = CROP_OUTPUT; canvas.height = CROP_OUTPUT;
    const ctx = canvas.getContext('2d');
    const scaleFactor = cropCoverScale() * cropState.zoom;
    const dw = cropState.iw * scaleFactor, dh = cropState.ih * scaleFactor;
    const offX = CROP_BOX / 2 + cropState.posX - dw / 2;
    const offY = CROP_BOX / 2 + cropState.posY - dh / 2;
    const sx = -offX / scaleFactor, sy = -offY / scaleFactor;
    const sSize = CROP_BOX / scaleFactor;
    ctx.drawImage(cropState.imgEl, sx, sy, sSize, sSize, 0, 0, CROP_OUTPUT, CROP_OUTPUT);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    avatarCropModal.style.display = 'none';
    if (cropState.onDone) cropState.onDone(dataUrl);
});

// Подключает круглую кнопку-превью к скрытому input[type=file] и открывает
// кроппер при выборе файла; результат кладётся в avatarPickerState[key].
function initAvatarPicker(key, previewId, buttonId, fileInputId) {
    const preview = document.getElementById(previewId);
    const btn = document.getElementById(buttonId);
    const fileInput = document.getElementById(fileInputId);
    btn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        openAvatarCropper(file, (dataUrl) => {
            avatarPickerState[key] = dataUrl;
            preview.style.backgroundImage = `url(${dataUrl})`;
        });
        fileInput.value = '';
    });
}

function setAvatarPickerPreview(key, previewId, avatarUrl, fallbackName) {
    delete avatarPickerState[key];
    document.getElementById(previewId).style.backgroundImage = `url(${getAvatarSrc(avatarUrl, fallbackName)})`;
}

initAvatarPicker('profile', 'profile-avatar-preview', 'profile-avatar-pick-btn', 'profile-avatar-file-input');
initAvatarPicker('group-create', 'wizard-group-avatar-preview', 'wizard-group-avatar-pick-btn', 'wizard-group-avatar-file-input');
initAvatarPicker('group-edit', 'group-edit-avatar-preview', 'group-edit-avatar-pick-btn', 'group-edit-avatar-file-input');

// Кэш аватарок отправителей — заполняется при открытии чата (для 1-на-1
// это собеседник, для групп — все участники), чтобы в переписке сразу
// показывались реальные аватарки без лишних запросов на каждое сообщение.
const avatarCache = new Map();
function cacheAvatar(username, resolvedSrc) { if (username) avatarCache.set(username, resolvedSrc); }
function getCachedAvatarSrc(username) { return avatarCache.get(username) || generateLetterAvatar(username); }

// Отслеживаем отправителя предыдущего сообщения, чтобы подряд идущие
// сообщения одного человека визуально группировались (без повтора аватарки/ника).
let lastRenderedSender = null;

// ================= МОБИЛЬНАЯ НАВИГАЦИЯ =================
// На узких экранах список чатов и сама переписка не помещаются рядом,
// поэтому показываем их как два отдельных "экрана": список чатов
// (по умолчанию) или открытый чат (после тапа), с кнопкой "назад".

const appShell = document.getElementById('app-shell');
const mobileBackBtn = document.getElementById('mobile-back-btn');

function isMobileView() {
    return window.matchMedia('(max-width: 760px)').matches;
}

function enterMobileChatView() {
    if (isMobileView()) appShell.classList.add('chat-open');
}

function exitMobileChatView() {
    appShell.classList.remove('chat-open');
}

mobileBackBtn.addEventListener('click', exitMobileChatView);

const authContainer = document.getElementById('auth-container');
const messengerContainer = document.getElementById('messenger-container');
const authError = document.getElementById('auth-error');
const searchError = document.getElementById('search-error');
const searchResultPanel = document.getElementById('search-result-panel');
const searchResultName = document.getElementById('search-result-name');
const searchResultAvatar = document.getElementById('search-result-avatar');
const addFriendActionBtn = document.getElementById('add-friend-action-btn');
const searchChatBtn = document.getElementById('search-chat-btn');
const listContent = document.getElementById('list-content');
const chatPlaceholder = document.getElementById('chat-placeholder');
const chatMain = document.getElementById('chat-main');
const messagesContainer = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const requestsCountBadge = document.getElementById('requests-count');

const profileModal = document.getElementById('profile-modal');
const modalProfileAvatar = document.getElementById('modal-profile-avatar');
const modalProfileName = document.getElementById('modal-profile-name');
const modalProfileChatBtn = document.getElementById('modal-profile-chat-btn');
const modalProfileFriendBtn = document.getElementById('modal-profile-friend-btn');

const settingsModal = document.getElementById('settings-modal');
const groupWizardModal = document.getElementById('group-wizard-modal');
const groupSettingsModal = document.getElementById('group-settings-modal');
const chatTargetName = document.getElementById('chat-target-name');
const openGroupSettingsBtn = document.getElementById('open-group-settings-btn');
const contextMenu = document.getElementById('context-menu');

chatTargetName.style.cursor = 'pointer';
chatTargetName.addEventListener('click', () => {
    if (currentGroupData) return; // Для групп профиль юзера не открываем
    const targetUser = chatTargetName.innerText;
    if (targetUser && targetUser !== "Разговор") showUserProfile(targetUser);
});

// ================= АВТОРИЗАЦИЯ И СЕССИИ =================

window.addEventListener('DOMContentLoaded', async () => {
    const initialLoader = document.getElementById('initial-loader');
    const accounts = getSavedAccounts();
    const activeUser = localStorage.getItem('giga_active_user');
    
    if (activeUser && accounts[activeUser]) {
        const verified = await verifySession(accounts[activeUser].token);
        if (verified) {
            initMessenger(verified.username, verified.avatarUrl, verified.token);
            initialLoader.style.display = 'none';
            return;
        } else {
            removeAccountFromStorage(activeUser);
        }
    }
    initialLoader.style.display = 'none';
    authContainer.style.display = 'flex';
    messengerContainer.style.display = 'none';
});

function getSavedAccounts() { return JSON.parse(localStorage.getItem('giga_accounts') || '{}'); }

function saveAccountToStorage(username, avatarUrl, token) {
    const accounts = getSavedAccounts();
    if (Object.keys(accounts).length >= 5 && !accounts[username]) {
        alert("Максимальное количество аккаунтов: 5");
        return false;
    }
    accounts[username] = { username, avatarUrl, token };
    localStorage.setItem('giga_accounts', JSON.stringify(accounts));
    localStorage.setItem('giga_active_user', username);
    return true;
}

function removeAccountFromStorage(username) {
    const accounts = getSavedAccounts();
    delete accounts[username];
    localStorage.setItem('giga_accounts', JSON.stringify(accounts));
    const remaining = Object.keys(accounts);
    if (remaining.length > 0) localStorage.setItem('giga_active_user', remaining[0]);
    else localStorage.removeItem('giga_active_user');
}

async function verifySession(token) {
    try {
        const res = await fetch(`${BACKEND_URL}/api/auth/verify`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) return await res.json();
    } catch(e) {}
    return null;
}

function generateLetterAvatar(username) {
    const canvas = document.createElement('canvas');
    canvas.width = 100; canvas.height = 100;
    const ctx = canvas.getContext('2d');
    const styles = getComputedStyle(document.documentElement);
    const bgColor = (styles.getPropertyValue('--accent') || '#4a4a4a').trim() || '#4a4a4a';
    const fgColor = (styles.getPropertyValue('--accent-text') || '#ffffff').trim() || '#ffffff';
    ctx.fillStyle = bgColor; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const letter = username ? username.trim().charAt(0).toUpperCase() : '?';
    ctx.fillStyle = fgColor; ctx.font = 'bold 50px Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(letter, 50, 54);
    return canvas.toDataURL();
}

function getAvatarSrc(avatarUrl, username) {
    if (avatarUrl && avatarUrl.startsWith('data:image')) return avatarUrl;
    return generateLetterAvatar(username);
}

function toggleLoading(button, isLoading) {
    const textSpan = button.querySelector('.btn-text');
    if (isLoading) {
        button.disabled = true;
        if(textSpan) textSpan.style.display = 'none';
        const spinner = document.createElement('div');
        spinner.classList.add('spinner');
        button.appendChild(spinner);
    } else {
        button.disabled = false;
        if(textSpan) textSpan.style.display = 'inline';
        const spinner = button.querySelector('.spinner');
        if (spinner) spinner.remove();
    }
}

function initMessenger(username, avatarUrl, token) {
    currentUser = username;
    currentUserAvatar = avatarUrl;
    currentUserToken = token;
    
    authContainer.style.display = 'none';
    messengerContainer.style.display = 'flex';
    document.getElementById('my-name').innerText = currentUser;
    document.getElementById('my-avatar-img').src = getAvatarSrc(currentUserAvatar, currentUser);
    cacheAvatar(currentUser, getAvatarSrc(currentUserAvatar, currentUser));

    // Подтягиваем то, что уже сохранено с прошлого визита (в т.ч. после
    // перезагрузки страницы), чтобы список чатов был виден мгновенно,
    // ещё до ответа сервера.
    loadListCacheFromStorage('chats');
    loadListCacheFromStorage('friends');
    loadListCacheFromStorage('requests');

    if (socket) socket.disconnect();
    // Токен передаём при подключении — сервер отклонит соединение
    // без валидной сессии, поэтому чужой браузер не сможет слать
    // сообщения от имени этого аккаунта.
    socket = io(SOCKET_URL, { auth: { token: currentUserToken } });

    socket.on('load_history', ({ chatId, messages }) => {
        if (chatId !== activeChatId) return; // на случай гонки при быстром переключении чатов

        // Если то, что прислал сервер, совпадает с тем, что уже показано
        // из кэша (при повторном открытии чата) — экран не трогаем,
        // чтобы не было "мигания" и сброса скролла.
        const cached = messagesCache.get(chatId);
        const isSameAsShown = cached && messagesSignature(cached) === messagesSignature(messages);

        messagesCache.set(chatId, messages);
        pendingSentMessages.length = 0;

        if (isSameAsShown) return;
        renderMessagesList(messages);
    });

    socket.on('receive_message', (msgData) => {
        if (msgData.chatId !== activeChatId) return;

        // Держим кэш чата в актуальном состоянии, чтобы при следующем
        // открытии этого чата новое сообщение уже было видно сразу.
        const cached = messagesCache.get(msgData.chatId) || [];
        cached.push(msgData);
        messagesCache.set(msgData.chatId, cached);

        // Если это подтверждение НАШЕГО же оптимистично отправленного
        // сообщения — не дублируем, а просто "подтверждаем" уже нарисованное.
        if (msgData.sender === currentUser && pendingSentMessages.length > 0
            && pendingSentMessages[0].text === msgData.text) {
            const pending = pendingSentMessages.shift();
            pending.element.style.opacity = '1';
            pending.element.dataset.confirmed = 'true';
            return;
        }
        appendMessage(msgData);
    });

    socket.on('chat_error', ({ error }) => {
        console.warn('Ошибка чата:', error);
    });

    switchTab('chats');
    startUpdateLoop();
}

function startUpdateLoop() {
    if (window.gigaInterval) clearInterval(window.gigaInterval);
    // Основные обновления теперь приходят мгновенно через сокет
    // (см. friend_request_incoming / friend_request_accepted ниже).
    // Этот интервал — просто подстраховка на случай разрыва соединения,
    // поэтому его можно держать редким и не грузить бесплатный сервер.
    window.gigaInterval = setInterval(() => {
        updateBadges();
        if(currentTab === 'requests') loadIncomingRequests();
        if(currentTab === 'friends') loadFriendsList();
        if(currentTab === 'chats') loadMyChats();
    }, 20000);
    updateBadges();

    if (socket) {
        socket.on('friend_request_incoming', () => {
            updateBadges();
            if (currentTab === 'requests') loadIncomingRequests();
        });
        socket.on('friend_request_accepted', () => {
            if (currentTab === 'friends') loadFriendsList();
            if (currentTab === 'chats') loadMyChats();
        });
        // Кто-то создал/изменил/покинул группу с нашим участием -
        // обновляем список чатов, если он сейчас на экране.
        socket.on('chats_updated', () => {
            if (currentTab === 'chats') loadMyChats();
        });
        // Название/аватар текущего открытого группового чата поменялись
        // у другого участника — подхватываем сразу, без перезахода.
        socket.on('group_updated', ({ chatId, groupName, groupAvatar }) => {
            if (chatId !== activeChatId) return;
            chatTargetName.innerText = groupName;
            const hAvatar = document.getElementById('chat-header-avatar');
            hAvatar.src = getAvatarSrc(groupAvatar, groupName);
            if (currentGroupData) { currentGroupData.groupName = groupName; currentGroupData.groupAvatar = groupAvatar; }
        });
    }
}

async function updateBadges() {
    try {
        const res = await fetch(`${BACKEND_URL}/api/friends/requests/incoming`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentUserToken}` }
        });
        const data = await res.json();
        if(data.length > 0) {
            requestsCountBadge.innerText = data.length;
            requestsCountBadge.style.display = 'inline-block';
        } else { requestsCountBadge.style.display = 'none'; }
    } catch(e){}
}

function switchTab(tabName) {
    currentTab = tabName;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');
    searchResultPanel.style.display = 'none';
    searchError.innerText = "";

    if (listCache[tabName]) renderListFromCache(tabName);

    if(tabName === 'chats') loadMyChats();
    if(tabName === 'friends') loadFriendsList();
    if(tabName === 'requests') loadIncomingRequests();
}

function renderListFromCache(tabName) {
    if (tabName === 'chats') renderChats(listCache.chats);
    if (tabName === 'friends') renderFriends(listCache.friends);
    if (tabName === 'requests') renderRequests(listCache.requests);
}

document.getElementById('tab-chats').addEventListener('click', () => switchTab('chats'));
document.getElementById('tab-friends').addEventListener('click', () => switchTab('friends'));
document.getElementById('tab-requests').addEventListener('click', () => switchTab('requests'));

// ================= ЛОГИКА ГРУППОВЫХ ЧАТОВ =================

// Открытие мастера создания группы
document.getElementById('open-group-wizard-btn').addEventListener('click', async () => {
    document.getElementById('wizard-group-name').value = '';
    setAvatarPickerPreview('group-create', 'wizard-group-avatar-preview', '', '?');
    const wList = document.getElementById('wizard-friends-list');
    wList.innerHTML = 'Загрузка друзей...';
    groupWizardModal.style.display = 'flex';

    try {
        const res = await fetch(`${BACKEND_URL}/api/friends/list`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentUserToken}` }
        });
        const friends = await res.json();
        wList.innerHTML = '';
        if(friends.length === 0) {
            wList.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">У вас нет друзей для приглашения</span>';
            return;
        }
        friends.forEach(f => {
            const label = document.createElement('label');
            label.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:5px; color:var(--text); font-size:13px; cursor:pointer;";
            label.innerHTML = `<input type="checkbox" value="${f.username}"> <span>${f.username}</span>`;
            wList.appendChild(label);
        });
    } catch(e) { wList.innerHTML = 'Ошибка загрузки'; }
});

// Отправка формы создания группы
document.getElementById('submit-group-btn').addEventListener('click', async () => {
    const name = document.getElementById('wizard-group-name').value.trim();
    if (!name) return alert('Введите название группы!');
    
    const checkboxes = document.getElementById('wizard-friends-list').querySelectorAll('input[type="checkbox"]:checked');
    const members = Array.from(checkboxes).map(cb => cb.value);

    const base64Avatar = avatarPickerState['group-create'] || '';

    toggleLoading(document.getElementById('submit-group-btn'), true);

    try {
        const res = await fetch(`${BACKEND_URL}/api/groups/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUserToken}` },
            body: JSON.stringify({ name, avatar: base64Avatar, members })
        });
        if (res.ok) {
            delete avatarPickerState['group-create'];
            groupWizardModal.style.display = 'none';
            loadMyChats();
        } else {
            const d = await res.json();
            alert(d.error || 'Не удалось создать группу');
        }
    } catch(e) {}
    finally { toggleLoading(document.getElementById('submit-group-btn'), false); }
});

// Настройки группы (открытие модалки)
openGroupSettingsBtn.addEventListener('click', () => {
    if(!currentGroupData) return;
    
    const isAdmin = currentGroupData.admins.includes(currentUser);
    document.getElementById('group-admin-zone').style.display = isAdmin ? 'block' : 'none';
    document.getElementById('save-group-settings-btn').style.display = isAdmin ? 'block' : 'none';
    document.getElementById('group-invite-zone').style.display = isAdmin ? 'block' : 'none';
    
    document.getElementById('group-edit-name').value = currentGroupData.groupName;
    setAvatarPickerPreview('group-edit', 'group-edit-avatar-preview', currentGroupData.groupAvatar, currentGroupData.groupName);
    
    renderGroupMembersManagement();
    if (isAdmin) renderGroupInviteList();

    groupSettingsModal.style.display = 'flex';
});

function renderGroupMembersManagement() {
    const container = document.getElementById('group-members-manage-list');
    container.innerHTML = '';
    const isAdmin = currentGroupData.admins.includes(currentUser);

    currentGroupData.participants.forEach(p => {
        const row = document.createElement('div');
        row.style.cssText = "display:flex; align-items:center; justify-content:space-between; background:var(--surface-hover); padding:7px 10px; border-radius:10px; font-size:13px; color:var(--text);";
        
        const isTargetAdmin = currentGroupData.admins.includes(p);
        const isCreator = currentGroupData.creator === p;
        
        let badgeText = '';
        if (isCreator) badgeText = ' (Владелец)';
        else if (isTargetAdmin) badgeText = ' (Админ)';

        row.innerHTML = `
            <span>${p}<b>${badgeText}</b></span>
            <div style="display:flex; gap:4px;">
                ${isAdmin && !isTargetAdmin ? `
                <button class="action-btn accept-btn"
                style="min-height:20px;font-size:10px;padding:2px 6px;"
                onclick="makeGroupAdmin('${p}')">
                Админ
                </button>` : ''}
                ${isAdmin && isTargetAdmin && !isCreator && p !== currentUser ? `
                <button class="action-btn"
                style="background:#d08a00;min-height:20px;font-size:10px;padding:2px 6px;"
                onclick="removeGroupAdmin('${p}')">
                Снять
                </button>` : ''}
                ${isAdmin && p !== currentUser && !isCreator ? `<button class="action-btn reject-btn" style="min-height:20px; font-size:10px; padding:2px 6px;" onclick="kickGroupMember('${p}')">Исключить</button>` : ''}
            </div>
        `;
        container.appendChild(row);
    });
}

async function makeGroupAdmin(username) {
    if(!currentGroupData.admins.includes(username)) {
        currentGroupData.admins.push(username);
        renderGroupMembersManagement();
    }
}

async function removeGroupAdmin(username) {
    currentGroupData.admins = currentGroupData.admins.filter(a => a !== username);
    renderGroupMembersManagement();
}

async function kickGroupMember(username) {
    currentGroupData.participants = currentGroupData.participants.filter(m => m !== username);
    currentGroupData.admins = currentGroupData.admins.filter(a => a !== username);
    renderGroupMembersManagement();
}

async function renderGroupInviteList() {
    const container = document.getElementById('group-invite-friends-list');
    container.innerHTML = 'Загрузка...';
    try {
        const res = await fetch(`${BACKEND_URL}/api/friends/list`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentUserToken}` }
        });
        const friends = await res.json();
        container.innerHTML = '';
        
        const candidates = friends.filter(f => !currentGroupData.participants.includes(f.username));
        if (candidates.length === 0) {
            container.innerHTML = '<span style="color:var(--text-muted); font-size:11px;">Все друзья уже в группе</span>';
            return;
        }

        candidates.forEach(f => {
            const row = document.createElement('div');
            row.style.cssText = "display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; font-size:12px; color:var(--text);";
            row.innerHTML = `
                <span>${f.username}</span>
                <button class="action-btn accept-btn" style="min-height:20px; font-size:10px; padding:2px 6px;" onclick="inviteFriendToGroupInMemory('${f.username}')">Добавить</button>
            `;
            container.appendChild(row);
        });
    } catch(e) { container.innerHTML = 'Ошибка'; }
}

function inviteFriendToGroupInMemory(username) {
    if(!currentGroupData.participants.includes(username)) {
        currentGroupData.participants.push(username);
        renderGroupMembersManagement();
        renderGroupInviteList();
    }
}

// Сохранение настроек группы админом
document.getElementById('save-group-settings-btn').addEventListener('click', async () => {
    const newName = document.getElementById('group-edit-name').value.trim();
    if(!newName) return alert('Имя группы не может быть пустым');

    const base64Avatar = avatarPickerState['group-edit'] !== undefined ? avatarPickerState['group-edit'] : currentGroupData.groupAvatar;

    toggleLoading(document.getElementById('save-group-settings-btn'), true);

    try {
        const res = await fetch(`${BACKEND_URL}/api/groups/${currentGroupData._id}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUserToken}` },
            body: JSON.stringify({
                name: newName,
                avatar: base64Avatar,
                admins: currentGroupData.admins,
                participants: currentGroupData.participants
            })
        });
        if(res.ok) {
            delete avatarPickerState['group-edit'];
            groupSettingsModal.style.display = 'none';
            // Перезапрашиваем чат
            openChat(currentGroupData._id, newName, getAvatarSrc(base64Avatar, newName), true);
            loadMyChats();
        } else {
            const d = await res.json();
            alert(d.error || 'Не удалось сохранить изменения');
        }
    } catch(e){}
    finally { toggleLoading(document.getElementById('save-group-settings-btn'), false); }
});

// Покинуть группу через контекстное меню (ПКМ)
async function leaveGroup(chatId) {
    if(!confirm("Вы уверены, что хотите выйти из этой группы?")) return;
    try {
        const res = await fetch(`${BACKEND_URL}/api/groups/${chatId}/leave`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentUserToken}` }
        });
        if(res.ok) {
            groupSettingsModal.style.display = 'none';
            if (activeChatId === chatId) {
                activeChatId = null;
                chatPlaceholder.style.display = 'flex';
                chatMain.style.display = 'none';
                exitMobileChatView();
            }
            loadMyChats();
        }
    } catch(e){}
}

// Кнопка "Покинуть группу" прямо в настройках — основной способ выйти
// (правый клик по чату неудобен/недоступен на телефоне).
document.getElementById('leave-group-btn').addEventListener('click', () => {
    if (currentGroupData) leaveGroup(currentGroupData._id);
});

// ОБРАБОТКА ПКМ НА СПИСКЕ ЧАТОВ
window.addEventListener('click', () => { contextMenu.style.display = 'none'; });
document.getElementById('context-leave-item').addEventListener('click', () => {
    if(contextTargetChatId) leaveGroup(contextTargetChatId);
});

// ================= ОБЫЧНЫЕ ЧАТЫ И ДРУЗЬЯ =================

async function showUserProfile(targetUsername) {
    try {
        const profRes = await fetch(`${BACKEND_URL}/api/user/profile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUserToken}` },
            body: JSON.stringify({ username: targetUsername })
        });
        const profData = await profRes.json();
        if(!profRes.ok) return;

        const relRes = await fetch(`${BACKEND_URL}/api/user/relationship`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUserToken}` },
            body: JSON.stringify({ targetUsername })
        });
        const relData = await relRes.json();

        modalProfileName.innerText = profData.username;
        modalProfileAvatar.src = getAvatarSrc(profData.avatarUrl, profData.username);
        profileModal.style.display = 'flex';

        modalProfileChatBtn.onclick = () => {
            profileModal.style.display = 'none';
            startChatWithUser(profData.username);
        };

        modalProfileFriendBtn.disabled = false;
        modalProfileFriendBtn.style.background = 'var(--success)';

        if (relData.status === 'friends') {
            modalProfileFriendBtn.innerText = 'Добавлен в друзья';
            modalProfileFriendBtn.disabled = true;
            modalProfileFriendBtn.style.background = 'var(--surface-2)';
        } else if (relData.status === 'sent') {
            modalProfileFriendBtn.innerText = 'Заявка отправлена';
            modalProfileFriendBtn.disabled = true;
            modalProfileFriendBtn.style.background = 'var(--surface-2)';
        } else if (relData.status === 'received') {
            modalProfileFriendBtn.innerText = 'Принять заявку';
            modalProfileFriendBtn.onclick = async () => {
                await respondFriendRequest(relData.requestId, 'accept');
                showUserProfile(targetUsername);
            };
        } else {
            modalProfileFriendBtn.innerText = 'Добавить в друзья';
            modalProfileFriendBtn.onclick = async () => {
                await sendFriendRequest(profData.username);
                showUserProfile(targetUsername);
            };
        }
    } catch(e) {}
}

async function sendFriendRequest(target) {
    try {
        await fetch(`${BACKEND_URL}/api/friends/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUserToken}` },
            body: JSON.stringify({ targetUsername: target })
        });
    } catch(e){}
}

async function loadMyChats() {
    if(currentTab !== 'chats') return;
    try {
        const res = await fetch(`${BACKEND_URL}/api/chats`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentUserToken}` }
        });
        if(!res.ok) return;
        const chats = await res.json();
        saveListCache('chats', chats);
        if (currentTab === 'chats') renderChats(chats);
    } catch (err) {}
}

function renderChats(chats) {
    if(!chats || chats.length === 0) {
        listContent.innerHTML = '<div style="padding:15px; color:var(--text-muted); font-size:13px; text-align:center;">У вас пока нет активных чатов</div>';
        return;
    }

    listContent.innerHTML = '';
    chats.forEach(chat => {
        const isGroup = chat.isGroup === true;
        const name = isGroup ? chat.groupName : (chat.targetUser || "Неизвестный");
        const avatar = getAvatarSrc(isGroup ? chat.groupAvatar : chat.avatarUrl, name);
        const isActive = chat._id === activeChatId ? 'active' : '';

        const item = document.createElement('div');
        item.className = `list-item ${isActive}`;
        item.setAttribute('data-chat-id', chat._id);

        const left = document.createElement('div');
        left.className = 'item-left';
        const img = document.createElement('img');
        img.src = avatar; img.className = 'avatar-mini'; img.alt = '';
        const span = document.createElement('span');
        span.textContent = name + (isGroup ? ' 👥' : ''); // textContent — защита от XSS в имени
        left.appendChild(img); left.appendChild(span);
        item.appendChild(left);

        item.addEventListener('contextmenu', (e) => {
            if (isGroup) {
                e.preventDefault();
                contextTargetChatId = chat._id;
                contextMenu.style.left = e.pageX + 'px';
                contextMenu.style.top = e.pageY + 'px';
                contextMenu.style.display = 'block';
            }
        });

        item.addEventListener('click', () => {
            // Подсветку меняем СРАЗУ, не дожидаясь сети — раньше она
            // обновлялась только при следующей перерисовке списка (до 4 сек).
            document.querySelectorAll('#list-content .list-item.active').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
            openChat(chat._id, name, avatar, isGroup);
        });
        listContent.appendChild(item);
    });
}

async function startChatWithUser(targetUser) {
    try {
        const res = await fetch(`${BACKEND_URL}/api/chats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUserToken}` },
            body: JSON.stringify({ targetUsername: targetUser })
        });
        const chatData = await res.json();
        const pRes = await fetch(`${BACKEND_URL}/api/user/profile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUserToken}` },
            body: JSON.stringify({ username: targetUser })
        });
        const pData = await pRes.json();

        switchTab('chats');
        openChat(chatData._id, targetUser, getAvatarSrc(pData.avatarUrl, targetUser), false);
    } catch(e) {}
}

async function openChat(chatId, title, avatarUrl, isGroup = false) {
    activeChatId = chatId;
    chatPlaceholder.style.display = 'none';
    chatMain.style.display = 'flex';
    chatTargetName.innerText = title;
    enterMobileChatView();

    // Если этот чат уже открывали раньше — сообщения есть в кэше,
    // рисуем их сразу же, не дожидаясь ответа сервера. Сервер всё равно
    // опрашивается ниже (join_chat) и досылает свежие данные, если
    // что-то изменилось. Если чат открывается впервые — показываем
    // прежний плейсхолдер, пока не придёт история.
    const cachedMessages = messagesCache.get(chatId);
    if (cachedMessages) {
        renderMessagesList(cachedMessages);
    } else {
        messagesContainer.innerHTML = '<div style="text-align:center; color:var(--text-muted); font-size:12px; padding:20px;">Загрузка сообщений...</div>';
        lastRenderedSender = null;
    }
    pendingSentMessages.length = 0;

    const hAvatar = document.getElementById('chat-header-avatar');
    hAvatar.src = avatarUrl;
    hAvatar.style.display = 'inline-block';

    if (isGroup) {
        openGroupSettingsBtn.style.display = 'inline-block';
        // Подгружаем актуальные данные группы
        try {
            const gRes = await fetch(`${BACKEND_URL}/api/groups/${chatId}`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${currentUserToken}` }
            });
            if (gRes.ok) {
                currentGroupData = await gRes.json();
                // Кэшируем аватарки всех участников группы разом -
                // иначе для каждого отправителя пришлось бы делать отдельный запрос.
                (currentGroupData.participantsInfo || []).forEach(p => {
                    cacheAvatar(p.username, getAvatarSrc(p.avatarUrl, p.username));
                });
            }
        } catch(e){}
    } else {
        openGroupSettingsBtn.style.display = 'none';
        currentGroupData = null;
        cacheAvatar(title, avatarUrl);
    }

    socket.emit('join_chat', { chatId: chatId });
}

async function loadFriendsList() {
    if(currentTab !== 'friends') return;
    try {
        const res = await fetch(`${BACKEND_URL}/api/friends/list`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentUserToken}` }
        });
        const friends = await res.json();
        saveListCache('friends', friends);
        if (currentTab === 'friends') renderFriends(friends);
    } catch(e){}
}

function renderFriends(friends) {
    if(!friends || friends.length === 0) {
        listContent.innerHTML = '<div style="padding:15px; color:var(--text-muted); font-size:13px; text-align:center;">Список друзей пока пуст</div>';
        return;
    }

    listContent.innerHTML = '';
    friends.forEach(friend => {
        const avatar = getAvatarSrc(friend.avatarUrl, friend.username);
        const item = document.createElement('div');
        item.className = 'list-item';

        const left = document.createElement('div');
        left.className = 'item-left';
        const img = document.createElement('img');
        img.src = avatar; img.className = 'avatar-mini'; img.alt = '';
        const span = document.createElement('span');
        span.textContent = friend.username;
        left.appendChild(img); left.appendChild(span);

        const btn = document.createElement('button');
        btn.className = 'action-btn accept-btn';
        btn.style.cssText = 'min-height:26px; font-size:11px;';
        btn.textContent = 'Написать';

        item.appendChild(left); item.appendChild(btn);
        item.addEventListener('click', () => showUserProfile(friend.username));
        btn.addEventListener('click', (e) => { e.stopPropagation(); startChatWithUser(friend.username); });
        listContent.appendChild(item);
    });
}

async function loadIncomingRequests() {
    if(currentTab !== 'requests') return;
    try {
        const res = await fetch(`${BACKEND_URL}/api/friends/requests/incoming`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentUserToken}` }
        });
        const requests = await res.json();
        saveListCache('requests', requests);
        if (currentTab === 'requests') renderRequests(requests);
    } catch(e){}
}

function renderRequests(requests) {
    if(!requests || requests.length === 0) {
        listContent.innerHTML = '<div style="padding:15px; color:var(--text-muted); font-size:13px; text-align:center;">Нет входящих заявок</div>';
        return;
    }

    listContent.innerHTML = '';
    requests.forEach(req => {
        const avatar = getAvatarSrc(req.avatarUrl, req.sender);
        const item = document.createElement('div');
        item.classList.add('list-item');

        const left = document.createElement('div');
        left.className = 'item-left';
        const img = document.createElement('img');
        img.src = avatar; img.className = 'avatar-mini'; img.alt = '';
        const span = document.createElement('span');
        const b = document.createElement('b');
        b.textContent = req.sender;
        span.appendChild(b);
        left.appendChild(img); left.appendChild(span);

        const actions = document.createElement('div');
        actions.className = 'actions-group';
        const accBtn = document.createElement('button');
        accBtn.className = 'action-btn accept-btn'; accBtn.textContent = 'Принять';
        const rejBtn = document.createElement('button');
        rejBtn.className = 'action-btn reject-btn'; rejBtn.textContent = 'Отклонить';
        actions.appendChild(accBtn); actions.appendChild(rejBtn);

        item.appendChild(left); item.appendChild(actions);
        item.addEventListener('click', () => showUserProfile(req.sender));
        accBtn.addEventListener('click', (e) => { e.stopPropagation(); respondFriendRequest(req._id, 'accept'); });
        rejBtn.addEventListener('click', (e) => { e.stopPropagation(); respondFriendRequest(req._id, 'reject'); });
        listContent.appendChild(item);
    });
}

async function respondFriendRequest(requestId, action) {
    try {
        const res = await fetch(`${BACKEND_URL}/api/friends/respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUserToken}` },
            body: JSON.stringify({ requestId, action })
        });
        if(res.ok) {
            if(currentTab === 'requests') loadIncomingRequests();
            updateBadges();
        }
    } catch(e){}
}

document.getElementById('search-btn').addEventListener('click', async () => {
    const targetUsername = document.getElementById('search-input').value.trim();
    searchError.innerText = "";
    searchResultPanel.style.display = 'none';

    if(!targetUsername) return;
    if(targetUsername === currentUser) return searchError.innerText = "Это вы!";

    toggleLoading(document.getElementById('search-btn'), true);

    try {
        const searchRes = await fetch(`${BACKEND_URL}/api/search-users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUserToken}` },
            body: JSON.stringify({ username: targetUsername })
        });
        const searchData = await searchRes.json();

        if (!searchRes.ok) {
            searchError.className = "error";
            searchError.innerText = "Пользователь не найден";
            return;
        }

        searchResultName.innerText = searchData.username;
        searchResultAvatar.src = getAvatarSrc(searchData.avatarUrl, searchData.username);
        searchResultPanel.style.display = 'flex';

        document.getElementById('search-profile-trigger').onclick = () => showUserProfile(searchData.username);
    } catch (err) { searchError.innerText = "Ошибка сети"; } 
    finally { toggleLoading(document.getElementById('search-btn'), false); }
});

searchChatBtn.addEventListener('click', async () => {
    const targetUsername = searchResultName.innerText;
    await startChatWithUser(targetUsername);
    searchResultPanel.style.display = 'none';
    document.getElementById('search-input').value = "";
});

addFriendActionBtn.addEventListener('click', async () => {
    const targetUsername = searchResultName.innerText;
    toggleLoading(addFriendActionBtn, true);
    try {
        const res = await fetch(`${BACKEND_URL}/api/friends/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUserToken}` },
            body: JSON.stringify({ targetUsername })
        });
        if(res.ok) {
            searchError.className = "success"; searchError.innerText = "Заявка отправлена!";
            searchResultPanel.style.display = 'none';
            document.getElementById('search-input').value = "";
        } else {
            const d = await res.json();
            searchError.className = "error"; searchError.innerText = d.error;
        }
    } catch(e) { searchError.innerText = "Ошибка"; } 
    finally { toggleLoading(addFriendActionBtn, false); }
});

// ================= НАСТРОЙКИ И МУЛЬТИАККАУНТИНГ =================

document.getElementById('open-settings-btn').addEventListener('click', () => {
    setAvatarPickerPreview('profile', 'profile-avatar-preview', currentUserAvatar, currentUser);
    document.getElementById('settings-avatar-msg').innerText = "";
    document.getElementById('settings-password-msg').innerText = "";
    switchSettingsTab('profile');
    renderAccountsList();
    loadSecurityDevices();
    settingsModal.style.display = 'flex';
});

function renderAccountsList() {
    const listContainer = document.getElementById('accounts-list');
    listContainer.innerHTML = '';
    const accounts = getSavedAccounts();
    
    Object.values(accounts).forEach(acc => {
        const row = document.createElement('div');
        row.style.cssText = "display:flex; align-items:center; justify-content:space-between; background:var(--surface-hover); padding:9px 10px; border-radius:11px; margin-bottom:6px; font-size:13px;";
        const isCurrent = acc.username === currentUser;
        
        row.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <img src="${getAvatarSrc(acc.avatarUrl, acc.username)}" style="width:26px; height:26px; border-radius:50%; object-fit:cover;">
                <span style="font-weight:${isCurrent ? '700' : '500'}; color:${isCurrent ? 'var(--success)' : 'var(--text)'}">${acc.username}</span>
            </div>
            ${!isCurrent ? `<button class="action-btn accept-btn" style="min-height:22px; font-size:11px; padding:2px 8px;" onclick="switchActiveAccount('${acc.username}')">Войти</button>` : ''}
        `;
        listContainer.appendChild(row);
    });
}

async function switchActiveAccount(username) {
    const accounts = getSavedAccounts();
    if (accounts[username]) {
        const verified = await verifySession(accounts[username].token);
        if (verified) {
            localStorage.setItem('giga_active_user', username);
            settingsModal.style.display = 'none';
            initMessenger(verified.username, verified.avatarUrl, verified.token);
        } else {
            alert("Сессия устарела");
            removeAccountFromStorage(username);
            renderAccountsList();
        }
    }
}

async function loadSecurityDevices() {
    const listContainer = document.getElementById('devices-list');
    listContainer.innerHTML = 'Загрузка...';
    try {
        const res = await fetch(`${BACKEND_URL}/api/security/devices`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${currentUserToken}` }
        });
        const devices = await res.json();
        listContainer.innerHTML = '';
        devices.forEach(dev => {
            const item = document.createElement('div');
            item.style.cssText = `display:flex; justify-content:space-between; align-items:center; background:var(--surface-hover); border-radius:10px; padding:9px 10px; border-left:3px solid ${dev.isCurrent ? 'var(--success)' : 'var(--border)'}; font-size:12px;`;
            
            let devName = "Устройство";
            if (dev.userAgent.includes("Chrome")) devName = "Chrome / Windows";
            else if (dev.userAgent.includes("Firefox")) devName = "Firefox";
            else if (dev.userAgent.includes("Safari")) devName = "Safari";

            item.innerHTML = `
                <div>
                    <div style="font-weight:700; color:${dev.isCurrent ? 'var(--success)' : 'var(--text)'}">${devName}</div>
                    <div style="color:var(--text-muted); font-size:10px;">IP: ${dev.ip}</div>
                </div>
                ${!dev.isCurrent ? `<button class="action-btn reject-btn" style="min-height:22px; font-size:10px; padding:2px 6px;" onclick="terminateDeviceSession('${dev.id}')">X</button>` : ''}
            `;
            listContainer.appendChild(item);
        });
    } catch(e) { listContainer.innerHTML = 'Ошибка'; }
}

async function terminateDeviceSession(id) {
    if (!confirm("Отключить устройство?")) return;
    try {
        const res = await fetch(`${BACKEND_URL}/api/security/devices/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${currentUserToken}` }
        });
        if (res.ok) loadSecurityDevices();
    } catch(e){}
}

document.getElementById('logout-btn').addEventListener('click', async () => {
    if (!confirm("Выйти из аккаунта?")) return;
    try { await fetch(`${BACKEND_URL}/api/auth/logout`, { method: 'POST', headers: { 'Authorization': `Bearer ${currentUserToken}` } }); } catch(e){}
    
    removeAccountFromStorage(currentUser);
    settingsModal.style.display = 'none';
    
    const accounts = getSavedAccounts();
    const remaining = Object.keys(accounts);
    if (remaining.length > 0) switchActiveAccount(remaining[0]);
    else {
        authContainer.style.display = 'flex';
        messengerContainer.style.display = 'none';
        if (socket) socket.disconnect();
    }
});

document.getElementById('add-account-btn').addEventListener('click', () => {
    settingsModal.style.display = 'none';
    authContainer.style.display = 'flex';
    messengerContainer.style.display = 'none';
    if (socket) socket.disconnect();
});

document.getElementById('save-avatar-btn').addEventListener('click', async () => {
    const dataUrl = avatarPickerState['profile'];
    const msg = document.getElementById('settings-avatar-msg');
    if (!dataUrl) { msg.style.color = 'var(--danger)'; msg.innerText = "Сначала выберите фото"; return; }

    toggleLoading(document.getElementById('save-avatar-btn'), true);
    try {
        const res = await fetch(`${BACKEND_URL}/api/settings/update-avatar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUserToken}` },
            body: JSON.stringify({ avatarUrl: dataUrl })
        });
        const d = await res.json();
        if(res.ok) {
            currentUserAvatar = d.avatarUrl;
            document.getElementById('my-avatar-img').src = getAvatarSrc(currentUserAvatar, currentUser);
            saveAccountToStorage(currentUser, currentUserAvatar, currentUserToken);
            delete avatarPickerState['profile'];
            msg.style.color = 'var(--success)'; msg.innerText = "Аватар изменен!";
        }
    } catch(e){}
    finally { toggleLoading(document.getElementById('save-avatar-btn'), false); }
});

document.getElementById('save-password-btn').addEventListener('click', async () => {
    const oldPassword = document.getElementById('settings-old-pass').value;
    const newPassword = document.getElementById('settings-new-pass').value;
    const msg = document.getElementById('settings-password-msg');
    if(!oldPassword || !newPassword) return;

    toggleLoading(document.getElementById('save-password-btn'), true);
    try {
        const res = await fetch(`${BACKEND_URL}/api/settings/change-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentUserToken}` },
            body: JSON.stringify({ oldPassword, newPassword })
        });
        if(res.ok) {
            msg.style.color = 'var(--success)'; msg.innerText = "Пароль изменен!";
            document.getElementById('settings-old-pass').value = '';
            document.getElementById('settings-new-pass').value = '';
        } else {
            const d = await res.json(); msg.style.color = 'var(--danger)'; msg.innerText = d.error;
        }
    } catch(e){}
    finally { toggleLoading(document.getElementById('save-password-btn'), false); }
});

// ================= ОТПРАВКА СООБЩЕНИЙ =================

function sendMessage() {
    const text = messageInput.value.trim();
    if (text !== '' && activeChatId && currentUser) {
        // Сервер сам подставит sender из авторизованного сокета —
        // отправлять его с клиента больше не нужно (и небезопасно).
        socket.emit('send_message', { chatId: activeChatId, text: text });
        messageInput.value = '';

        // Оптимистичный рендер: не ждём ответа сервера, чтобы
        // отправка ощущалась мгновенной.
        const el = appendMessage({ sender: currentUser, text }, { pending: true });
        pendingSentMessages.push({ text, element: el });
    }
}

document.getElementById('send-btn').addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

function appendMessage(msgData, options = {}) {
    const isMe = msgData.sender === currentUser;
    // Если предыдущее сообщение в чате от того же (не нашего) отправителя -
    // не повторяем аватарку и ник, просто визуально "прижимаем" сообщения друг к другу.
    const isGrouped = !isMe && lastRenderedSender === msgData.sender;
    lastRenderedSender = msgData.sender;

    const row = document.createElement('div');
    row.className = `msg-row ${isMe ? 'me' : 'other'}${isGrouped ? ' grouped' : ''}`;

    if (!isMe) {
        const avatarSlot = document.createElement('div');
        avatarSlot.className = 'msg-avatar-slot';
        if (!isGrouped) {
            const img = document.createElement('img');
            img.className = 'msg-avatar';
            img.alt = '';
            img.src = getCachedAvatarSrc(msgData.sender);
            avatarSlot.appendChild(img);
        }
        row.appendChild(avatarSlot);
    }

    const bubbleWrap = document.createElement('div');
    bubbleWrap.className = 'msg-bubble-wrap';

    if (!isMe && !isGrouped) {
        const authorDiv = document.createElement('div');
        authorDiv.className = 'msg-author';
        authorDiv.textContent = msgData.sender; // textContent — защита от XSS в нике
        bubbleWrap.appendChild(authorDiv);
    }

    const bubble = document.createElement('div');
    bubble.className = `msg ${isMe ? 'me' : 'other'}`;
    // textContent, а не innerHTML — иначе сообщение с HTML/скриптом
    // внутри выполнится у получателя (хранимый XSS).
    bubble.appendChild(document.createTextNode(msgData.text));
    bubbleWrap.appendChild(bubble);

    row.appendChild(bubbleWrap);
    if (options.pending) row.style.opacity = '0.55';

    messagesContainer.appendChild(row);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return row;
}

// Закрытие модалок по кнопкам
document.getElementById('close-profile-modal').onclick = () => profileModal.style.display = 'none';
document.getElementById('close-settings-modal').onclick = () => settingsModal.style.display = 'none';
document.getElementById('close-group-wizard-btn').onclick = () => groupWizardModal.style.display = 'none';
document.getElementById('close-group-settings-btn').onclick = () => groupSettingsModal.style.display = 'none';

// Клик по затемнённому фону (за пределами белого окна) закрывает модалку
document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.style.display = 'none';
    });
});

// ================= ВХОД / РЕГИСТРАЦИЯ =================

document.getElementById('register-btn').addEventListener('click', async () => {
    const u = document.getElementById('username').value.trim();
    const p = document.getElementById('password').value;
    if(!u || !p) return;
    toggleLoading(document.getElementById('register-btn'), true);
    try {
        const res = await fetch(`${BACKEND_URL}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });
        if (res.ok) { authError.style.color = 'var(--success)'; authError.innerText = "Успешно! Войдите."; }
        else { const d = await res.json(); authError.innerText = d.error; }
    } catch (err) {} 
    finally { toggleLoading(document.getElementById('register-btn'), false); }
});

document.getElementById('login-btn').addEventListener('click', async () => {
    const u = document.getElementById('username').value.trim();
    const p = document.getElementById('password').value;
    if(!u || !p) return;
    toggleLoading(document.getElementById('login-btn'), true);
    try {
        const res = await fetch(`${BACKEND_URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json();
        if (res.ok) {
            if (saveAccountToStorage(data.username, data.avatarUrl, data.token) !== false) {
                initMessenger(data.username, data.avatarUrl, data.token);
            }
        } else { authError.innerText = data.error; }
    } catch (err) {} 
    finally { toggleLoading(document.getElementById('login-btn'), false); }
});