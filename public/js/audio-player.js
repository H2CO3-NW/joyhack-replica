/**
 * 双轨音频与音视频高精度同步引擎 (JoyHack Audio Engine)
 * 集成 Tone.js 移调处理、平滑淡入淡出增益交叉混音、以及 PLL 微频调速时钟对齐
 */

class DualTrackAudioEngine {
    constructor(videoElem, vocalElem, options = {}) {
        this.video = videoElem;
        this.vocal = vocalElem;
        this.options = options;

        this.isInitialized = false;
        this.currentPitch = 0;
        this.isVocalEnabled = false;
        this.masterVolume = 1.0;

        // Tone.js 节点引用
        this.pitchShiftNode = null;
        this.videoSourceNode = null;
        this.vocalSourceNode = null;
        this.videoGainNode = null;
        this.vocalGainNode = null;
        this.masterGainNode = null;

        this.bindVideoSyncEvents();
    }

    /**
     * 惰性初始化 Tone.js 及 WebAudio 图谱
     */
    async init() {
        if (this.isInitialized) return;
        try {
            if (typeof Tone === 'undefined') {
                console.warn("[AudioEngine] Tone.js 未加载，回退至原生标签回放模式");
                return;
            }

            await Tone.start();

            // 1. 创建 Phase Vocoder 变调节点
            this.pitchShiftNode = new Tone.PitchShift({
                pitch: this.currentPitch,
                windowSize: 0.08,
                delayTime: 0,
                feedback: 0
            });

            // 2. 创建平滑增益控制节点（用于原唱/伴唱无杂音淡入淡出与主音量）
            this.videoGainNode = new Tone.Gain(1.0);
            this.vocalGainNode = new Tone.Gain(0.0);
            this.masterGainNode = new Tone.Gain(this.masterVolume).toDestination();

            // 3. 将 MediaElement 接入 WebAudio
            this.videoSourceNode = Tone.getContext().createMediaElementSource(this.video);
            this.vocalSourceNode = Tone.getContext().createMediaElementSource(this.vocal);

            // 4. 路由：MediaElement -> Gain -> PitchShift -> MasterGain -> Destination
            Tone.connect(this.videoSourceNode, this.videoGainNode);
            Tone.connect(this.vocalSourceNode, this.vocalGainNode);

            this.videoGainNode.connect(this.pitchShiftNode);
            this.vocalGainNode.connect(this.pitchShiftNode);

            this.pitchShiftNode.connect(this.masterGainNode);

            this.isInitialized = true;
            console.log("[AudioEngine] WebAudio 双轨混音与 Tone.js 变调图谱构建成功");
        } catch (e) {
            console.error("[AudioEngine] 初始化 WebAudio 失败:", e);
        }
    }

    /**
     * 绑定双轨播放状态与 A/V 时钟同步事件
     */
    bindVideoSyncEvents() {
        // 视频作为主时钟 (Master Clock)，原唱音频作为辅时钟 (Follower)
        this.video.addEventListener('seeking', () => {
            if (this.vocal.src) {
                this.vocal.currentTime = this.video.currentTime;
            }
        });

        this.video.addEventListener('seeked', () => {
            if (this.vocal.src) {
                this.vocal.currentTime = this.video.currentTime;
            }
        });

        this.video.addEventListener('pause', () => {
            if (this.vocal.src && !this.vocal.paused) {
                this.vocal.pause();
            }
        });

        this.video.addEventListener('waiting', () => {
            // 视频缓冲等待时，辅轨音频暂停以防超前跑偏
            if (this.vocal.src && !this.vocal.paused) {
                this.vocal.pause();
            }
        });

        this.video.addEventListener('playing', () => {
            if (this.vocal.src && this.vocal.paused && !this.video.paused) {
                this.vocal.play().catch(e => console.warn("[AudioEngine] 辅轨对齐播放捕获:", e));
            }
        });

        // 统一时钟监控：利用每帧动画循环或 timeupdate 执行精准 PLL 纠偏
        this.video.addEventListener('timeupdate', () => {
            this.syncTracks(this.video.currentTime);
        });
    }

