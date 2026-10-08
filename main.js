const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const os = require('os');
const fs = require('fs');
const iconv = require('iconv-lite');

// 启动内嵌 Express 服务
const expressApp = express();
const server = http.createServer(expressApp);
const io = require('socket.io')(server);

const PORT = 3000;
let mainWindow = null;
let editorWindow = null;
let currentQueue = [];
let currentPitchVal = 0;

// 配置文件路径持久化存储
const CONFIG_PATH = path.join(app.getPath('userData'), 'joyhack-config.json');

function loadSavedConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            if (data.songsDirectory && fs.existsSync(data.songsDirectory)) {
                return data.songsDirectory;
            }
        }
    } catch (e) {
        console.error("加载本地配置失败:", e);
    }

    try {
        const rootConfig = path.join(__dirname, 'config.json');
        if (fs.existsSync(rootConfig)) {
            const data = JSON.parse(fs.readFileSync(rootConfig, 'utf8'));
            const customDir = data.songsDir || data.songsDirectory;
            if (customDir && fs.existsSync(customDir)) {
                return customDir;
            }
        }
    } catch (e) {}

    const defaultSongsDir = path.join(__dirname, 'Songs');
    if (fs.existsSync(defaultSongsDir)) return defaultSongsDir;

    return path.join(os.homedir(), 'Songs');
}

function saveConfig(dirPath) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ songsDirectory: dirPath }, null, 2), 'utf8');
    } catch (e) {
        console.error("保存本地配置失败:", e);
    }
}

let songsDirectory = loadSavedConfig();

expressApp.use(express.json());
expressApp.use(express.static(path.join(__dirname, 'public')));

// API: 获取/设置曲库路径
expressApp.get('/api/config/songs-dir', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({ songsDir: songsDirectory });
});

expressApp.post('/api/config/songs-dir', (req, res) => {
    if (req.body.songsDir) {
        songsDirectory = path.resolve(req.body.songsDir);
        saveConfig(songsDirectory);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({ songsDir: songsDirectory });
});

// API: 获取局域网访问 URL
expressApp.get('/api/config/network-info', (req, res) => {
    const interfaces = os.networkInterfaces();
    let lanIp = '127.0.0.1';
    for (let name of Object.keys(interfaces)) {
        for (let net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                lanIp = net.address;
                break;
            }
        }
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({ lanUrl: `http://${lanIp}:${PORT}/admin` });
});

/**
 * 带有全方位编码嗅探的解码器
 * 自动识别 UTF-16LE, UTF-16BE, UTF-8 (BOM/无BOM), 并回退到 CP932 / Shift_JIS
 */
function decodeJapaneseBuffer(buffer) {
    if (!buffer || buffer.length === 0) return '';

    // 1. 嗅探 UTF-16LE BOM (Windows 记事本 Unicode)
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
        return iconv.decode(buffer, 'utf16le');
    }
    // 2. 嗅探 UTF-16BE BOM
    if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
        return iconv.decode(buffer, 'utf16be');
    }
    // 3. 嗅探 UTF-8 BOM
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        return iconv.decode(buffer, 'utf8');
    }

    // 4. 字节流探测：如果前 100 字节内发现空字节，极大概率是无 BOM 的 UTF-16LE
    let hasNull = false;
    for (let i = 0; i < Math.min(buffer.length, 100); i++) {
        if (buffer[i] === 0x00) {
            hasNull = true;
            break;
        }
    }
    if (hasNull) return iconv.decode(buffer, 'utf16le');

    // 5. 尝试严格模式的 UTF-8 解码
    let strUtf8 = iconv.decode(buffer, 'utf8');
    if (!strUtf8.includes('\uFFFD')) {
        return strUtf8;
    }

    // 6. 终极回退方案：CP932 / Shift_JIS (日文系统标准格式)
    return iconv.decode(buffer, 'cp932');
}

/**
 * 安全抗干扰的 Tag 解析器
 * 强制剔除所有零宽字符、BOM 与非法空字节残留，确保正则不被打断
 */
function parseTag(text, tagName) {
    if (!text) return '';
    const cleanText = text.replace(/[\u200B-\u200D\uFEFF\0]/g, '');
    const reg = new RegExp(`<\\s*${tagName}\\s*>([^<]*)`, 'i');
    const match = cleanText.match(reg);
    if (match && match[1]) {
        return match[1].trim();
    }
    return '';
}

