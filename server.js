const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let playQueue = [];
let customSongsDir = null;

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (let devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return '127.0.0.1';
}

app.get('/admin', (req, res) => {
    const adminPath = path.join(__dirname, 'public', 'admin.html');
    if (fs.existsSync(adminPath)) {
        res.sendFile(adminPath);
    } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

/**
 * 带有全方位编码嗅探的解码器
 * 自动识别 UTF-16LE, UTF-16BE, UTF-8 (BOM/无BOM), 并回退到 CP932
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
 */
function parseTag(text, tagName) {
    if (!text) return '';
    // 强制剔除所有零宽字符、BOM 与非法空字节残留，确保正则不被打断
    const cleanText = text.replace(/[\u200B-\u200D\uFEFF\0]/g, '');
    const reg = new RegExp(`<\\s*${tagName}\\s*>([^<]*)`, 'i');
    const match = cleanText.match(reg);
    if (match && match[1]) {
        return match[1].trim();
    }
    return '';
}

function getSongsDir() {
    if (customSongsDir && fs.existsSync(customSongsDir)) {
        return customSongsDir;
    }
    const defaultPath = path.join(__dirname, 'Songs');
    if (fs.existsSync(defaultPath)) return defaultPath;
    
    const resourcesPath = path.join(process.resourcesPath || __dirname, 'Songs');
    if (fs.existsSync(resourcesPath)) return resourcesPath;

    return defaultPath;
}

function broadcastQueueUpdate() {
    io.emit('update-queue', playQueue);
}

app.get('/api/config/songs-dir', (req, res) => {
    res.json({ songsDir: getSongsDir() });
});

app.post('/api/config/songs-dir', (req, res) => {
    const { songsDir } = req.body;
    if (songsDir && fs.existsSync(songsDir)) {
        customSongsDir = songsDir;
        res.json({ success: true, songsDir: customSongsDir });
    } else {
        res.status(400).json({ error: "指定的曲库路径不存在" });
    }
});

app.get('/api/config/network-info', (req, res) => {
    const ip = getLocalIP();
    const port = PORT;
    res.json({
        ip: ip,
        localUrl: `http://localhost:${port}/admin`,
        lanUrl: `http://${ip}:${port}/admin`
    });
});

app.get('/api/songs', (req, res) => {
    const songsDir = getSongsDir();
    if (!fs.existsSync(songsDir)) {
        return res.json([]);
    }

    const songList = [];

    function scanDir(dir) {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const fullPath = path.join(dir, file);
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

                    songList.push({
                        title: title,
                        singer: singer,
                        works: works,
                        year: year,
                        searchKey: searchKey,
                        txtFile: fullPath
                    });
                } catch (e) {
                    console.error("读取歌词文件失败:", fullPath, e);
                }
            }
        });
    }

    scanDir(songsDir);
    res.json(songList);
});

app.get('/api/queue', (req, res) => {
    res.json(playQueue);
});

app.post('/api/queue', (req, res) => {
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

    playQueue.push(songItem);
    broadcastQueueUpdate();
    res.json({ success: true, queue: playQueue });
});

app.post('/api/queue/reorder', (req, res) => {
    const { fromIndex, toIndex } = req.body;
    if (
        typeof fromIndex === 'number' && typeof toIndex === 'number' &&
        fromIndex >= 1 && fromIndex < playQueue.length &&
        toIndex >= 1 && toIndex < playQueue.length
    ) {
        const item = playQueue.splice(fromIndex, 1)[0];
        playQueue.splice(toIndex, 0, item);
        broadcastQueueUpdate();
        res.json({ success: true, queue: playQueue });
    } else {
        res.status(400).json({ error: "顺序重排参数无效" });
    }
});

app.post('/api/queue/play-now', (req, res) => {
    const { index } = req.body;
    if (typeof index === 'number' && index > 0 && index < playQueue.length) {
        const targetSong = playQueue.splice(index, 1)[0];
        if (playQueue.length > 0) {
            playQueue.shift();
        }
        playQueue.unshift(targetSong);
        broadcastQueueUpdate();
        io.emit('broadcast-command', 'PLAY_NOW');
        res.json({ success: true, queue: playQueue });
    } else {
        res.status(400).json({ error: "插播索引无效" });
    }
});

app.delete('/api/queue/:index', (req, res) => {
    const idx = parseInt(req.params.index, 10);
    if (!isNaN(idx) && idx >= 0 && idx < playQueue.length) {
        playQueue.splice(idx, 1);
        broadcastQueueUpdate();
        res.json({ success: true, queue: playQueue });
    } else {
        res.status(400).json({ error: "索引无效" });
    }
});

io.on('connection', (socket) => {
    socket.emit('update-queue', playQueue);

    socket.on('send-command', (cmd) => {
        io.emit('broadcast-command', cmd);
    });

    socket.on('change-pitch', (pitchVal) => {
        if (playQueue.length > 0) {
            playQueue[0].pitch = pitchVal;
            broadcastQueueUpdate();
        }
        io.emit('broadcast-pitch', pitchVal);
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

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`JoyHack Server 启动成功，监听端口: http://127.0.0.1:${PORT}`);
});