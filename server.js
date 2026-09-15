const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let playQueue = [];

app.get('/admin', (req, res) => {
    const adminPath = path.join(__dirname, 'public', 'admin.html');
    if (fs.existsSync(adminPath)) {
        res.sendFile(adminPath);
    } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

function decodeJapaneseBuffer(buffer) {
    let str = iconv.decode(buffer, 'cp932');
    if (str.includes('\uFFFD')) { 
        let strShiftJis = iconv.decode(buffer, 'Shift_JIS');
        if (!strShiftJis.includes('\uFFFD')) return strShiftJis;
        return iconv.decode(buffer, 'utf-8');
    }
    return str;
}

function parseTag(text, tagName) {
    const reg = new RegExp(`<${tagName}>([^<]+)`, 'i');
    const match = text.match(reg);
    return match ? match[1].trim() : '';
}

app.get('/api/songs', (req, res) => {
    const songsDir = path.join(__dirname, 'Songs');
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
                    const singer = parseTag(content, 'singer') || 'N/A';
                    const works = parseTag(content, 'works') || 'N/A';

                    songList.push({
                        title: title,
                        singer: singer,
                        works: works,
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
    let { txtFile, title, singer, works } = req.body;

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
        txtFile: txtFile
    };

    playQueue.push(songItem);
    io.emit('update-queue', playQueue);
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
        io.emit('update-queue', playQueue);
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
        io.emit('update-queue', playQueue);
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
        io.emit('update-queue', playQueue);
        res.json({ success: true, queue: playQueue });
    } else {
        res.status(400).json({ error: "索引无效" });
    }
});

io.on('connection', (socket) => {
    socket.on('send-command', (cmd) => {
        io.emit('broadcast-command', cmd);
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