// API: 获取曲库列表
expressApp.get('/api/songs', (req, res) => {
    const results = [];
    const targetDir = path.resolve(songsDirectory);

    if (!fs.existsSync(targetDir)) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.json([]);
    }

    function scanDir(dir) {
        try {
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                const fullPath = path.join(dir, file);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        scanDir(fullPath);
                    } else if (path.extname(file).toLowerCase() === '.txt') {
                        try {
                            const buffer = fs.readFileSync(fullPath);
                            const content = decodeJapaneseBuffer(buffer);

                            const title = parseTag(content, 'title') || path.basename(file, '.txt');
                            const singer = parseTag(content, 'singer') || '其他 / 未知';
                            const works = parseTag(content, 'works') || '其他 / 未知';

                            let year = '未知年份';
                            const rawYear = parseTag(content, 'year') || parseTag(content, 'date');
                            if (rawYear) {
                                const numMatch = rawYear.match(/\d{4}/);
                                if (numMatch) {
                                    year = numMatch[0];
                                }
                            }

                            const searchKey = parseTag(content, 'searchKey') || title;

                            results.push({
                                title: title,
                                singer: singer,
                                works: works,
                                year: year,
                                searchKey: searchKey,
                                txtFile: fullPath
                            });
                        } catch (err) {
                            console.error("解析歌词标签出错:", fullPath, err);
                        }
                    }
                } catch (err) {
                    // 忽略单项文件异常
                }
            });
        } catch (err) {
            console.error("扫描目录失败:", dir, err);
        }
    }

    scanDir(targetDir);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json(results);
});

// API: 队列管理
expressApp.get('/api/queue', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json(currentQueue);
});

expressApp.post('/api/queue', (req, res) => {
    let { txtFile, title, singer, works, year, pitch } = req.body;

    if (!txtFile) {
        return res.status(400).json({ error: "参数缺失" });
    }

    try {
        txtFile = decodeURIComponent(txtFile);
    } catch (e) {}
    txtFile = path.normalize(txtFile);

    if (!fs.existsSync(txtFile)) {
        console.error("点歌失败，找不到文件:", txtFile);
        return res.status(404).json({ error: "找不到指定的歌词文件" });
    }

    const songItem = {
        title: title || path.basename(txtFile, '.txt'),
        singer: singer || 'N/A',
        works: works || 'N/A',
        year: year || 'N/A',
        txtFile: txtFile,
        pitch: typeof pitch === 'number' ? pitch : 0
    };

    currentQueue.push(songItem);
    io.emit('update-queue', currentQueue);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({ success: true, queue: currentQueue });
});

expressApp.delete('/api/queue/:index', (req, res) => {
    const index = parseInt(req.params.index, 10);
    if (!isNaN(index) && index >= 0 && index < currentQueue.length) {
        currentQueue.splice(index, 1);
        io.emit('update-queue', currentQueue);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json({ success: true, queue: currentQueue });
    } else {
        res.status(400).json({ error: "索引无效" });
    }
});

expressApp.post('/api/queue/reorder', (req, res) => {
    const { fromIndex, toIndex } = req.body;
    if (
        typeof fromIndex === 'number' && typeof toIndex === 'number' &&
        fromIndex >= 1 && fromIndex < currentQueue.length &&
        toIndex >= 1 && toIndex < currentQueue.length
    ) {
        const [movedItem] = currentQueue.splice(fromIndex, 1);
        currentQueue.splice(toIndex, 0, movedItem);
        io.emit('update-queue', currentQueue);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json({ success: true, queue: currentQueue });
    } else {
        res.status(400).json({ error: "顺序重排参数无效" });
    }
});

expressApp.post('/api/queue/play-now', (req, res) => {
    const { index } = req.body;
    if (typeof index === 'number' && index > 0 && index < currentQueue.length) {
        const targetSong = currentQueue.splice(index, 1)[0];
        if (currentQueue.length > 0) {
            currentQueue.shift();
        }
        currentQueue.unshift(targetSong);
        io.emit('update-queue', currentQueue);
        io.emit('broadcast-command', 'PLAY_NOW');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json({ success: true, queue: currentQueue });
    } else {
        res.status(400).json({ error: "插播索引无效" });
    }
});

