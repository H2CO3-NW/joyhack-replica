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
let isEditorDirty = false;

ipcMain.on('SET_EDITOR_DIRTY', (event, dirty) => {
    isEditorDirty = dirty;
});

ipcMain.on('CONFIRM_CLOSE_EDITOR', () => {
    if (editorWindow) {
        editorWindow.destroy();
        editorWindow = null;
    }
});
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

    ﻿/**
 * 歌词文件编码检测与无损转换为标准 UTF-8 (BOM)
 */
function fixSongBufferToUtf8(buffer) {
    if (!buffer || buffer.length === 0) return { fixed: false, content: '' };

    // 1. 嗅探并解析 ISO-2022-JP (JIS)
    let hasIsoEsc = false;
    for (let i = 0; i < buffer.length - 2; i++) {
        if (buffer[i] === 0x1B && buffer[i+1] === 0x24 && (buffer[i+2] === 0x42 || buffer[i+2] === 0x40)) {
            hasIsoEsc = true;
            break;
        }
    }
    if (hasIsoEsc) {
        const eucBytes = [];
        let mode = 'ascii';
        let i = 0;
        while (i < buffer.length) {
            if (buffer[i] === 0x1B && i + 2 < buffer.length) {
                if (buffer[i+1] === 0x24 && (buffer[i+2] === 0x42 || buffer[i+2] === 0x40)) {
                    mode = 'jis0208';
                    i += 3;
                    continue;
                } else if (buffer[i+1] === 0x28 && (buffer[i+2] === 0x42 || buffer[i+2] === 0x4A)) {
                    mode = 'ascii';
                    i += 3;
                    continue;
                } else if (buffer[i+1] === 0x28 && buffer[i+2] === 0x49) {
                    mode = 'kana';
                    i += 3;
                    continue;
                }
            }
            if (mode === 'ascii') {
                eucBytes.push(buffer[i]);
                i++;
            } else if (mode === 'jis0208') {
                if (i + 1 < buffer.length) {
                    eucBytes.push(buffer[i] | 0x80);
                    eucBytes.push(buffer[i+1] | 0x80);
                    i += 2;
                } else {
                    eucBytes.push(buffer[i]);
                    i++;
                }
            } else if (mode === 'kana') {
                eucBytes.push(0x8E);
                eucBytes.push(buffer[i] | 0x80);
                i++;
            }
        }
        const text = iconv.decode(Buffer.from(eucBytes), 'euc-jp');
        return { fixed: true, encoding: 'ISO-2022-JP', content: text };
    }

    // 2. 嗅探并解析 UTF-7
    const rawAscii = buffer.toString('binary');
    if (rawAscii.includes('+ADw-') || rawAscii.includes('+AD4-')) {
        const text = rawAscii.replace(/\+([A-Za-z0-9\/]+)-/g, (match, b64) => {
            try {
                return iconv.decode(Buffer.from(b64, 'base64'), 'utf16be');
            } catch(e) {
                return match;
            }
        }).replace(/\+-/g, '+');
        return { fixed: true, encoding: 'UTF-7', content: text };
    }

    // 3. 嗅探 UTF-16LE / BE
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
        return { fixed: true, encoding: 'UTF-16LE', content: iconv.decode(buffer, 'utf16le') };
    }
    if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
        return { fixed: true, encoding: 'UTF-16BE', content: iconv.decode(buffer, 'utf16be') };
    }

    // 4. 标准 UTF-8 (BOM)
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        return { fixed: false, encoding: 'UTF-8 (BOM)', content: iconv.decode(buffer, 'utf8') };
    }

    // 5. UTF-8 vs Shift-JIS / CP932
    let strUtf8 = iconv.decode(buffer, 'utf8');
    if (!strUtf8.includes('\uFFFD')) {
        return { fixed: false, encoding: 'UTF-8', content: strUtf8 };
    } else {
        const text = iconv.decode(buffer, 'cp932');
        return { fixed: true, encoding: 'Shift-JIS/CP932', content: text };
    }
}

/**
 * 修正单个歌词文件
 */
function fixSingleSongFile(filePath, parentWin) {
    try {
        const buffer = fs.readFileSync(filePath);
        const res = fixSongBufferToUtf8(buffer);
        if (res.fixed) {
            fs.writeFileSync(filePath, '\uFEFF' + res.content, 'utf8');
            dialog.showMessageBox(parentWin, {
                type: 'info',
                title: '歌词编码修正成功',
                message: '已成功修正文件编码！\n\n文件: ' + path.basename(filePath) + '\n原编码: ' + res.encoding + '\n已转换为: UTF-8 (BOM)'
            });
            return true;
        } else {
            dialog.showMessageBox(parentWin, {
                type: 'info',
                title: '无需修正',
                message: '文件: ' + path.basename(filePath) + '\n该文件当前已经是标准的 ' + res.encoding + ' 编码，无需转换。'
            });
            return false;
        }
    } catch (e) {
        dialog.showMessageBox(parentWin, {
            type: 'error',
            title: '修正失败',
            message: '修正歌词文件失败: ' + e.message
        });
        return false;
    }
}