    /**
     * 双阶段时钟锁相对齐算法 (Phase-Locked Loop Alignment)
     * - 偏差 > 0.25s: 执行硬对齐 (Coarse Seek)
     * - 0.025s < 偏差 <= 0.25s: 动态微调 playbackRate (Fine Drift Correction)，彻底避免爆音和顿挫
     * - 偏差 <= 0.025s: 保持 1.0x 正常同步回放
     */
    syncTracks(masterTime) {
        if (!this.vocal.src || this.vocal.paused || this.video.paused) return;

        const delta = this.vocal.currentTime - masterTime;
        const absDelta = Math.abs(delta);

        if (absDelta > 0.25) {
            // 偏差过大时，执行无感跳帧硬同步
            this.vocal.currentTime = masterTime;
            this.vocal.playbackRate = 1.0;
        } else if (absDelta > 0.025) {
            // 原唱落后时稍微加速 (1.04x)，原唱超前时稍微减速 (0.96x)
            if (delta < 0) {
                this.vocal.playbackRate = 1.04;
            } else {
                this.vocal.playbackRate = 0.96;
            }
        } else {
            // 在容差范围内，平稳恢复标准速率
            if (this.vocal.playbackRate !== 1.0) {
                this.vocal.playbackRate = 1.0;
            }
        }
    }

    /**
     * 变调调节（半音阶 Key）
     */
    setPitch(pitchVal) {
        this.currentPitch = pitchVal;
        this.video.playbackRate = 1.0;
        this.vocal.playbackRate = 1.0;

        if (this.isInitialized && this.pitchShiftNode) {
            this.pitchShiftNode.pitch = pitchVal;
        }
    }

    /**
     * 原唱/伴唱切换（平滑 Gain 渐变，消除爆音）
     */
    toggleVocal() {
        this.isVocalEnabled = !this.isVocalEnabled;
        this.applyAudioMix();
        return this.isVocalEnabled;
    }

    setVocalEnabled(enabled) {
        this.isVocalEnabled = !!enabled;
        this.applyAudioMix();
    }

    /**
     * 应用增益与混音
     */
    applyAudioMix(fadeTime = 0.05) {
        const masterVol = this.masterVolume;
        const now = Tone.now ? Tone.now() : 0;

        if (this.isInitialized && this.videoGainNode && this.vocalGainNode) {
            if (this.isVocalEnabled) {
                // 原唱模式：主伴奏轨淡出，原唱轨淡入
                this.videoGainNode.gain.rampTo(0, fadeTime, now);
                this.vocalGainNode.gain.rampTo(1.0, fadeTime, now);
            } else {
                // 伴唱模式：主伴奏轨淡入，原唱轨淡出
                this.videoGainNode.gain.rampTo(1.0, fadeTime, now);
                this.vocalGainNode.gain.rampTo(0, fadeTime, now);
            }
        } else {
            // 回退兼容方案
            if (this.isVocalEnabled) {
                this.video.volume = 0;
                this.vocal.volume = masterVol;
            } else {
                this.video.volume = masterVol;
                this.vocal.volume = 0;
            }
        }
    }

    /**
     * 设置全局主音量
     */
    setVolume(vol) {
        this.masterVolume = parseFloat(vol);
        if (this.isInitialized && this.masterGainNode) {
            this.masterGainNode.gain.rampTo(this.masterVolume, 0.02);
        } else {
            this.applyAudioMix(0);
        }
    }

    /**
     * 加载媒体文件并重置初始状态
     */
    loadMedia(mediaPath, vocalPath) {
        this.video.style.display = 'block';
        this.video.src = `file://${mediaPath.replace(/\\/g, '/')}`;

        if (vocalPath) {
            this.vocal.src = `file://${vocalPath.replace(/\\/g, '/')}`;
        } else {
            this.vocal.src = "";
        }

        this.isVocalEnabled = false;
        this.applyAudioMix(0);
        this.setPitch(this.currentPitch);

        this.video.currentTime = 0;
        if (vocalPath) this.vocal.currentTime = 0;

        this.video.pause();
        if (vocalPath) this.vocal.pause();
    }

    play() {
        const p1 = this.video.play();
        let p2 = Promise.resolve();
        if (this.vocal.src) {
            p2 = this.vocal.play();
        }
        return Promise.all([p1, p2]);
    }

    pause() {
        this.video.pause();
        if (this.vocal.src) {
            this.vocal.pause();
        }
    }

    seek(seconds) {
        this.video.currentTime = seconds;
        if (this.vocal.src) {
            this.vocal.currentTime = seconds;
        }
    }

    stop() {
        this.pause();
        this.video.style.display = 'none';
        this.video.src = "";
        this.vocal.src = "";
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DualTrackAudioEngine };
}
