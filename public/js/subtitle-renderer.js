/**
 * JoyHack 高保真卡拉OK逐字擦色字幕渲染引擎
 * 支持 1-4 行交替对齐槽位、次级和声槽位 (<sub>)、振假名 (Ruby) 及 CSS clip-path 平滑擦色
 */

class KaraokeSubtitleRenderer {
    constructor(containerElement) {
        this.container = containerElement;
        this.activeMainRowsCount = -1;
        this.activeHasSubSlot = false;
        this.currentActiveLineHtml = {};
    }

    /**
     * 清空字幕显示区
     */
    clear() {
        if (this.container) {
            this.container.innerHTML = "";
        }
        this.activeMainRowsCount = -1;
        this.activeHasSubSlot = false;
        this.currentActiveLineHtml = {};
    }

    /**
     * 生成平滑字体描边阴影
     */
    getSmoothShadow(color) {
        return `-1.5px -1.5px 0 ${color}, 1.5px -1.5px 0 ${color}, -1.5px 1.5px 0 ${color}, 1.5px 1.5px 0 ${color}, -2px 0 0 ${color}, 2px 0 0 ${color}, 0 -2px 0 ${color}, 0 2px 0 ${color}, -1px -2px 0 ${color}, 1px -2px 0 ${color}, -1px 2px 0 ${color}, 1px 2px 0 ${color}`;
    }

    /**
     * 构建单行歌词 HTML，包含底色字与染色覆盖层（含注音 <ruby>）
     */
    buildLineHtml(lineData) {
        return lineData.words.map((w, idx) => {
            if (w.isEmpty) {
                return '';
            }

            let displayText = w.word;
            let rubyText = w.ruby;

            const c = w.color || {
                fillBefore: '#FFFFFF', edgeBefore: '#000000',
                fillAfter: '#FF0033', edgeAfter: '#FFFFFF',
                rubyFillBefore: '#FFFFFF', rubyEdgeBefore: '#000000',
                rubyFillAfter: '#FF0033', rubyEdgeAfter: '#FFFFFF'
            };

            const baseShadow = this.getSmoothShadow(c.edgeBefore) + ', 0 4px 12px rgba(0,0,0,0.85)';
            const activeShadow = this.getSmoothShadow(c.edgeAfter) + ', 0 0 16px ' + c.fillAfter + ', 0 4px 8px rgba(0,0,0,0.9)';
            
            const rubyBaseShadow = this.getSmoothShadow(c.rubyEdgeBefore) + ', 0 0 6px #000';
            const rubyActiveShadow = this.getSmoothShadow(c.rubyEdgeAfter) + ', 0 0 8px ' + c.rubyFillAfter;

            let baseInner = displayText;
            let activeInner = displayText;

            if (rubyText) {
                baseInner = `<ruby>${displayText}<rt style="color:${c.rubyFillBefore}; text-shadow:${rubyBaseShadow};">${rubyText}</rt></ruby>`;
                activeInner = `<ruby>${displayText}<rt style="color:${c.rubyFillAfter}; text-shadow:${rubyActiveShadow};">${rubyText}</rt></ruby>`;
            }

            return `<div class="karaoke-word-wrapper" data-widx="${idx}"><div class="karaoke-word-base" style="color:${c.fillBefore}; text-shadow:${baseShadow};">${baseInner}</div><div class="karaoke-word-active" style="color:${c.fillAfter}; text-shadow:${activeShadow};">${activeInner}</div></div>`;
        }).join("");
    }

