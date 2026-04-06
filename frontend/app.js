const SETTINGS_KEY = 'parlor-settings-v1';
const FIRST_RUN_KEY = 'parlor-first-run-ack-v1';

const DEFAULT_SETTINGS = {
  theme: 'auto',
  primaryColor: '#4ade80',
  fontSize: '16px',
};

export function parlorApp() {
  return {
    threads: [],
    activeThreadId: null,
    messages: [],
    isEditingTitle: false,
    editingThreadId: null,
    editingTitle: '',
    isLoadingThreads: false,
    statusText: 'Disconnected',
    csrfToken: null,

    ws: null,
    mediaStream: null,
    myvad: null,
    cameraEnabled: true,
    audioCtx: null,
    currentSource: null,
    state: 'loading',
    ignoreIncomingAudio: false,
    speakingStartedAt: 0,

    streamSampleRate: 24000,
    streamNextTime: 0,
    streamSources: [],

    analyser: null,
    micSource: null,
    waveformCanvas: null,
    waveformCtx: null,
    BAR_COUNT: 40,
    BAR_GAP: 3,
    ambientPhase: 0,

    isSettingsOpen: false,
    settings: { ...DEFAULT_SETTINGS },
    resolvedTheme: 'dark',
    toasts: [],
    browserWarnings: [],
    isFirstRunModalOpen: false,
    isBackendCrashModalOpen: false,
    backendCrashReason: '',
    isRestartingBackend: false,
    tauriUnsubscribers: [],

    get activeThreadTitle() {
      const t = this.threads.find(thread => thread.id === this.activeThreadId);
      return t ? (t.title || 'Untitled thread') : 'No thread selected';
    },

    formatTime(iso) {
      if (!iso) return '';
      return new Date(iso).toLocaleString();
    },

    notify(text, type = 'info', timeout = 3500) {
      const toast = { id: crypto.randomUUID(), text, type };
      this.toasts.push(toast);
      setTimeout(() => {
        this.toasts = this.toasts.filter(t => t.id !== toast.id);
      }, timeout);
    },

    loadSettings() {
      try {
        const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        this.settings = { ...DEFAULT_SETTINGS, ...parsed };
      } catch {
        this.settings = { ...DEFAULT_SETTINGS };
      }
      this.applySettings();
    },

    saveSettings() {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
      this.applySettings();
      this.notify('Settings updated.', 'success');
    },

    applySettings() {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      this.resolvedTheme = this.settings.theme === 'auto'
        ? (prefersDark ? 'dark' : 'light')
        : this.settings.theme;

      const root = document.documentElement;
      root.style.setProperty('--font-size-base', this.settings.fontSize);
      root.style.setProperty('--c-primary', this.settings.primaryColor);
      root.style.setProperty('--c-listen', this.settings.primaryColor);
      root.style.setProperty('--c-listen-dim', `${this.hexToRgba(this.settings.primaryColor, 0.14)}`);
    },

    hexToRgba(hex, alpha = 1) {
      const h = hex.replace('#', '');
      const bigint = Number.parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
      const r = (bigint >> 16) & 255;
      const g = (bigint >> 8) & 255;
      const b = bigint & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    },

    openSettings() {
      this.isSettingsOpen = true;
    },

    closeSettings() {
      this.isSettingsOpen = false;
    },

    checkBrowserSupport() {
      const checks = [
        ['MediaDevices.getUserMedia', !!navigator.mediaDevices?.getUserMedia],
        ['WebSocket', 'WebSocket' in window],
        ['AudioContext', 'AudioContext' in window || 'webkitAudioContext' in window],
        ['crypto.randomUUID', !!crypto?.randomUUID],
      ];
      this.browserWarnings = checks.filter(([, ok]) => !ok).map(([name]) => name);
      if (this.browserWarnings.length) {
        this.notify(`Some features may fail: ${this.browserWarnings.join(', ')}`, 'warning', 8000);
      }
    },

    async init() {
      this.csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || null;
      this.video = document.getElementById('video');
      this.stateDot = document.getElementById('stateDot');
      this.stateText = document.getElementById('stateText');
      this.viewportWrap = document.getElementById('viewportWrap');
      this.statusEl = document.getElementById('status');
      this.waveformCanvas = document.getElementById('waveform');
      this.waveformCtx = this.waveformCanvas.getContext('2d');

      this.loadSettings();
      this.checkBrowserSupport();
      this.isFirstRunModalOpen = !localStorage.getItem(FIRST_RUN_KEY);
      this.setupTauriListeners();

      this.initWaveformCanvas();
      window.addEventListener('resize', () => this.initWaveformCanvas());

      await this.startCamera();
      await this.loadThreads();
      this.connect();

      try {
        await window.ensureVendorScripts?.();
      } catch (err) {
        this.notify(`Failed to load speech dependencies: ${err.message}`, 'error', 7000);
      }

      await this.initVad();

      const initAudio = () => {
        this.ensureAudioCtx();
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        document.removeEventListener('click', initAudio);
        document.removeEventListener('keydown', initAudio);
      };
      document.addEventListener('click', initAudio);
      document.addEventListener('keydown', initAudio);
      this.ensureAudioCtx();

      this.setState('listening');
      this.drawWaveform();
    },

    async setupTauriListeners() {
      if (!window.__TAURI__?.event?.listen) return;
      const listen = window.__TAURI__.event.listen;

      const unsubCrash = await listen('backend-crashed', (event) => {
        this.backendCrashReason = event?.payload || 'The backend terminated unexpectedly.';
        this.isBackendCrashModalOpen = true;
        this.setStatus('disconnected', 'Backend crashed');
      });

      const unsubRestarted = await listen('backend-restarted', () => {
        this.isRestartingBackend = false;
        this.isBackendCrashModalOpen = false;
        this.backendCrashReason = '';
        this.notify('Backend restarted.', 'success');
        this.connect();
        this.loadThreads();
      });

      const unsubRestartFailed = await listen('backend-restart-failed', (event) => {
        this.isRestartingBackend = false;
        this.notify(`Backend restart failed: ${event?.payload || 'unknown error'}`, 'error', 7000);
      });

      const unsubDbReset = await listen('db-reset', async () => {
        this.notify('Local database reset.', 'success');
        this.threads = [];
        this.messages = [];
        this.activeThreadId = null;
        await this.loadThreads();
      });

      const unsubMenuError = await listen('menu-error', (event) => {
        this.notify(event?.payload || 'Menu action failed.', 'error', 7000);
      });

      this.tauriUnsubscribers = [unsubCrash, unsubRestarted, unsubRestartFailed, unsubDbReset, unsubMenuError];
    },

    acknowledgeFirstRun() {
      localStorage.setItem(FIRST_RUN_KEY, '1');
      this.isFirstRunModalOpen = false;
    },

    async restartBackend() {
      if (this.isRestartingBackend) return;
      if (!window.__TAURI__?.core?.invoke) {
        this.notify('Restart backend is only available in the desktop app.', 'warning');
        return;
      }
      this.isRestartingBackend = true;
      try {
        await window.__TAURI__.core.invoke('restart_backend_command');
      } catch (err) {
        this.isRestartingBackend = false;
        this.notify(`Backend restart failed: ${err}`, 'error', 7000);
      }
    },

    async openLogsFolder() {
      if (!window.__TAURI__?.core?.invoke) {
        this.notify('Open logs is only available in the desktop app.', 'warning');
        return;
      }
      try {
        await window.__TAURI__.core.invoke('open_logs_folder_command');
      } catch (err) {
        this.notify(`Could not open logs: ${err}`, 'error', 7000);
      }
    },

    async openDataFolder() {
      if (!window.__TAURI__?.core?.invoke) {
        this.notify('Open data folder is only available in the desktop app.', 'warning');
        return;
      }
      try {
        await window.__TAURI__.core.invoke('open_data_folder_command');
      } catch (err) {
        this.notify(`Could not open data folder: ${err}`, 'error', 7000);
      }
    },

    async resetLocalDb() {
      if (!window.confirm('Reset local DB? This permanently removes all local threads and messages.')) return;
      if (!window.__TAURI__?.core?.invoke) {
        this.notify('Reset local DB is only available in the desktop app.', 'warning');
        return;
      }
      try {
        await window.__TAURI__.core.invoke('reset_local_db_command');
      } catch (err) {
        this.notify(`DB reset failed: ${err}`, 'error', 7000);
      }
    },

    async initVad() {
      if (!window.vad?.MicVAD) {
        this.notify('Voice activity detection failed to load.', 'error', 7000);
        return;
      }
      try {
        this.myvad = await vad.MicVAD.new({
          getStream: async () => new MediaStream(this.mediaStream.getAudioTracks()),
          positiveSpeechThreshold: 0.5,
          negativeSpeechThreshold: 0.25,
          redemptionMs: 600,
          minSpeechMs: 300,
          preSpeechPadMs: 300,
          onSpeechStart: () => this.handleSpeechStart(),
          onSpeechEnd: (audio) => this.handleSpeechEnd(audio),
          onVADMisfire: () => console.log('VAD misfire (too short)'),
          onnxWASMBasePath: '/vendor/onnxruntime-web/',
          baseAssetPath: '/vendor/vad-web/',
        });
        this.myvad.start();
      } catch (err) {
        this.notify(`Failed to initialize VAD: ${err.message}`, 'error', 7000);
      }
    },

    async api(path, options = {}) {
      const res = await fetch(path, {
        headers: {
          ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
          ...(this.csrfToken ? { 'X-CSRF-Token': this.csrfToken } : {}),
          ...(options.headers || {}),
        },
        ...options,
      });
      if (!res.ok) throw new Error(await res.text());
      if (res.status === 204) return null;
      return res.json();
    },

    async exportSqlite() {
      try {
        const res = await fetch('/api/db/export');
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replaceAll(':', '-').replace('T', '_').slice(0, 19);
        a.href = url;
        a.download = `parlor-export-${stamp}.sqlite`;
        a.click();
        URL.revokeObjectURL(url);
        this.notify('SQLite exported successfully.', 'success');
      } catch (err) {
        this.notify(`Export failed: ${err.message}`, 'error');
      }
    },

    async importSqlite(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const formData = new FormData();
        formData.append('db_file', file);
        await this.api('/api/db/import', { method: 'POST', body: formData });
        await this.loadThreads();
        if (this.activeThreadId) await this.loadMessages(this.activeThreadId);
        this.notify('SQLite import complete.', 'success');
      } catch (err) {
        this.notify(`Import failed: ${err.message}`, 'error');
      } finally {
        event.target.value = '';
      }
    },

    async loadThreads() {
      this.isLoadingThreads = true;
      try {
        const data = await this.api('/api/threads');
        this.threads = data.threads || [];
        if (!this.activeThreadId && this.threads.length) {
          await this.selectThread(this.threads[0].id);
        }
      } catch (err) {
        this.notify(`Failed to load threads: ${err.message}`, 'error');
      } finally {
        this.isLoadingThreads = false;
      }
    },

    async selectThread(threadId) {
      if (!threadId || this.activeThreadId === threadId) return;
      this.activeThreadId = threadId;
      await this.loadMessages(threadId);
    },

    async loadMessages(threadId) {
      try {
        const data = await this.api(`/api/threads/${threadId}/messages`);
        this.messages = (data.messages || []).map(m => this.mapMessage(m));
        this.$nextTick(() => {
          const el = document.getElementById('messages');
          if (el) el.scrollTop = el.scrollHeight;
        });
      } catch (err) {
        this.notify(`Failed to load messages: ${err.message}`, 'error');
      }
    },

    mapMessage(msg) {
      let meta = '';
      if (msg.llm_time != null) meta = `LLM ${msg.llm_time}s`;
      if (msg.tts_time != null) meta = meta ? `${meta} · TTS ${msg.tts_time}s` : `TTS ${msg.tts_time}s`;
      return {
        id: msg.id,
        role: msg.role,
        content: msg.role === 'user' ? (msg.transcription || msg.content) : msg.content,
        meta,
        loading: false,
      };
    },

    async createThread() {
      try {
        const data = await this.api('/api/threads', { method: 'POST', body: JSON.stringify({}) });
        const thread = data.thread;
        this.threads.unshift(thread);
        await this.selectThread(thread.id);
      } catch (err) {
        this.notify(`Create thread failed: ${err.message}`, 'error');
      }
    },

    startEditTitle(thread) {
      this.isEditingTitle = true;
      this.editingThreadId = thread.id;
      this.editingTitle = thread.title || '';
    },

    cancelEditTitle() {
      this.isEditingTitle = false;
      this.editingThreadId = null;
      this.editingTitle = '';
    },

    async saveEditTitle(threadId) {
      const title = this.editingTitle.trim();
      if (!title) return this.cancelEditTitle();
      try {
        const data = await this.api(`/api/threads/${threadId}`, {
          method: 'PATCH',
          body: JSON.stringify({ title }),
        });
        this.threads = this.threads.map(t => t.id === threadId ? data.thread : t);
        this.cancelEditTitle();
      } catch (err) {
        this.notify(`Update title failed: ${err.message}`, 'error');
      }
    },

    async deleteThread(threadId) {
      const idx = this.threads.findIndex(t => t.id === threadId);
      if (idx === -1) return;
      const previousThreads = [...this.threads];
      const previousActiveThreadId = this.activeThreadId;
      const previousMessages = [...this.messages];
      const fallback = this.threads[idx + 1]?.id || this.threads[idx - 1]?.id || null;
      this.threads = this.threads.filter(t => t.id !== threadId);
      if (this.activeThreadId === threadId) {
        this.activeThreadId = null;
        this.messages = [];
      }
      try {
        await this.api(`/api/threads/${threadId}`, { method: 'DELETE' });
        if (fallback) {
          await this.selectThread(fallback);
        }
      } catch (err) {
        this.threads = previousThreads;
        this.activeThreadId = previousActiveThreadId;
        this.messages = previousMessages;
        this.notify(`Delete failed: ${err.message}`, 'error');
      }
    },

    connect() {
      const wsUrl = this.resolveWebSocketUrl();
      if (!wsUrl) {
        this.setStatus('disconnected', 'Unsupported page protocol');
        this.notify(
          `Unsupported page protocol "${window.location.protocol}". ` +
          'Set window.PARLOR_WS_URL to a ws:// or wss:// endpoint.',
          'error',
          9000,
        );
        return;
      }

      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => {
        this.setStatus('connected', 'Connected');
        if (this.state !== 'loading') this.setState('listening');
      };
      this.ws.onclose = () => {
        this.setStatus('disconnected', 'Disconnected');
        setTimeout(() => this.connect(), 2000);
      };
      this.ws.onmessage = ({ data }) => {
        const msg = JSON.parse(data);
        if (msg.thread_id) {
          this.activeThreadId = msg.thread_id;
          const hasThread = this.threads.some(t => t.id === msg.thread_id);
          if (!hasThread) this.loadThreads();
        }
        if (msg.type === 'text') {
          if (msg.transcription) {
            for (let i = this.messages.length - 1; i >= 0; i--) {
              const m = this.messages[i];
              if (m.role === 'user' && m.loading) {
                m.loading = false;
                m.content = msg.transcription;
                break;
              }
            }
          }
          this.addMessage('assistant', msg.text, `LLM ${msg.llm_time}s`);
        } else if (msg.type === 'audio_start') {
          if (this.ignoreIncomingAudio) return;
          this.streamSampleRate = msg.sample_rate || 24000;
          this.startStreamPlayback();
        } else if (msg.type === 'audio_chunk') {
          if (this.ignoreIncomingAudio) return;
          this.queueAudioChunk(msg.audio);
        } else if (msg.type === 'audio_end') {
          if (this.ignoreIncomingAudio) {
            this.ignoreIncomingAudio = false;
            this.stopPlayback();
            this.setState('listening');
            return;
          }
          const lastAssistant = [...this.messages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant) lastAssistant.meta = `${lastAssistant.meta} · TTS ${msg.tts_time}s`;
        } else if (msg.type === 'error') {
          this.notify(msg.detail || 'Thread error', 'error');
          this.addMessage('assistant', msg.detail || 'Thread error', '');
        }
      };
    },

    resolveWebSocketUrl() {
      const manualUrl = (window.PARLOR_WS_URL || '').trim();
      if (manualUrl) return manualUrl;

      if (window.location.protocol !== 'https:' && window.location.protocol !== 'http:') {
        return null;
      }

      return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
    },

    setStatus(cls, text) {
      this.statusText = text;
      this.statusEl.className = `status-pill ${cls}`;
      this.statusEl.textContent = text;
    },

    async startCamera() {
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.video.srcObject = this.mediaStream;
        return;
      } catch (e) { console.warn('Video+audio failed:', e.message); }

      const streams = await Promise.allSettled([
        navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } }),
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
      ]);
      this.mediaStream = new MediaStream();
      streams.forEach(r => { if (r.status === 'fulfilled') r.value.getTracks().forEach(t => this.mediaStream.addTrack(t)); });
      if (this.mediaStream.getVideoTracks().length) this.video.srcObject = this.mediaStream;
      if (!this.mediaStream.getAudioTracks().length) {
        this.cameraEnabled = false;
        this.notify('No microphone track found.', 'warning');
      }
    },

    toggleCamera() {
      this.cameraEnabled = !this.cameraEnabled;
      this.video.style.opacity = this.cameraEnabled ? 1 : 0.3;
    },

    captureFrame() {
      if (!this.cameraEnabled || !this.video.videoWidth) return null;
      const canvas = document.createElement('canvas');
      const scale = 320 / this.video.videoWidth;
      canvas.width = 320;
      canvas.height = this.video.videoHeight * scale;
      canvas.getContext('2d').drawImage(this.video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
    },

    handleSpeechStart() {
      const BARGE_IN_GRACE_MS = 800;
      if (this.state === 'speaking') {
        if (Date.now() - this.speakingStartedAt < BARGE_IN_GRACE_MS) return;
        this.stopPlayback();
        this.ignoreIncomingAudio = true;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          const interruptPayload = { type: 'interrupt' };
          if (this.activeThreadId) interruptPayload.thread_id = this.activeThreadId;
          this.ws.send(JSON.stringify(interruptPayload));
        }
        this.setState('listening');
      }
    },

    handleSpeechEnd(audio) {
      if (this.state !== 'listening') return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const wavBase64 = this.float32ToWavBase64(audio);
      const imageBase64 = this.captureFrame();

      this.setState('processing');
      this.setStatus('processing', 'Processing');
      this.addMessage('user', '', imageBase64 ? 'with camera' : '', true);

      const payload = { audio: wavBase64 };
      if (this.activeThreadId) payload.thread_id = this.activeThreadId;
      if (imageBase64) payload.image = imageBase64;
      this.ws.send(JSON.stringify(payload));
    },

    float32ToWavBase64(samples) {
      const buf = new ArrayBuffer(44 + samples.length * 2);
      const v = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true);
      v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      }
      const bytes = new Uint8Array(buf);
      let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    },

    stopPlayback() {
      for (const src of this.streamSources) {
        try { src.stop(); } catch {}
      }
      this.streamSources = [];
      this.currentSource = null;
      this.streamNextTime = 0;
    },

    ensureAudioCtx() {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.75;
      }
    },

    startStreamPlayback() {
      this.stopPlayback();
      this.ensureAudioCtx();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      this.streamNextTime = this.audioCtx.currentTime + 0.05;
      this.speakingStartedAt = Date.now();
      this.setState('speaking');
    },

    queueAudioChunk(base64Pcm) {
      this.ensureAudioCtx();
      const bin = atob(base64Pcm);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

      const audioBuffer = this.audioCtx.createBuffer(1, float32.length, this.streamSampleRate);
      audioBuffer.getChannelData(0).set(float32);

      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioCtx.destination);
      source.connect(this.analyser);

      const startAt = Math.max(this.streamNextTime, this.audioCtx.currentTime);
      source.start(startAt);
      this.streamNextTime = startAt + audioBuffer.duration;

      this.streamSources.push(source);
      this.currentSource = source;

      source.onended = () => {
        const idx = this.streamSources.indexOf(source);
        if (idx !== -1) this.streamSources.splice(idx, 1);
        if (this.streamSources.length === 0 && this.state === 'speaking') {
          this.currentSource = null;
          this.setState('listening');
          this.setStatus('connected', 'Connected');
        }
      };
    },

    addMessage(role, text, meta = '', loading = false) {
      this.messages.push({ id: crypto.randomUUID(), role, content: text, meta, loading });
      this.$nextTick(() => {
        const el = document.getElementById('messages');
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    initWaveformCanvas() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.waveformCanvas.getBoundingClientRect();
      this.waveformCanvas.width = rect.width * dpr;
      this.waveformCanvas.height = rect.height * dpr;
      this.waveformCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.waveformCtx.scale(dpr, dpr);
    },

    getStateColor() {
      const colors = { listening: this.settings.primaryColor, processing: '#f59e0b', speaking: '#818cf8', loading: '#3a3d46' };
      return colors[this.state] || colors.loading;
    },

    drawWaveform() {
      const w = this.waveformCanvas.getBoundingClientRect().width;
      const h = this.waveformCanvas.getBoundingClientRect().height;
      this.waveformCtx.clearRect(0, 0, w, h);

      const barWidth = (w - (this.BAR_COUNT - 1) * this.BAR_GAP) / this.BAR_COUNT;
      this.waveformCtx.fillStyle = this.getStateColor();

      let dataArray = null;
      if (this.analyser) {
        dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(dataArray);
      }

      for (let i = 0; i < this.BAR_COUNT; i++) {
        let amplitude;
        if (dataArray) {
          const binIndex = Math.floor((i / this.BAR_COUNT) * dataArray.length * 0.6);
          amplitude = dataArray[binIndex] / 255;
        }
        if (!dataArray || amplitude < 0.02) {
          this.ambientPhase += 0.0001;
          const drift = Math.sin(this.ambientPhase * 3 + i * 0.4) * 0.5 + 0.5;
          amplitude = 0.03 + drift * 0.04;
        }

        const barH = Math.max(2, amplitude * (h - 4));
        const x = i * (barWidth + this.BAR_GAP);
        const y = (h - barH) / 2;

        this.waveformCtx.globalAlpha = 0.3 + amplitude * 0.7;
        this.waveformCtx.beginPath();
        const r = Math.min(barWidth / 2, barH / 2, 3);
        this.waveformCtx.roundRect(x, y, barWidth, barH, r);
        this.waveformCtx.fill();
      }

      this.waveformCtx.globalAlpha = 1;
      requestAnimationFrame(() => this.drawWaveform());
    },

    updateSpeakingGlow() {
      if (this.state !== 'speaking' || !this.analyser) return;
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length / 255;
      const intensity = 0.3 + avg * 0.7;
      const spread = 20 + avg * 60;
      const inner = 15 + avg * 25;
      this.viewportWrap.querySelector('.viewport-glow').style.boxShadow = `0 0 ${spread}px ${spread * 0.4}px rgba(129,140,248,${intensity * 0.25})`;
      this.viewportWrap.style.boxShadow = `inset 0 0 ${inner}px rgba(129,140,248,${intensity * 0.15}), 0 0 ${inner}px rgba(129,140,248,${intensity * 0.2})`;
      requestAnimationFrame(() => this.updateSpeakingGlow());
    },

    setState(newState) {
      this.state = newState;
      this.stateDot.className = `dot ${newState}`;
      const labels = { loading: 'Loading...', listening: 'Listening', processing: 'Thinking...', speaking: 'Speaking' };
      this.stateText.textContent = labels[newState] || newState;
      this.viewportWrap.className = `viewport-wrap ${newState}`;

      if (newState !== 'speaking') {
        this.viewportWrap.style.boxShadow = '';
        this.viewportWrap.querySelector('.viewport-glow').style.boxShadow = '';
      }

      const stateVars = {
        listening: [this.settings.primaryColor, this.hexToRgba(this.settings.primaryColor, 0.12)],
        processing: ['#f59e0b', 'rgba(245,158,11,0.12)'],
        speaking: ['#818cf8', 'rgba(129,140,248,0.12)'],
        loading: ['#3a3d46', 'rgba(58,61,70,0.12)'],
      };
      const [glow, glowDim] = stateVars[newState] || stateVars.loading;
      document.documentElement.style.setProperty('--glow', glow);
      document.documentElement.style.setProperty('--glow-dim', glowDim);

      if (newState === 'speaking') requestAnimationFrame(() => this.updateSpeakingGlow());
      if (this.myvad) this.myvad.setOptions({ positiveSpeechThreshold: newState === 'speaking' ? 0.92 : 0.5 });

      if (newState === 'listening' && this.mediaStream && this.audioCtx && this.analyser) {
        if (!this.micSource) this.micSource = this.audioCtx.createMediaStreamSource(this.mediaStream);
        try { this.micSource.connect(this.analyser); } catch {}
      } else if (this.micSource && newState !== 'listening') {
        try { this.micSource.disconnect(this.analyser); } catch {}
      }
    },
  };
}