/**
 * 批量扫描并修正曲库下所有 .txt 歌词
 */
function batchFixSongsDirectory(songsDir, parentWin) {
    if (!fs.existsSync(songsDir)) {
        dialog.showMessageBox(parentWin, { type: 'warning', title: '曲库不存在', message: '曲库目录不存在: ' + songsDir });
        return;
    }
    const fixedFiles = [];
    function scanAndFix(dir) {
        const list = fs.readdirSync(dir);
        list.forEach(item => {
            const p = path.join(dir, item);
            const stat = fs.statSync(p);
            if (stat.isDirectory()) {
                scanAndFix(p);
            } else if (path.extname(item).toLowerCase() === '.txt') {
                try {
                    const buf = fs.readFileSync(p);
                    const res = fixSongBufferToUtf8(buf);
                    if (res.fixed) {
                        fs.writeFileSync(p, '\uFEFF' + res.content, 'utf8');
                        fixedFiles.push({ file: path.relative(songsDir, p), enc: res.encoding });
                    }
                } catch(err) {
                    console.error('修复文件失败:', p, err);
                }
            }
        });
    }
    scanAndFix(songsDir);
    if (fixedFiles.length > 0) {
        const details = fixedFiles.slice(0, 10).map(f => '• ' + f.file + ' (原: ' + f.enc + ')').join('\n') + (fixedFiles.length > 10 ? ('\n...等共 ' + fixedFiles.length + ' 个文件') : '');
        dialog.showMessageBox(parentWin, {
            type: 'info',
            title: '批量编码修正完成',
            message: '扫描完成！共成功转换 ' + fixedFiles.length + ' 个歌词文件为标准 UTF-8：\n\n' + details
        });
    } else {
        dialog.showMessageBox(parentWin, {
            type: 'info',
            title: '扫描完成',
            message: '曲库中所有歌词文件均符合标准 UTF-8 编码，无需修正。'
        });
    }
}
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

    let forceCloseEditor = false;

    editorWindow.on('close', (e) => {
        if (forceCloseEditor) {
            forceCloseEditor = false;
            return;
        }

        if (isEditorDirty) {
            e.preventDefault();
            const choice = dialog.showMessageBoxSync(editorWindow, {
                type: 'question',
                buttons: ['保存する', '保存しない', 'キャンセル'],
                defaultId: 0,
                cancelId: 2,
                title: 'RecENT (JoyHack)',
                message: '現在の編集内容を保存しますか？',
                detail: '保存しない場合、変更内容はすべて破棄されます。'
            });

            if (choice === 0) {
                editorWindow.webContents.send('PROMPT_SAVE_BEFORE_CLOSE');
            } else if (choice === 1) {
                forceCloseEditor = true;
                editorWindow.close();
            } else {
                // Cancel
            }
        }
    });

    editorWindow.on('closed', () => {
        editorWindow = null;
        isEditorDirty = false;
        forceCloseEditor = false;
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

﻿    const template = [
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
                { role: 'togglefullscreen', label: 'Toggle Full Screen' }
            ]
        },
        {
            label: 'Tools',
            submenu: [
                {
                    label: 'Open Lyric Editor (RecENT)',
                    accelerator: 'CmdOrCtrl+E',
                    click: () => {
                        createEditorWindow();
                    }
                },
                { type: 'separator' },
                {
                    label: '歌词文件编码修正 (选择文件)...',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ['openFile'],
                            filters: [{ name: 'JoyHack Song Files', extensions: ['txt'] }]
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            const success = fixSingleSongFile(result.filePaths[0], mainWindow);
                            if (success && editorWindow) {
                                try {
                                    const buf = fs.readFileSync(result.filePaths[0]);
                                    const c = decodeJapaneseBuffer(buf);
                                    editorWindow.webContents.send('LOAD_SONG_CONTENT', {
                                        filePath: result.filePaths[0],
                                        fileName: path.basename(result.filePaths[0]),
                                        content: c
                                    });
                                } catch (e) {}
                            }
                        }
                    }
                },
                {
                    label: '批量扫描并修正曲库歌词编码 (Songs)...',
                    click: () => {
                        batchFixSongsDirectory(songsDirectory, mainWindow);
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
                            detail: 'Version: v0.8.5 (Build 2026)\nCustom Karaoke Engine for JoyHack.'
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

ipcMain.handle('SELECT_MEDIA_FILE', async () => {
    const result = await dialog.showOpenDialog(editorWindow || mainWindow, {
        properties: ['openFile'],
        filters: [
            { name: 'Media Files (Audio / Video)', extensions: ['mp4', 'mp3', 'wav', 'm4a', 'avi', 'mpg', 'wma'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

ipcMain.handle('SELECT_TITLE_IMAGE_FILE', async () => {
    const result = await dialog.showOpenDialog(editorWindow || mainWindow, {
        properties: ['openFile'],
        filters: [
            { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'bmp'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});