    /**
     * 根据行模式（1-4行）与是否存在副槽位动态调整 DOM 排版结构
     */
    updateLayoutIfNeeded(mainRowsCount, hasSub) {
        if (this.activeMainRowsCount === mainRowsCount && this.activeHasSubSlot === hasSub) {
            return;
        }

        this.activeMainRowsCount = mainRowsCount;
        this.activeHasSubSlot = hasSub;
        this.currentActiveLineHtml = {};

        this.container.innerHTML = "";

        for (let i = 0; i < mainRowsCount; i++) {
            const row = document.createElement('div');
            let alignClass = 'row-align-left';
            
            if (mainRowsCount === 1) {
                alignClass = 'row-align-center';
            } else if (mainRowsCount === 2) {
                alignClass = i % 2 === 0 ? 'row-align-left' : 'row-align-right';
            } else if (mainRowsCount === 3) {
                if (i === 0) alignClass = 'row-align-left';
                else if (i === 1) alignClass = 'row-align-center';
                else alignClass = 'row-align-right';
            } else if (mainRowsCount === 4) {
                alignClass = i % 2 === 0 ? 'row-align-left' : 'row-align-right';
            }

            row.className = `lyric-row ${alignClass}`;
            row.id = `lyricRow_${i}`;
            this.container.appendChild(row);
        }

        if (hasSub) {
            const subRow = document.createElement('div');
            subRow.className = `lyric-row row-sub`;
            subRow.id = `lyricRow_sub`;
            this.container.appendChild(subRow);
        }
    }