// Web 静态管理与编辑器后台路由
expressApp.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

expressApp.get('/editor', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

// Socket.io 实时同步
io.on('connection', (socket) => {
    socket.emit('update-queue', currentQueue);
    socket.emit('broadcast-pitch', currentPitchVal);

    socket.on('send-command', (cmd) => {
        io.emit('broadcast-command', cmd);
    });

    socket.on('change-pitch', (val) => {
        currentPitchVal = val;
        if (currentQueue.length > 0) {
            currentQueue[0].pitch = val;
        }
        io.emit('broadcast-pitch', val);
        io.emit('update-queue', currentQueue);
    });

    socket.on('seek-progress', (percent) => {
        io.emit('broadcast-seek', percent);
    });

    socket.on('change-volume', (vol) => {
        io.emit('broadcast-volume', vol);
    });

    socket.on('sync-progress', (data) => {
        io.emit('broadcast-progress', data);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP/WebSocket Server running on http://localhost:${PORT}`);
});

function createEditorWindow() {
    if (editorWindow) {
        editorWindow.focus();
        return;
    }
    editorWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    editorWindow.loadFile(path.join(__dirname, 'public', 'editor.html'));

    const editorMenuTemplate = [
        {
            label: 'ファイル',
            submenu: [
                { 
                    label: '新規', 
                    accelerator: 'CmdOrCtrl+N', 
                    click: () => editorWindow.webContents.send('EDITOR_CMD', 'NEW') 
                },
                { 
                    label: '開く...', 
                    accelerator: 'CmdOrCtrl+O', 
                    click: async () => {
                        const result = await dialog.showOpenDialog(editorWindow, {
                            properties: ['openFile'],
                            filters: [{ name: 'JoyHack Song Files', extensions: ['txt'] }]
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            const filePath = result.filePaths[0];
                            try {
                                const buffer = fs.readFileSync(filePath);
                                const content = decodeJapaneseBuffer(buffer);
                                const fileName = path.basename(filePath);
                                editorWindow.webContents.send('LOAD_SONG_CONTENT', { filePath, fileName, content });
                            } catch (e) {
                                console.error("读取文件失败", e);
                            }
                        }
                    } 
                },
                { type: 'separator' },
                { 
                    label: '保存', 
                    accelerator: 'CmdOrCtrl+S', 
                    click: () => editorWindow.webContents.send('EDITOR_CMD', 'SAVE') 
                },
                { 
                    label: '別名で保存...', 
                    accelerator: 'CmdOrCtrl+Shift+S', 
                    click: () => editorWindow.webContents.send('EDITOR_CMD', 'SAVE_AS') 
                },
                { type: 'separator' },
                { 
                    label: 'プレフィレンツ / 設定...', 
                    accelerator: 'CmdOrCtrl+,', 
                    click: () => editorWindow.webContents.send('EDITOR_CMD', 'OPEN_SETTINGS') 
                },
                { type: 'separator' },
                { label: '終了', accelerator: 'CmdOrCtrl+Q', click: () => editorWindow.close() }
            ]
        },
        {
            label: '編集',
            submenu: [
                { role: 'undo', label: '取り消し' },
                { type: 'separator' },
                { role: 'cut', label: 'カット' },
                { role: 'copy', label: 'コピー' },
                { role: 'paste', label: 'ペースト' },
                { role: 'delete', label: '削除' },
                { type: 'separator' },
                { role: 'selectall', label: 'すべてを選択' }
            ]
        },
        {
            label: 'タグ',
            submenu: [
                { label: '<clear>', accelerator: 'CmdOrCtrl+Alt+C', click: () => editorWindow.webContents.send('EDITOR_CMD', 'TAG_CLEAR') },
                { label: '<color>', accelerator: 'CmdOrCtrl+Alt+O', click: () => editorWindow.webContents.send('EDITOR_CMD', 'TAG_COLOR') },
                { label: '<image>', accelerator: 'CmdOrCtrl+Alt+I', click: () => editorWindow.webContents.send('EDITOR_CMD', 'TAG_IMAGE') },
                { label: '<skip>', accelerator: 'CmdOrCtrl+Alt+S', click: () => editorWindow.webContents.send('EDITOR_CMD', 'TAG_SKIP') }
            ]
        },
        {
            label: 'ウィンドウ',
            submenu: [
                { role: 'togglefullscreen', label: '拡大/縮小' },
                { role: 'minimize', label: 'しまう' },
                { type: 'separator' },
                { label: 'すべてを手前に移動', click: () => editorWindow.setAlwaysOnTop(true) }
            ]
        },
        {
            label: 'ヘルプ',
            submenu: [
                { label: 'RecENT ヘルプ', click: () => shell.openExternal('https://desireforwealth.com/joyhack/rec.shtml') },
                { type: 'separator' },
                { label: 'RecENT について', click: () => dialog.showMessageBox(editorWindow, { title: '关于 RecENT', message: 'RecENT for JoyHack Lyric Editor v2.1.0' }) }
            ]
        }
    ];

    const editorMenu = Menu.buildFromTemplate(editorMenuTemplate);
    editorWindow.setMenu(editorMenu);

    editorWindow.on('closed', () => {
        editorWindow = null;
    });
}

function createWindow() {
    const isEditorMode = process.argv.includes('--editor');
    if (isEditorMode) {
        createEditorWindow();
        return;
    }

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'public', 'player.html'));

    const template = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Open Local Song...',
                    accelerator: 'CmdOrCtrl+O',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ['openFile'],
                            filters: [{ name: 'JoyHack Song Files', extensions: ['txt'] }]
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            mainWindow.webContents.send('OPEN_KAROKE_FILE', result.filePaths[0]);
                        }
                    }
                },
                { type: 'separator' },
                { 
                    label: 'Preferences / Settings...', 
                    accelerator: 'CmdOrCtrl+,', 
                    click: () => {
                        mainWindow.webContents.send('TOGGLE_SETTINGS_MODAL');
                    }
                },
                { type: 'separator' },
                { role: 'quit', label: 'Exit' }
            ]
        },
        {
            label: 'Control',
            submenu: [
                { label: 'Play / Pause', accelerator: 'Space', click: () => mainWindow.webContents.send('MENU_COMMAND', 'TOGGLE_PLAY') },
                { label: 'Restart Song', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.webContents.send('MENU_COMMAND', 'RESTART') },
                { label: 'Next Song (Cut)', accelerator: 'CmdOrCtrl+N', click: () => mainWindow.webContents.send('MENU_COMMAND', 'NEXT_SONG') },
                { label: 'Toggle Vocal / Inst', accelerator: 'CmdOrCtrl+M', click: () => mainWindow.webContents.send('MENU_COMMAND', 'TOGGLE_VOCAL') },
                { type: 'separator' },
                { label: 'Pitch +1', accelerator: 'CmdOrCtrl+Up', click: () => mainWindow.webContents.send('MENU_COMMAND', 'PITCH_UP') },
                { label: 'Pitch -1', accelerator: 'CmdOrCtrl+Down', click: () => mainWindow.webContents.send('MENU_COMMAND', 'PITCH_DOWN') },
                { label: 'Reset Pitch (0)', accelerator: 'CmdOrCtrl+0', click: () => mainWindow.webContents.send('MENU_COMMAND', 'PITCH_RESET') }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'toggleDevTools', label: 'Toggle Developer Tools' },
                { role: 'togglefullscreen', label: 'Toggle Full Screen' },
                { type: 'separator' },
                { 
                    label: 'Open Lyric Editor', 
                    click: () => {
                        createEditorWindow();
                    }
                }
            ]
        },
        {
            label: 'About',
            submenu: [
                { 
                    label: 'About JoyHack Player', 
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: 'About JoyHack Player Engine',
                            message: 'JoyHack Player Engine',
                            detail: 'Version: v0.8.1 (Build 2026)\nCustom Karaoke Engine for JoyHack.'
                        });
                    } 
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

ipcMain.handle('SELECT_SONGS_DIR', async () => {
    const result = await dialog.showOpenDialog(mainWindow || editorWindow, {
        properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        songsDirectory = path.resolve(result.filePaths[0]);
        saveConfig(songsDirectory);
        return songsDirectory;
    }
    return null;
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});