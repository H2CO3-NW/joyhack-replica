/**
 * JoyHack 歌词流与元数据解析模块
 * 提供时间码换算、Tag 提取及 JoyHack 线性歌词流状态机解析
 */

/**
 * 安全抗干扰的 Tag 解析器
 * 过滤零宽字符、BOM 与非法空字节残留，支持空白字符容错
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

/**
 * 将 JoyHack 时间码 (mm:ss:ff，以 60fps 帧计数) 转换为绝对秒数
 */
function timeCodeToSeconds(tcStr) {
    if (!tcStr) return 0;
    const parts = tcStr.split(':');
    if (parts.length < 3) return 0;
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10) + (parseInt(parts[2], 10) / 60.0);
}

/**
 * 解析 JoyHack 歌词文件文本流
 * 返回结构化的短语数组，包含多行槽位、发音、擦除染色时间轴与和声副行
 */
function parseJoyHackLinearStream(text) {
    if (!text) return [];
    const lines = text.split(/[\r\n]+/);
    let activeLinesCount = 2;

    let mainColors = {
        fillBefore: '#FFFFFF', edgeBefore: '#000000', fillAfter: '#FF0033', edgeAfter: '#FFFFFF',
        rubyFillBefore: '#FFFFFF', rubyEdgeBefore: '#000000', rubyFillAfter: '#FF0033', rubyEdgeAfter: '#FFFFFF'
    };

    let subColors = {
        fillBefore: '#FFFFFF', edgeBefore: '#000000', fillAfter: '#FF0033', edgeAfter: '#FFFFFF',
        rubyFillBefore: '#FFFFFF', rubyEdgeBefore: '#000000', rubyFillAfter: '#FF0033', rubyEdgeAfter: '#FFFFFF'
    };

    const phrases = [];

    lines.forEach(line => {
        if (!line.trim() && !line.includes('\t')) return;

        // 忽略纯元数据标签行（保留含歌词控制的标签）
        if (line.match(/^<[a-zA-Z0-9_]+>/) && !line.includes('<time>') && !line.includes('<clear>') && !line.includes('<sub>') && !line.includes('<color>')) {
            return;
        }

        let isClear = false;
        if (line.includes('<clear>')) {
            isClear = true;
            const matchNum = line.match(/<clear>([1-4])/);
            if (matchNum) activeLinesCount = parseInt(matchNum[1], 10);
        }

        let isSub = false;
        if (line.includes('<sub>')) {
            isSub = true;
            line = line.replace(/<\/?sub>/g, '');
        }

        const timeTagIndex = line.indexOf('<time>');
        if (timeTagIndex === -1) {
            return;
        }

        const textPart = line.substring(0, timeTagIndex);
        const timePart = line.substring(timeTagIndex);

        const timeRegex = /\b\d{2}:\d{2}:\d{2}\b/g;
        const timeMatches = timePart.match(timeRegex);
        if (!timeMatches || timeMatches.length === 0) return;

        const timeCodes = timeMatches.map(timeCodeToSeconds);
        const showTime = timeCodes[0];
        const endTime = timeCodes[timeCodes.length - 1];

        const cleanTextPart = textPart.replace(/<clear>[1-4]?/g, '');
        const rawWords = cleanTextPart.split('\t');

        const wordList = [];
        for (let i = 0; i < rawWords.length; i++) {
            let wText = rawWords[i];
            const wStart = timeCodes[i] !== undefined ? timeCodes[i] : showTime;
            const wEnd = timeCodes[i + 1] !== undefined ? timeCodes[i + 1] : endTime;

            if (wText.includes('<color>')) {
                const colorMatch = wText.match(/<color>([^<\t\r\n]+)/);
                if (colorMatch) {
                    const cArgs = colorMatch[1].split(',');
                    const targetColorObj = isSub ? subColors : mainColors;

                    if (cArgs[0] && cArgs[0].trim()) targetColorObj.fillBefore = '#' + cArgs[0].trim();
                    if (cArgs[1] && cArgs[1].trim()) targetColorObj.edgeBefore = '#' + cArgs[1].trim();
                    if (cArgs[2] && cArgs[2].trim()) targetColorObj.fillAfter = '#' + cArgs[2].trim();
                    if (cArgs[3] && cArgs[3].trim()) targetColorObj.edgeAfter = '#' + cArgs[3].trim();
                    if (cArgs[4] && cArgs[4].trim()) targetColorObj.rubyFillBefore = '#' + cArgs[4].trim();
                    if (cArgs[5] && cArgs[5].trim()) targetColorObj.rubyEdgeBefore = '#' + cArgs[5].trim();
                    if (cArgs[6] && cArgs[6].trim()) targetColorObj.rubyFillAfter = '#' + cArgs[6].trim();
                    if (cArgs[7] && cArgs[7].trim()) targetColorObj.rubyEdgeAfter = '#' + cArgs[7].trim();

                    wText = wText.replace(/<color>[^<\t\r\n]+/, '');
                }
            }

            let baseText = wText;
            let rubyText = null;
            if (baseText.includes('<ruby>')) {
                const rParts = baseText.split('<ruby>');
                baseText = rParts[0];
                rubyText = rParts[1];
            }

            wordList.push({
                word: baseText,
                ruby: rubyText,
                isEmpty: (baseText === ''),
                start: wStart,
                end: wEnd,
                color: isSub ? { ...subColors } : { ...mainColors }
            });
        }

        const isPureClearCmd = isClear && (cleanTextPart.replace(/[\s\u3000\t]/g, '') === '');

        phrases.push({
            isClearCmd: isPureClearCmd,
            isSub: isSub,
            linesCount: activeLinesCount,
            showTime: showTime,
            endTime: endTime,
            words: wordList
        });
    });

    phrases.sort((a, b) => a.showTime - b.showTime);

    // 核心重置：在遇到的每一个 <clear> 节点处彻底重置槽位与模式状态，阻断上段残存槽位污染
    let modeCounter = 0;
    let currentLinesMode = -1;

    phrases.forEach((p) => {
        if (p.isClearCmd) {
            modeCounter = 0;
            currentLinesMode = -1;
            return;
        }

        if (!p.isSub) {
            if (p.linesCount !== currentLinesMode) {
                currentLinesMode = p.linesCount;
                modeCounter = 0;
            }
            p.inModeIndex = modeCounter;
            modeCounter++;
        }
    });

    const pureMainPhrases = phrases.filter(p => !p.isSub && !p.isClearCmd);
    
    phrases.forEach(p => {
        if (p.isSub) {
            let hostIndex = pureMainPhrases.findIndex(m => p.showTime >= m.showTime && p.showTime <= m.endTime + 1.0);
            if (hostIndex === -1) {
                hostIndex = pureMainPhrases.findIndex(m => m.showTime >= p.showTime);
            }
            if (hostIndex === -1 && pureMainPhrases.length > 0) {
                hostIndex = pureMainPhrases.length - 1;
            }

            p.hostMain = hostIndex !== -1 ? pureMainPhrases[hostIndex] : null;
            p.prevMain = (hostIndex > 0) ? pureMainPhrases[hostIndex - 1] : null;
        }
    });

    return phrases;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseTag, timeCodeToSeconds, parseJoyHackLinearStream };
}