    /**
     * 核心渲染帧驱动：在指定播放时间戳下计算并绘制当前所有行的擦除进度与预加载显示
     */
    renderFrameAtTime(parsedPhrases, curTime) {
        if (!parsedPhrases || parsedPhrases.length === 0) return;

        // 1. 检查当前时刻是否处于某个 <clear> 执行区
        const activeClearCmd = parsedPhrases.find(p => p.isClearCmd && curTime >= p.showTime && curTime <= p.endTime);
        if (activeClearCmd) {
            this.container.innerHTML = "";
            this.activeMainRowsCount = -1;
            this.activeHasSubSlot = false;
            this.currentActiveLineHtml = {};
            return;
        }

        const pureMains = parsedPhrases.filter(p => !p.isSub && !p.isClearCmd);
        if (pureMains.length === 0) return;

        // 2. 查找当前时间之前触发的最后一个 <clear> 节点
        const clearCmdsBeforeCur = parsedPhrases.filter(p => p.isClearCmd && curTime >= p.endTime);
        let lastClearTime = -1;
        if (clearCmdsBeforeCur.length > 0) {
            lastClearTime = clearCmdsBeforeCur[clearCmdsBeforeCur.length - 1].endTime;
        }

        // 3. 根据最近一次 <clear> 分隔离出的块过滤有效歌词
        let currentBlockMains = [];
        if (lastClearTime !== -1) {
            currentBlockMains = pureMains.filter(m => m.showTime >= lastClearTime);
        } else {
            currentBlockMains = pureMains;
        }

        if (currentBlockMains.length === 0) {
            this.container.innerHTML = "";
            return;
        }

        // 4. 定位焦点歌词与预渲染歌词
        let localIdx = -1;
        let isOpeningPreload = false;

        if (curTime < currentBlockMains[0].showTime) {
            localIdx = 0;
            isOpeningPreload = true;
        } else {
            for (let i = 0; i < currentBlockMains.length; i++) {
                if (curTime >= currentBlockMains[i].showTime) {
                    localIdx = i;
                } else {
                    break;
                }
            }
        }

        if (localIdx === -1) return;

        const currentMain = currentBlockMains[localIdx];
        const nextMain = currentBlockMains[localIdx + 1];

        const maxMainRows = currentMain.linesCount || 2;

        const activeSub = parsedPhrases.find(p => {
            if (!p.isSub) return false;

            let isTriggered = false;
            if (p.hostMain) {
                const delta = p.showTime - p.hostMain.showTime;
                if (delta <= 1.5) {
                    if (p.prevMain) {
                        isTriggered = curTime >= p.prevMain.showTime;
                    } else {
                        isTriggered = curTime >= (p.hostMain.showTime - 2.0);
                    }
                } else {
                    isTriggered = curTime >= (p.showTime - 1.5);
                }
            } else {
                isTriggered = curTime >= (p.showTime - 1.5);
            }

            if (!isTriggered) return false;

            let extendedEndTime = p.endTime;
            const overlappingMains = pureMains.filter(m => m.showTime <= p.endTime + 2.0 && m.endTime >= p.showTime);
            if (overlappingMains.length > 0) {
                const maxMainEndTime = Math.max(...overlappingMains.map(m => m.endTime));
                extendedEndTime = Math.max(p.endTime, maxMainEndTime);
            }

            return curTime <= extendedEndTime;
        });

        this.updateLayoutIfNeeded(maxMainRows, !!activeSub);

        // 5. 精准槽位映射逻辑（防止预加载与当期槽位互相挤占）
        const activeRowIdx = maxMainRows > 1 ? (currentMain.inModeIndex % maxMainRows) : 0;
        
        let previewRowIdx = -1;
        if (nextMain && nextMain.linesCount === maxMainRows && !nextMain.isClearCmd) {
            const targetPreviewRow = nextMain.inModeIndex % maxMainRows;
            if (targetPreviewRow !== activeRowIdx) {
                previewRowIdx = targetPreviewRow;
            }
        }

        const activeRowElem = document.getElementById(`lyricRow_${activeRowIdx}`);
        const previewRowElem = previewRowIdx !== -1 ? document.getElementById(`lyricRow_${previewRowIdx}`) : null;

        if (activeRowElem) {
            // 只有换句时才重新序列化 HTML，大幅降低 DOM 重绘开销
            if (this.currentActiveLineHtml[activeRowIdx] !== currentMain) {
                activeRowElem.innerHTML = this.buildLineHtml(currentMain);
                this.currentActiveLineHtml[activeRowIdx] = currentMain;
            }
            activeRowElem.style.opacity = isOpeningPreload ? "0.5" : "1";

            // 逐字 CSS 染色进度更新
            currentMain.words.forEach((w, wIdx) => {
                const wordElem = activeRowElem.querySelector(`[data-widx="${wIdx}"] .karaoke-word-active`);
                if (wordElem) {
                    let progress = 0;
                    if (!isOpeningPreload) {
                        if (curTime >= w.end) {
                            progress = 100;
                        } else if (curTime > w.start) {
                            progress = ((curTime - w.start) / (w.end - w.start)) * 100;
                        }
                    }
                    wordElem.style.setProperty('--clip', `${progress}%`);
                }
            });
        }

        if (previewRowElem) {
            if (nextMain && !nextMain.isClearCmd) {
                if (this.currentActiveLineHtml[previewRowIdx] !== nextMain) {
                    previewRowElem.innerHTML = this.buildLineHtml(nextMain);
                    this.currentActiveLineHtml[previewRowIdx] = nextMain;
                }
                previewRowElem.style.opacity = "0.5";

                nextMain.words.forEach((w, wIdx) => {
                    const wordElem = previewRowElem.querySelector(`[data-widx="${wIdx}"] .karaoke-word-active`);
                    if (wordElem) {
                        wordElem.style.setProperty('--clip', `0%`);
                    }
                });
            } else {
                previewRowElem.innerHTML = "";
                delete this.currentActiveLineHtml[previewRowIdx];
            }
        }

        if (activeSub) {
            const subElem = document.getElementById(`lyricRow_sub`);
            if (subElem) {
                if (this.currentActiveLineHtml['sub'] !== activeSub) {
                    subElem.innerHTML = this.buildLineHtml(activeSub);
                    this.currentActiveLineHtml['sub'] = activeSub;
                }
                subElem.style.opacity = (curTime >= activeSub.showTime) ? "1" : "0.5";

                activeSub.words.forEach((w, wIdx) => {
                    const wordElem = subElem.querySelector(`[data-widx="${wIdx}"] .karaoke-word-active`);
                    if (wordElem) {
                        let progress = 0;
                        if (curTime >= w.end) {
                            progress = 100;
                        } else if (curTime > w.start) {
                            progress = ((curTime - w.start) / (w.end - w.start)) * 100;
                        }
                        wordElem.style.setProperty('--clip', `${progress}%`);
                    }
                });
            }
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { KaraokeSubtitleRenderer };
}
