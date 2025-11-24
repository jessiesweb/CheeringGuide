const STORAGE_KEYS = {
  RANKINGS: 'cheer-trainer-rankings',
  CHALLENGER: 'cheer-trainer-challenger'
};

const APP_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbxEMmhhyEJdhBK07iRMMvvc-Rw8jC3Pb0XJa_0Q0FEdpqP8euNSf2kh2JXuQOW0QU6nBA/exec';

const FIREBASE_DB_URL = 'https://cheer-9063f-default-rtdb.firebaseio.com';
const TIME_TOLERANCE = 0.4; // seconds tolerance when matching entries to segments

const FirebaseApi = {
  baseUrl: FIREBASE_DB_URL.replace(/\/$/, ''),
  buildUrl(path) {
    return `${this.baseUrl}${path}.json`;
  },
  async saveSong(song) {
    const url = this.buildUrl(`/songs/${song.id}`);
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(song)
    });
    return response.json().catch(() => ({}));
  },
  async deleteSong(songId) {
    const url = this.buildUrl(`/songs/${songId}`);
    const response = await fetch(url, { method: 'DELETE' });
    return response.json().catch(() => ({}));
  },
  async listSongs() {
    const url = this.buildUrl('/songs');
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));
    if (!data || typeof data !== 'object') return [];
    return Object.entries(data).map(([id, payload]) => ({
      id,
      ...(payload || {})
    }));
  }
};

const toast = (() => {
  return (message, type = 'info') => {
    // Toasts disabled per request; fallback to console logging.
    const logger = type === 'error' ? console.error : console.log;
    logger(`[toast:${type}] ${message}`);
  };
})();

const loadingOverlay = (() => {
  let overlay;
  let textEl;
  let counter = 0;

  function ensure() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'loading-overlay hidden';
    textEl = document.createElement('div');
    textEl.className = 'loading-box';
    overlay.appendChild(textEl);
    document.body.appendChild(overlay);
  }

  return {
    show(message = '資料載入中...') {
      ensure();
      counter += 1;
      textEl.textContent = message;
      overlay.classList.remove('hidden');
    },
    hide() {
      counter = Math.max(0, counter - 1);
      if (!counter && overlay) {
        overlay.classList.add('hidden');
      }
    }
  };
})();

function setLoading(show, message) {
  if (show) loadingOverlay.show(message);
  else loadingOverlay.hide();
}

const UserPrefs = {
  loadChallenger() {
    try {
      return localStorage.getItem(STORAGE_KEYS.CHALLENGER) || '';
    } catch {
      return '';
    }
  },
  saveChallenger(name) {
    try {
      localStorage.setItem(STORAGE_KEYS.CHALLENGER, name);
    } catch {
      /* ignore */
    }
  }
};

const SongStore = {
  songs: [],
  setSongs(list = []) {
    this.songs = Array.isArray(list) ? [...list] : [];
  },
  getSongs() {
    return this.songs;
  },
  findSong(songId) {
    return this.songs.find((song) => song.id === songId);
  }
};

class SettingsController {
  constructor(root, { onSongsChange }) {
    this.root = root;
    this.onSongsChange = onSongsChange;
    this.form = root.querySelector('#song-form');
    this.segmentsList = root.querySelector('#segments-list');
    this.hintsList = root.querySelector('#hints-list');
    this.segmentsRawInput = root.querySelector('#segments-raw');
    this.hintsRawInput = root.querySelector('#hints-raw');
    this.songList = root.querySelector('#song-list ul');
    this.deleteBtn = root.querySelector('#delete-song');
    this.refreshBtn = root.querySelector('#refresh-songs');
    this.submitBtn = this.form.querySelector('[type="submit"]');
    this.currentSongId = null;

    this.ensureDefaultRows();
    this.updateSubmitState(false);
    this.renderSongList();
    this.bindEvents();
  }

  ensureDefaultRows() {
    if (!this.segmentsList.children.length) this.addSegmentRow();
    if (!this.hintsList.children.length) this.addHintRow();
  }

  resetFormToNewSong() {
    this.currentSongId = null;
    this.form.reset();
    this.segmentsList.innerHTML = '';
    this.hintsList.innerHTML = '';
    this.ensureDefaultRows();
    this.updateSubmitState(false);
    if (this.segmentsRawInput) this.segmentsRawInput.value = '';
    if (this.hintsRawInput) this.hintsRawInput.value = '';
  }

  updateSubmitState(isEditing) {
    if (!this.submitBtn) return;
    this.submitBtn.textContent = isEditing ? '更新歌曲' : '新增歌曲';
  }

  addSegmentRow(data = { range: '', phrase: '' }) {
    const li = document.createElement('li');
    li.innerHTML = `
      <input data-field="range" placeholder="0:00-0:00" value="${data.range || ''}" />
      <input data-field="phrase" placeholder="應援句" value="${data.phrase || ''}" />
      <button type="button" class="ghost" data-action="remove-segment">刪除</button>
    `;
    this.segmentsList.appendChild(li);
  }

  addHintRow(value = '') {
    const li = document.createElement('li');
    li.innerHTML = `
      <input data-field="hint" placeholder="應援提示" value="${value}" />
      <button type="button" class="ghost" data-action="remove-hint">刪除</button>
    `;
    this.hintsList.appendChild(li);
  }

  bindEvents() {
    this.form.addEventListener('submit', (event) => this.handleSubmit(event));
    this.deleteBtn.addEventListener('click', () => this.handleDelete());
    this.refreshBtn.addEventListener('click', () => this.refreshFromServer());

    this.root.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches('[data-action="add-segment"]')) this.addSegmentRow();
      if (target.matches('[data-action="remove-segment"]')) target.closest('li')?.remove();
      if (target.matches('[data-action="add-hint"]')) this.addHintRow();
      if (target.matches('[data-action="remove-hint"]')) target.closest('li')?.remove();
      if (target.matches('[data-song-id]')) this.loadSong(target.dataset.songId);
    });
  }

  renderSongList() {
    const songs = SongStore.getSongs();
    this.songList.innerHTML = '';
    if (!songs.length) {
      const empty = document.createElement('li');
      empty.textContent = '尚未儲存歌曲';
      this.songList.appendChild(empty);
      return;
    }
    songs.forEach((song) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost';
      button.dataset.songId = song.id;
      button.textContent = `${song.artist} - ${song.title}`;
      li.appendChild(button);
      this.songList.appendChild(li);
    });
  }

  loadSong(songId) {
    const song = SongStore.findSong(songId);
    if (!song) return;
    this.currentSongId = songId;
    this.updateSubmitState(true);
    this.form.artist.value = song.artist;
    this.form.title.value = song.title;
    this.form.cheerVideo.value = song.cheerVideo || '';
    this.form.cheerStart.value = song.cheerStart || '0:00';
    this.form.plainVideo.value = song.plainVideo || '';
    this.form.plainStart.value = song.plainStart || '0:00';

    this.segmentsList.innerHTML = '';
    (song.segments || []).forEach((segment) => this.addSegmentRow(segment));
    if (!this.segmentsList.children.length) this.addSegmentRow();

    this.hintsList.innerHTML = '';
    (song.hints || []).forEach((hint) => this.addHintRow(hint));
    if (!this.hintsList.children.length) this.addHintRow();
    if (this.segmentsRawInput) {
      this.segmentsRawInput.value = (song.segments || [])
        .map((segment) => `${segment.range} ${segment.phrase}`)
        .join('\n');
    }
    if (this.hintsRawInput) {
      this.hintsRawInput.value = (song.hints || []).join('\n');
    }
  }

  parseSegmentsInput() {
    if (this.segmentsRawInput && this.segmentsRawInput.value.trim()) {
      return this.parseSegmentBulkText(this.segmentsRawInput.value);
    }
    if (!this.segmentsList) return [];
    return Array.from(this.segmentsList.querySelectorAll('li'))
      .map((li) => ({
        range: li.querySelector('[data-field="range"]').value.trim(),
        phrase: li.querySelector('[data-field="phrase"]').value.trim()
      }))
      .filter((segment) => segment.range && segment.phrase);
  }

  parseSegmentBulkText(text = '') {
    return text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\S+)\s+(.+)$/);
        if (!match) return null;
        return { range: match[1], phrase: match[2] };
      })
      .filter((segment) => segment && segment.range && segment.phrase);
  }

  parseHintsInput() {
    if (this.hintsRawInput && this.hintsRawInput.value.trim()) {
      return this.hintsRawInput.value
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => splitHints(line));
    }
    if (!this.hintsList) return [];
    return Array.from(this.hintsList.querySelectorAll('[data-field="hint"]'))
      .map((input) => input.value.trim())
      .filter(Boolean);
  }

  serializeForm() {
    const formData = new FormData(this.form);
    const plainStart = (formData.get('plainStart') || '0:00').trim() || '0:00';
    const cheerStartRaw = (formData.get('cheerStart') || '').trim();
    const cheerStart = cheerStartRaw || '0:00';
    const segments = this.parseSegmentsInput();
    const hints = this.parseHintsInput();

    return {
      id: this.currentSongId || crypto.randomUUID?.() || `song-${Date.now()}`,
      artist: formData.get('artist').trim(),
      title: formData.get('title').trim(),
      cheerVideo: formData.get('cheerVideo').trim(),
      cheerStart,
      plainVideo: formData.get('plainVideo').trim(),
      plainStart,
      segments,
      hints
    };
  }

  async handleSubmit(event) {
    event.preventDefault();
    const song = this.serializeForm();
    if (!song.segments.length) {
      toast('請至少填寫一個應援時間段', 'error');
      return;
    }
    const isEditing = Boolean(this.currentSongId);
    const action = isEditing ? 'update' : 'save';
    const message = isEditing ? '更新歌曲中...' : '新增歌曲中...';
    try {
      setLoading(true, message);
      // 原 App Script 寫法保留：
      // await fetch(APP_SCRIPT_URL, {
      //   method: 'POST',
      //   body: JSON.stringify({ action, song })
      // }).then((response) => response.json().catch(() => ({})));

      await FirebaseApi.saveSong(song);
      await fetchSongsFromServer({ silent: true });

      this.resetFormToNewSong();
      this.renderSongList();
      this.onSongsChange?.(song);
      toast(isEditing ? '歌曲已更新' : '歌曲已儲存', 'success');
    } catch (err) {
      console.error('儲存歌曲失敗', err);
      toast('儲存歌曲失敗', 'error');
    } finally {
      setLoading(false);
    }
  }

  async handleDelete() {
    if (!this.currentSongId) {
      toast('請先選擇歌曲', 'error');
      return;
    }
    if (!confirm('確定要刪除這首歌？')) return;
    const songId = this.currentSongId;
    const payload = { action: 'delete', songId };
    try {
      setLoading(true, '刪除歌曲中...');
      // 原 App Script 寫法保留：
      // const response = await fetch(APP_SCRIPT_URL, {
      //   method: 'POST',
      //   body: JSON.stringify(payload)
      // });
      // await response.json().catch(() => ({}));
      await FirebaseApi.deleteSong(songId);
      this.resetFormToNewSong();
      await fetchSongsFromServer({ silent: true });
      this.renderSongList();
      toast('歌曲已刪除', 'success');
      this.onSongsChange?.();
    } catch (err) {
      console.error('刪除歌曲失敗', err);
      toast('刪除歌曲失敗', 'error');
    } finally {
      setLoading(false);
    }
  }

  async refreshFromServer() {
    try {
      await fetchSongsFromServer();
      this.renderSongList();
      this.onSongsChange?.();
    } catch (err) {
      console.error(err);
    }
  }
}

class PracticeSession {
  constructor(song, challengerName) {
    this.song = song;
    this.challenger = challengerName || '匿名挑戰者';
    this.entries = [];
  }
  addEntry(entry) {
    this.entries.push(entry);
  }
}

class YouTubeDriver {
  constructor(container) {
    this.container = container;
    this.player = null;
    this.playerId = `yt-player-${Date.now()}`;
    this.stateChangeHandler = (event) => this.handlePlayerStateChange(event);
    this.lastStart = 0;
    this.stateListeners = new Set();
    this.pendingReadyVideoId = null;
    this.videoReady = true;
    this.videoReadyPromise = Promise.resolve();
    this.videoReadyResolver = null;
    this.videoReadyTimer = null;
    this.videoReadyGeneration = 0;
    this.currentReadyToken = 0;
    this.readyPromise = new Promise((resolve) => {
      if (window.YT && window.YT.Player) {
        resolve();
      } else {
        const previous = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          previous?.();
          resolve();
        };
      }
    });
  }

  isPlayerUsable() {
    if (!this.player) return false;
    const canLoad = typeof this.player.loadVideoById === 'function';
    const canCue = typeof this.player.cueVideoById === 'function';
    return canLoad || canCue;
  }

  destroyPlayer() {
    if (this.player && typeof this.player.destroy === 'function') {
      try {
        this.player.destroy();
      } catch (err) {
        console.warn('無法銷毀播放器', err);
      }
    }
    this.player = null;
    this.ensurePlayerNode();
  }

  ensurePlayerNode() {
    if (!this.container) return;
    this.container.innerHTML = `<div id="${this.playerId}"></div>`;
  }

  async load(url, startSeconds = 0, { autoplay = true } = {}) {
    const videoId = extractVideoId(url);
    const readyPromise = this.prepareVideoReady(videoId);
    if (!videoId) {
      this.container.innerHTML = '<p class="muted">無法解析影片連結</p>';
      this.player = null;
      this.markVideoReady(null, this.currentReadyToken);
      await readyPromise;
      return;
    }
    await this.readyPromise;
    const start = Math.max(0, Number.isFinite(startSeconds) ? startSeconds : parseFloat(startSeconds) || 0);
    this.lastStart = start;
    if (this.player && !this.isPlayerUsable()) {
      this.destroyPlayer();
    }
    if (this.isPlayerUsable()) {
      const payload = { videoId, startSeconds: start };
      if (!autoplay && typeof this.player.cueVideoById === 'function') {
        this.player.cueVideoById(payload);
      } else if (typeof this.player.loadVideoById === 'function') {
        this.player.loadVideoById(payload);
        if (!autoplay) this.player.pauseVideo?.();
      } else {
        this.destroyPlayer();
      }
      if (this.player) {
        await readyPromise;
        return;
      }
    }
    this.ensurePlayerNode();
    await new Promise((resolve) => {
      this.player = new YT.Player(this.playerId, {
        videoId,
        playerVars: {
          start,
          rel: 0,
          autoplay: autoplay ? 1 : 0,
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          playsinline: 1,
          iv_load_policy: 3,
          fs: 0,
          cc_load_policy: 0,
          showinfo: 0,
          autohide: 1
        },
        events: {
          onReady: (event) => {
            if (!autoplay) {
              event.target.pauseVideo();
              event.target.seekTo(start, true);
            }
            this.markVideoReady(videoId, this.currentReadyToken);
            resolve();
          },
          onStateChange: this.stateChangeHandler
        }
      });
    });
    await readyPromise;
  }

  getCurrentTime() {
    if (this.player && typeof this.player.getCurrentTime === 'function') {
      return this.player.getCurrentTime();
    }
    return 0;
  }

  pause() {
    if (this.player && typeof this.player.pauseVideo === 'function') {
      this.player.pauseVideo();
    }
  }

  play() {
    if (this.player && typeof this.player.playVideo === 'function') {
      this.player.playVideo();
    }
  }

  stop() {
    if (this.player && typeof this.player.stopVideo === 'function') {
      this.player.stopVideo();
    } else {
      this.pause();
    }
  }

  seekTo(seconds = 0) {
    if (this.player && typeof this.player.seekTo === 'function') {
      const value = Math.max(0, Number(seconds) || 0);
      this.player.seekTo(value, true);
    }
  }

  prepareVideoReady(videoId = null) {
    this.videoReadyGeneration += 1;
    const token = this.videoReadyGeneration;
    this.currentReadyToken = token;
    this.pendingReadyVideoId = videoId || null;
    this.videoReady = false;
    this.videoReadyPromise = new Promise((resolve) => {
      this.videoReadyResolver = resolve;
    });
    if (this.videoReadyTimer) {
      clearTimeout(this.videoReadyTimer);
    }
    this.videoReadyTimer = setTimeout(() => this.markVideoReady(null, token), 8000);
    return this.videoReadyPromise;
  }

  markVideoReady(videoId = null, token = null) {
    if (this.videoReady) return;
    if (token && token !== this.currentReadyToken) return;
    if (this.pendingReadyVideoId && videoId && videoId !== this.pendingReadyVideoId) {
      return;
    }
    this.videoReady = true;
    this.pendingReadyVideoId = null;
    if (this.videoReadyTimer) {
      clearTimeout(this.videoReadyTimer);
      this.videoReadyTimer = null;
    }
    if (this.videoReadyResolver) {
      this.videoReadyResolver();
      this.videoReadyResolver = null;
    }
  }

  handlePlayerStateChange(event) {
    const PlayerState = window.YT?.PlayerState;
    if (!PlayerState) return;
    const currentVideoId = event?.target?.getVideoData?.()?.video_id || null;
    if (event.data === PlayerState.ENDED) {
      const resetTime = Number.isFinite(this.lastStart) ? this.lastStart : 0;
      event.target.seekTo(resetTime, true);
      event.target.pauseVideo();
    }
    if (
      event.data === PlayerState.CUED ||
      event.data === PlayerState.PLAYING ||
      event.data === PlayerState.PAUSED
    ) {
      this.markVideoReady(currentVideoId, this.currentReadyToken);
    }
    this.stateListeners.forEach((listener) => {
      try {
        listener(event);
      } catch (err) {
        console.error(err);
      }
    });
  }

  onStateChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
}

class PracticeController {
  constructor(root) {
    this.root = root;
    this.practiceLayout = root.querySelector('.practice-layout');
    this.songSelect = root.querySelector('#practice-song');
    this.challengerInput = root.querySelector('#challenger-name');
    this.startButton = root.querySelector('#start-practice');
    this.titleEl = root.querySelector('#practice-title');
    this.cheerButton = root.querySelector('#cheer-button');
    this.cheerInput = root.querySelector('#cheer-input');
    this.commitButton = root.querySelector('#commit-cheer');
    this.cancelButton = root.querySelector('#cancel-cheer');
    this.cheerExtra = root.querySelector('#cheer-extra');
    this.cheerEntry = root.querySelector('#cheer-entry');
    this.cheerTimestamp = root.querySelector('#cheer-timestamp');
    this.cheerHistory = root.querySelector('#cheer-history');
    this.hintSuggestions = root.querySelector('#hint-suggestions');
    this.challengeForm = root.querySelector('#challenge-form');
    this.challengeSummary = root.querySelector('#challenge-summary');
    this.summaryNameEl = root.querySelector('#summary-name');
    this.summarySongEl = root.querySelector('#summary-song');
    this.guideModal = document.getElementById('guide-modal');
    this.guideConfirmBtn = document.getElementById('guide-confirm');
    this.guideInstructions = document.getElementById('guide-instructions');
    this.guideCountdown = document.getElementById('guide-countdown');
    this.countdownNumberEl = document.getElementById('countdown-number');
    this.mobileCountdownBtn = document.getElementById('mobile-countdown-btn');
    this.confirmModal = document.getElementById('confirm-modal');
    this.confirmMessageEl = document.getElementById('confirm-message');
    this.confirmOkBtn = document.getElementById('confirm-ok');
    this.confirmCancelBtn = document.getElementById('confirm-cancel');
    this.nameWarningModal = document.getElementById('name-warning-modal');
    this.nameWarningOkBtn = document.getElementById('name-warning-ok');
    this.submitBtn = root.querySelector('#submit-practice');
    this.resultEl = root.querySelector('#practice-result');
    this.resultDetails = root.querySelector('#result-details');
    this.rankingList = root.querySelector('#ranking-list');
    this.scoreboard = root.querySelector('#scoreboard');
    this.player = new YouTubeDriver(root.querySelector('#video-container'));

    this.session = null;
    this.pendingTime = null;
    this.currentHints = [];
    this.countdownTimer = null;
    this.activeHintIndex = -1;
    this.videoEnded = false;
    this.confirmResolver = null;
    this.rankings = [];
    this.sessionStartSeconds = 0;
    this.autoFinishing = false;
    this.sessionStartSeconds = 0;

    this.populateSongs();
    this.renderRanking();
    this.bindEvents();
    this.handleShortcut = (event) => this.handleGlobalShortcut(event);
    this.bindShortcuts();
    this.resetPracticeUi();
    const savedName = UserPrefs.loadChallenger();
    if (savedName) {
      this.challengerInput.value = savedName;
    }
    this.handleChallengerInput();
    this.setScoreboardVisible(false);
    setTimeout(() => this.challengerInput.focus(), 0);
    this.player.onStateChange((event) => {
      const PlayerState = window.YT?.PlayerState;
      if (!PlayerState) return;
      if (event.data === PlayerState.PLAYING) {
        this.videoEnded = false;
        this.autoFinishing = false;
      } else if (event.data === PlayerState.ENDED) {
        this.videoEnded = true;
        this.handleAutoFinish();
      }
    });
  }

  bindEvents() {
    this.startButton.addEventListener('click', () => this.startPractice());
    this.songSelect.addEventListener('change', () => this.handleSongSelectionChange());
    this.cheerButton.addEventListener('click', () => this.armCheerInput());
    this.submitBtn.addEventListener('click', () => this.finishPractice());
    this.cheerInput.addEventListener('keydown', (event) => this.handleCheerKeyDown(event));
    this.cheerInput.addEventListener('input', () => this.handleCheerInput());
    this.commitButton.addEventListener('click', () => {
      this.player.pause();
      this.commitEntry();
    });
    this.cancelButton?.addEventListener('click', () => this.cancelCheerEntry());
    this.hintSuggestions?.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      this.insertHint(target.dataset.hint || target.textContent || '');
    });
    this.guideConfirmBtn?.addEventListener('click', () => this.confirmGuide());
    this.challengerInput.addEventListener('input', () => this.handleChallengerInput());
    this.confirmOkBtn?.addEventListener('click', () => this.resolveConfirmDialog(true));
    this.confirmCancelBtn?.addEventListener('click', () => this.handleCancelResult());
    this.nameWarningOkBtn?.addEventListener('click', () => this.hideNameWarning());
    this.mobileCountdownBtn?.addEventListener('click', () => this.handleMobileCountdownStart());
  }

  bindShortcuts() {
    window.addEventListener('keydown', this.handleShortcut, true);
  }

  handleGlobalShortcut(event) {
    if (event.key !== ' ' || event.repeat) return;
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    event.preventDefault();
    event.stopPropagation();
    if (!this.cheerInput.disabled) {
      this.commitEntry();
    } else if (!this.cheerButton.disabled) {
      this.armCheerInput();
    }
  }

  handleChallengerInput() {
    const hasName = Boolean(this.challengerInput.value.trim());
    this.startButton.disabled = !hasName;
  }

  async cuePracticeVideo(song, { showLoading = false } = {}) {
    if (!song) return;
    const startSeconds = parseTime(song.plainStart);
    if (showLoading) setLoading(true, '影片準備中...');
    try {
      await this.player.load(song.plainVideo, startSeconds, { autoplay: false });
      this.player.pause();
      this.player.seekTo(startSeconds);
      this.sessionStartSeconds = startSeconds;
    } catch (err) {
      console.error('影片載入失敗', err);
      toast('影片載入失敗', 'error');
      throw err;
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  async handleSongSelectionChange() {
    if (!this.songSelect) return;
    const songId = this.songSelect.value;
    const song = SongStore.findSong(songId);
    if (!song) {
      this.titleEl.textContent = '尚未選擇歌曲';
      this.player.stop();
      return;
    }
    if (!this.practiceLayout?.classList.contains('active-phase')) {
      this.titleEl.textContent = `${song.artist} - ${song.title}`;
    }
    try {
      await this.cuePracticeVideo(song);
    } catch {
      /* already toasted */
    }
  }

  async handleAutoFinish() {
    if (this.autoFinishing) return;
    if (!this.session) return;
    if (!this.videoEnded) return;
    if (!this.session.entries.length) return;
    if (this.practiceLayout?.classList.contains('show-results')) return;
    this.autoFinishing = true;
    try {
      await this.finishPractice({ auto: true });
    } catch (err) {
      console.error('自動結算失敗', err);
    } finally {
      this.autoFinishing = false;
    }
  }

  handleCheerKeyDown(event) {
    if (this.cheerInput.disabled) return;
    if (event.key === 'ArrowDown') {
      if (this.moveHintSelection(1)) event.preventDefault();
      return;
    }
    if (event.key === 'ArrowUp') {
      if (this.moveHintSelection(-1)) event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      if (this.commitHintSelection()) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      this.commitEntry();
    }
  }

  handleCheerInput() {
    if (this.cheerInput.disabled) return;
    this.renderHintSuggestions(this.cheerInput.value.trim());
  }

  renderHintSuggestions(query = '') {
    if (!this.hintSuggestions) return;
    const normalized = query.trim().toLowerCase();
    this.hintSuggestions.innerHTML = '';
    if (!normalized) {
      this.hintSuggestions.classList.add('hidden');
      this.resetHintSelection();
      return;
    }
    const suggestions = (this.currentHints || [])
      .filter((hint) => hint && hint.toLowerCase().startsWith(normalized))
      .slice(0, 5);
    if (!suggestions.length) {
      this.hintSuggestions.classList.add('hidden');
      this.resetHintSelection();
      return;
    }
    suggestions.forEach((hint) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = hint;
      button.dataset.hint = hint;
      this.hintSuggestions.appendChild(button);
    });
    this.hintSuggestions.classList.remove('hidden');
    this.resetHintSelection();
  }

  insertHint(hint) {
    if (!hint || this.cheerInput.disabled) return;
    this.cheerInput.value = hint;
    this.cheerInput.focus();
    if (this.hintSuggestions) {
      this.hintSuggestions.classList.add('hidden');
      this.resetHintSelection();
    }
  }

  getHintButtons() {
    return this.hintSuggestions ? Array.from(this.hintSuggestions.querySelectorAll('button')) : [];
  }

  resetHintSelection() {
    this.activeHintIndex = -1;
    this.updateHintHighlight();
  }

  updateHintHighlight() {
    const buttons = this.getHintButtons();
    buttons.forEach((button, index) => {
      button.classList.toggle('active', index === this.activeHintIndex);
    });
  }

  moveHintSelection(step) {
    if (!this.hintSuggestions || this.hintSuggestions.classList.contains('hidden')) return false;
    const buttons = this.getHintButtons();
    if (!buttons.length) return false;
    if (this.activeHintIndex === -1) {
      this.activeHintIndex = step > 0 ? 0 : buttons.length - 1;
    } else {
      this.activeHintIndex += step;
      if (this.activeHintIndex < 0) this.activeHintIndex = buttons.length - 1;
      if (this.activeHintIndex >= buttons.length) this.activeHintIndex = 0;
    }
    this.updateHintHighlight();
    return true;
  }

  commitHintSelection() {
    const buttons = this.getHintButtons();
    if (this.activeHintIndex < 0 || this.activeHintIndex >= buttons.length) return false;
    const button = buttons[this.activeHintIndex];
    this.insertHint(button.dataset.hint || button.textContent || '');
    return true;
  }

  async beginVideoPlayback({ autoplay = false } = {}) {
    if (!this.session) return;
    const startSeconds = typeof this.sessionStartSeconds === 'number'
      ? this.sessionStartSeconds
      : parseTime(this.session.song?.plainStart || '0:00');
    this.player.seekTo(startSeconds);
    if (autoplay) {
      this.player.play();
    } else {
      this.player.pause();
    }
  }

  showChallengeSummary(name, song) {
    if (this.summaryNameEl) this.summaryNameEl.textContent = name;
    if (this.summarySongEl) this.summarySongEl.textContent = `${song.artist} - ${song.title}`;
    this.challengeForm?.classList.add('hidden');
    this.challengeSummary?.classList.remove('hidden');
    this.root.querySelector('.practice-layout')?.classList.add('active-phase');
  }

  async launchGuideSequence(guideSeen) {
    if (!this.guideModal) {
      try {
        await this.beginVideoPlayback({ autoplay: true });
      } catch (err) {
        console.error('載入影片失敗', err);
        toast('載入影片失敗', 'error');
      }
      this.enablePracticeControls();
      return;
    }
    if (!guideSeen) {
      this.openGuide();
    } else {
      this.startCountdown();
    }
  }

  openGuide() {
    if (!this.guideModal) return;
    this.player.pause();
    this.guideConfirmBtn?.classList.remove('hidden');
    if (this.guideInstructions) this.guideInstructions.classList.remove('hidden');
    if (this.guideCountdown) this.guideCountdown.classList.add('hidden');
    this.guideModal.classList.remove('hidden');
  }

  closeGuide() {
    if (!this.guideModal) return;
    this.guideModal.classList.add('hidden');
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  confirmGuide() {
    localStorage.setItem('cheer-trainer-guide', '1');
    this.startCountdown();
  }

  startCountdown() {
    if (!this.guideModal) return;
    this.player.pause();
    if (requiresManualPlayback()) {
      this.showMobileCountdown();
      return;
    }
    this.hideMobileCountdown();
    if (this.guideInstructions) this.guideInstructions.classList.add('hidden');
    if (this.guideCountdown) this.guideCountdown.classList.remove('hidden');
    this.guideModal.classList.remove('hidden');
    if (!this.countdownNumberEl) {
      setTimeout(async () => {
        this.closeGuide();
        try {
          await this.beginVideoPlayback({ autoplay: false });
        } catch (err) {
          console.error('載入影片失敗', err);
          toast('載入影片失敗', 'error');
        }
        this.enablePracticeControls();
        this.player.play();
      }, 500);
      return;
    }
    let count = 2;
    const update = () => {
      if (!this.countdownNumberEl) return;
      if (count === 0) {
        this.countdownNumberEl.textContent = 'GO!';
        this.countdownTimer = setTimeout(async () => {
          this.closeGuide();
          try {
            await this.beginVideoPlayback({ autoplay: false });
          } catch (err) {
            console.error('載入影片失敗', err);
            toast('載入影片失敗', 'error');
          }
          this.enablePracticeControls();
          this.player.play();
        }, 700);
        return;
      }
      this.countdownNumberEl.textContent = String(count);
      count -= 1;
      this.countdownTimer = setTimeout(update, 1000);
    };
    update();
  }

  enablePracticeControls() {
    this.cheerButton.disabled = false;
    this.submitBtn.disabled = false;
  }


  setScoreboardVisible(visible) {
    this.scoreboard.classList.toggle('hidden', !visible);
  }

  resetPracticeUi({ preserveResult = false } = {}) {
    this.cheerButton.disabled = true;
    this.cheerInput.value = '';
    this.cheerInput.disabled = true;
    if (this.cheerEntry) this.cheerEntry.classList.add('hidden');
    this.commitButton.disabled = true;
    if (this.cancelButton) this.cancelButton.disabled = true;
    if (this.hintSuggestions) {
      this.hintSuggestions.classList.add('hidden');
      this.hintSuggestions.innerHTML = '';
    }
    this.resetHintSelection();
    this.submitBtn.disabled = true;
    if (this.cheerHistory) this.cheerHistory.innerHTML = '';
    if (this.cheerTimestamp) this.cheerTimestamp.textContent = '0:00';
    this.pendingTime = null;
    if (!preserveResult) {
      this.resultEl.textContent = '請先選擇歌曲並開始練習';
      this.setScoreboardVisible(false);
    }
  }

  populateSongs() {
    const songs = SongStore.getSongs();
    this.songSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '選擇歌曲';
    this.songSelect.appendChild(placeholder);
    songs.forEach((song) => {
      const option = document.createElement('option');
      option.value = song.id;
      option.textContent = `${song.artist} - ${song.title}`;
      this.songSelect.appendChild(option);
    });
  }

  async startPractice() {
    const challengerName = this.challengerInput.value.trim();
    if (!challengerName) {
      toast('請輸入挑戰者名稱', 'error');
      return;
    }
    if (!isChallengerNameAllowed(challengerName)) {
      this.showNameWarning();
      return;
    }
    const songId = this.songSelect.value;
    const song = SongStore.findSong(songId);
    if (!song) {
      toast('請選擇歌曲', 'error');
      return;
    }
    this.practiceLayout?.classList.add('active-phase');
    this.practiceLayout?.classList.remove('show-results');
    if (this.resultDetails) {
      this.resultDetails.innerHTML = '';
      this.resultDetails.classList.add('hidden');
    }
    UserPrefs.saveChallenger(challengerName);
    const practiceSong = { ...song, segments: alignSongSegments(song) };
    this.session = new PracticeSession(practiceSong, challengerName);
    this.titleEl.textContent = `${practiceSong.artist} - ${practiceSong.title}`;
    try {
      await this.cuePracticeVideo(practiceSong, { showLoading: true });
    } catch (err) {
      this.session = null;
      this.practiceLayout?.classList.remove('active-phase');
      this.challengeForm?.classList.remove('hidden');
      this.challengeSummary?.classList.add('hidden');
      return;
    }
    this.videoEnded = false;
    this.pendingTime = null;
    this.cheerButton.disabled = true;
    this.submitBtn.disabled = true;
    this.cheerInput.disabled = true;
    this.cheerInput.value = '';
    this.cheerExtra.classList.add('hidden');
    this.currentHints = Array.isArray(practiceSong.hints) ? practiceSong.hints : [];
    this.renderHintSuggestions('');
    this.showChallengeSummary(challengerName, practiceSong);
    this.setScoreboardVisible(false);
    const guideSeen = localStorage.getItem('cheer-trainer-guide') === '1';
    await this.launchGuideSequence(guideSeen);
  }

  armCheerInput() {
    if (!this.session) {
      toast('請先開始練習', 'error');
      return;
    }
    if (!this.cheerInput.disabled) {
      toast('請先送出目前的應援句', 'error');
      return;
    }
    this.triggerCheerAnimation();
    this.player.pause();
    this.pendingTime = this.player.getCurrentTime();
    this.cheerInput.disabled = false;
    this.cheerExtra.classList.remove('hidden');
    if (this.cheerEntry) this.cheerEntry.classList.remove('hidden');
    this.commitButton.disabled = false;
    if (this.cancelButton) this.cancelButton.disabled = false;
    if (this.cheerTimestamp) {
      this.cheerTimestamp.textContent = formatTime(this.pendingTime || 0);
    }
    this.cheerInput.focus();
  }

  useHint(hint) {
    if (!hint || this.cheerInput.disabled) return;
    this.cheerInput.value = hint;
    this.cheerInput.focus();
  }

  commitEntry() {
    if (!this.session) {
      toast('還沒有練習', 'error');
      return;
    }
    if (this.pendingTime === null) {
      toast('請先按應援按鈕定位時間', 'error');
      return;
    }
    const text = this.cheerInput.value.trim();
    if (!text) {
      toast('請輸入應援句子', 'error');
      return;
    }
    const entry = {
      time: this.pendingTime,
      raw: text,
      normalized: normalizeText(text)
    };
    this.session.addEntry(entry);
    this.appendHistoryEntry(entry);
    this.pendingTime = null;
    this.cheerInput.value = '';
    this.cheerInput.disabled = true;
    if (this.cheerEntry) this.cheerEntry.classList.add('hidden');
    this.commitButton.disabled = true;
    if (this.cancelButton) this.cancelButton.disabled = true;
    if (this.hintSuggestions) {
      this.hintSuggestions.classList.add('hidden');
      this.resetHintSelection();
    }
    this.player.play();
    toast('已記錄', 'success');
  }

  cancelCheerEntry() {
    if (this.cheerInput.disabled) return;
    this.cheerInput.value = '';
    this.cheerInput.disabled = true;
    this.pendingTime = null;
    if (this.cheerEntry) this.cheerEntry.classList.add('hidden');
    this.commitButton.disabled = true;
    if (this.cancelButton) this.cancelButton.disabled = true;
    if (this.cheerTimestamp) this.cheerTimestamp.textContent = '0:00';
    if (this.hintSuggestions) this.hintSuggestions.classList.add('hidden');
    this.resetHintSelection();
    this.player.play();
  }

  showConfirmDialog(message) {
    if (!this.confirmModal || !this.confirmMessageEl) {
      return Promise.resolve(window.confirm(message));
    }
    if (this.confirmResolver) {
      this.resolveConfirmDialog(false);
    }
    this.confirmMessageEl.textContent = message;
    this.confirmModal.classList.remove('hidden');
    return new Promise((resolve) => {
      this.confirmResolver = resolve;
    });
  }

  resolveConfirmDialog(result) {
    if (!this.confirmResolver) return;
    this.confirmModal?.classList.add('hidden');
    const resolver = this.confirmResolver;
    this.confirmResolver = null;
    resolver(Boolean(result));
  }

  handleCancelResult() {
    this.player.play();
    this.resolveConfirmDialog(false);
  }

  showNameWarning() {
    this.nameWarningModal?.classList.remove('hidden');
  }

  hideNameWarning() {
    this.nameWarningModal?.classList.add('hidden');
  }

  showMobileCountdown() {
    if (!this.guideModal) return;
    this.guideInstructions?.classList.add('hidden');
    this.guideCountdown?.classList.remove('hidden');
    this.countdownNumberEl?.classList.add('hidden');
    this.mobileCountdownBtn?.classList.remove('hidden');
    this.mobileCountdownBtn?.classList.add('show');
    this.guideConfirmBtn?.classList.add('hidden');
    this.guideModal.classList.remove('hidden');
  }

  hideMobileCountdown() {
    this.mobileCountdownBtn?.classList.remove('show');
    this.mobileCountdownBtn?.classList.add('hidden');
    this.countdownNumberEl?.classList.remove('hidden');
    this.guideConfirmBtn?.classList.remove('hidden');
  }

  async handleMobileCountdownStart() {
    this.hideMobileCountdown();
    this.closeGuide();
    try {
      await this.beginVideoPlayback({ autoplay: false });
    } catch (err) {
      console.error('載入影片失敗', err);
      toast('載入影片失敗', 'error');
    }
    this.enablePracticeControls();
    this.player.play();
  }

  appendHistoryEntry(entry) {
    if (!this.cheerHistory) return;
    const item = document.createElement('div');
    item.className = 'cheer-history-item';
    item.innerHTML = `<strong>${formatTime(entry.time)}</strong><span>${entry.raw}</span>`;
    this.cheerHistory.appendChild(item);
  }

  triggerCheerAnimation() {
    if (!this.cheerButton) return;
    this.cheerButton.classList.remove('pulse');
    // force reflow to restart animation
    void this.cheerButton.offsetWidth;
    this.cheerButton.classList.add('pulse');
  }

  async finishPractice({ auto = false } = {}) {
    if (!this.session) {
      if (!auto) toast('請先開始練習', 'error');
      return;
    }
    this.player.pause();
    const session = this.session;
    if (!auto && !this.videoEnded) {
      const confirmed = await this.showConfirmDialog('影片還沒結束，確定要結束應援嗎？');
      if (!confirmed) return;
    }
    if (!session.entries.length) {
      if (!auto) toast('尚未紀錄任何應援', 'error');
      return;
    }
    const evaluation = evaluateSession(session);
    const mistakes = Math.max(0, evaluation.expectedCount - evaluation.textMatches + evaluation.extras);
    const rating = describeAccuracy(evaluation.score);
    this.resultEl.innerHTML = `
    <div class="result-summary">${session.challenger} ${evaluation.textMatches}/${evaluation.expectedCount} 句命中，錯誤 ${mistakes} 句（含多寫 ${evaluation.extras} 句）</div>
      <div class="result-score">正確率 ${evaluation.score}%</div>
      <div class="result-rating">${rating}</div>
      <div class="result-review">
        演唱會要開始了，趕快再來複習一下：
        <a href="https://www.youtube.com/watch?v=yZMmpkZVdug" target="_blank" rel="noopener noreferrer">TWICE THIS IS FOR 應援空耳合集</a>
      </div>
    `;

    const rankingEntry = {
      name: session.challenger,
      songLabel: `${session.song.artist} - ${session.song.title}`,
      score: evaluation.score,
      detail: `${evaluation.textMatches}/${evaluation.expectedCount} 命中，錯誤 ${mistakes}（額外 ${evaluation.extras}）`,
      createdAt: Date.now()
    };
    try {
      setLoading(true, '上傳結果中...');
      const remoteRankings = await this.reportResultToServer(rankingEntry);
      if (Array.isArray(remoteRankings) && remoteRankings.length) {
        this.rankings = remoteRankings;
      }
    } catch (err) {
      console.error('回報成績失敗', err);
      toast('上傳排行失敗', 'error');
    } finally {
      setLoading(false);
    }
    this.renderRanking();
    toast('結果已紀錄', 'success');
    this.setScoreboardVisible(true);
    this.renderResultDetails(session);
    this.player.stop();
    this.practiceLayout?.classList.add('show-results');
    this.session = null;
    this.resetPracticeUi({ preserveResult: true });
    this.handleChallengerInput();
  }

  renderRanking() {
    const rankings = this.rankings || [];
    this.rankingList.innerHTML = '';
    if (!rankings.length) {
      const li = document.createElement('li');
      li.textContent = '尚無紀錄';
      this.rankingList.appendChild(li);
      return;
    }
    const sorted = rankings.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
    let currentRank = 0;
    let previousScore = null;
    let rows = 0;
    for (let i = 0; i < sorted.length && rows < 10; i += 1) {
      const record = sorted[i];
      if (record.score !== previousScore) {
        currentRank = currentRank ? currentRank + 1 : 1;
        previousScore = record.score;
      }
      const row = document.createElement('div');
      row.innerHTML = `<span>${currentRank}</span><span>${record.name}</span><span>${record.score}%</span>`;
      row.classList.add(currentRank <= 3 ? 'top-rank' : 'regular-rank');
      this.rankingList.appendChild(row);
      rows += 1;
    }
  }

  renderResultDetails(session) {
    if (!this.resultDetails || !session?.song) return;
    const segments = (session.song.segments || []).map((segment) => {
      const range = parseRange(segment.range || '0:00-0:00');
      return { ...segment, ...range, normalizedOptions: normalizedPhraseOptions(segment.phrase) };
    });
    const rows = this.buildSegmentComparison(segments, session.entries || []);
    if (!rows.length) {
      this.resultDetails.innerHTML = '<p class="muted">此歌曲尚未設定應援時間段。</p>';
      this.resultDetails.classList.remove('hidden');
      return;
    }
    const header = `
      <div class="result-header">
        <span>正確應援</span>
        <span>你輸入的應援</span>
        <span>結果</span>
      </div>
    `;
    const body = rows
      .map(({ segment, entry, status }) => {
        const segmentBlock = segment
          ? `<div class="result-segment"><div class="result-time">${segment.range || formatTime(segment.start)}</div><div class="result-phrase">${segment.phrase || ''}</div></div>`
          : `<div class="result-segment"><div class="result-time">無此應援</div><div class="result-phrase"></div></div>`;
        const entryBlock = entry
          ? `<div class="result-entry"><strong>${formatTime(entry.time)}</strong><span>${entry.raw}</span></div>`
          : '<div class="result-entry"><span class="muted">未輸入</span></div>';
        const mark = status === 'hit' ? '✓' : '✕';
        return `
          <div class="result-row ${status}">
            ${segmentBlock}
            ${entryBlock}
            <div class="result-mark">${mark}</div>
          </div>
        `;
      })
      .join('');
    this.resultDetails.innerHTML = header + body;
    this.resultDetails.classList.remove('hidden');
  }

  buildSegmentComparison(segments, entries) {
    const used = new Set();
    const normalizedSegments = segments.map((segment) => ({
      ...segment,
      ...parseRange(segment.range || '0:00-0:00'),
      normalizedOptions: normalizedPhraseOptions(segment.phrase)
    }));
    const rows = normalizedSegments.map((segment) => {
      const idx = entries.findIndex((entry, index) => {
        if (used.has(index)) return false;
        return isWithinRange(entry.time, segment) && segment.normalizedOptions.includes(entry.normalized);
      });
      if (idx < 0) {
        return { segment, entry: null, status: 'missing' };
      }
      used.add(idx);
      const entry = entries[idx];
      const status = segment.normalizedOptions.includes(entry.normalized) ? 'hit' : 'wrong';
      return { segment, entry, status };
    });
    const extras = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ index }) => !used.has(index))
      .filter(({ entry }) => !isDuplicateOfUsed(entry, entries, used))
      .map(({ entry }) => ({ segment: null, entry, status: 'extra' }));
    return [...rows, ...extras].sort((a, b) => {
      const aTime = a.segment ? a.segment.start : a.entry.time;
      const bTime = b.segment ? b.segment.start : b.entry.time;
      return aTime - bTime;
    });
  }

  async reportResultToServer(entry) {
    const payload = { action: 'saveResult', entry };
    console.log('[應援結果上傳]', payload);
    try {
      const response = await fetch(APP_SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => []);
      console.log('[應援結果回應]', result);
      return normalizeRankingEntries(result);
    } catch (err) {
      throw err;
    }
  }
}

function evaluateSession(session) {
  const expectedSegments = (session.song.segments || []).map((segment) => ({
    ...segment,
    ...parseRange(segment.range),
    normalizedOptions: normalizedPhraseOptions(segment.phrase)
  }));

  const entries = session.entries;
  let textMatches = 0;
  const usedEntryIndex = new Set();
  expectedSegments.forEach((segment) => {
    const idx = entries.findIndex((entry, index) => {
      if (usedEntryIndex.has(index)) return false;
      const inRange = isWithinRange(entry.time, segment);
      return inRange && segment.normalizedOptions.includes(entry.normalized);
    });
    if (idx >= 0) {
      usedEntryIndex.add(idx);
      textMatches += 1;
    }
  });

  const extraEntries = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => !usedEntryIndex.has(index))
    .filter(({ entry }) => !isDuplicateOfUsed(entry, entries, usedEntryIndex)).length;
  const expectedCount = expectedSegments.length || 1;
  const effectiveHits = Math.max(0, textMatches - extraEntries);
  const score = Math.round((effectiveHits / expectedCount) * 100);

  return { score, textMatches, expectedCount, extras: extraEntries };
}

function parseRange(rangeText = '0:00-0:00') {
  const [startRaw, endRaw] = rangeText.split('-');
  const start = parseTime((startRaw || '0:00').trim());
  const end = parseTime((endRaw || startRaw || '0:00').trim());
  return { start, end };
}

function shiftRange(rangeText = '0:00-0:00', offsetSeconds = 0) {
  if (!offsetSeconds) return rangeText;
  const { start, end } = parseRange(rangeText);
  const newStart = Math.max(0, start + offsetSeconds);
  const newEnd = Math.max(newStart, end + offsetSeconds);
  return `${formatTime(newStart)}-${formatTime(newEnd)}`;
}

function alignSongSegments(song) {
  const offset = parseTime(song?.plainStart || '0:00') - parseTime(song?.cheerStart || '0:00');
  const segments = Array.isArray(song?.segments) ? song.segments : [];
  if (!offset) {
    return segments.map((segment) => ({ ...segment }));
  }
  return segments.map((segment) => ({
    ...segment,
    range: shiftRange(segment.range || '0:00-0:00', offset)
  }));
}

function isWithinRange(time, segment) {
  return time >= segment.start - TIME_TOLERANCE && time <= segment.end + TIME_TOLERANCE;
}

function describeAccuracy(score) {
  if (score >= 80) return '應援大師，演唱會誰能比你喊得大聲！ (*`∀´*)/ ';
  if (score >= 60) return '應援達人，不是你的問題是真的應援太難了對吧ヽ(・ε・*)';
  if (score >= 40) return '沒事我相信你只是金魚腦了一點(๑•̀ㅂ•́)و✧';
  if (score >= 20) return '你是不是想偷蹭別人背好的啊？演唱會要開始了欸(‘⊙д-)';
  return '我看你是根本沒有背吧ヽ(#`Д´)ﾉ';
}

function isDuplicateOfUsed(entry, entries, usedIndices) {
  return Array.from(usedIndices).some((idx) => {
    const usedEntry = entries[idx];
    if (!usedEntry) return false;
    return (
      usedEntry.normalized === entry.normalized &&
      Math.abs(usedEntry.time - entry.time) <= TIME_TOLERANCE
    );
  });
}

function normalizedPhraseOptions(phrase) {
  if (!phrase && phrase !== 0) return [''];
  if (Array.isArray(phrase)) {
    return phrase.map((item) => normalizeText(String(item))).filter(Boolean);
  }
  return String(phrase)
    .split(',')
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function isChallengerNameAllowed(name) {
const bannedWords = [
  // —— 中文粗口 —— 
  '幹', '乾你', '幹你', '淦',
  '靠北', '靠杯', '靠邀', '靠腰', '靠夭',
  '機掰', '雞掰', '雞巴', '雞八', '機八', '雞扒', 'ㄐㄅ',
  '他媽', '他媽的', '媽的', '你娘', '尼瑪', '你媽',
  '王八蛋', '白癡', '智障', '北七', '白爛',
  '廢物', '垃圾', '低能', '低能兒', '屁孩', '死屁孩',
  '醜', '醜八怪', '醜爆', '醜死', '長得醜', '你很醜', '丑八怪', '丑死', '醜人', '醜女', '醜男',

  // —— 英文粗口 —— 
  'fuck', 'fuk', 'fk', 'f*ck', 'f**k',
  'shit', 'sh1t',
  'bitch', 'asshole', 'dick', 'bastard', 'motherfucker',
  'wtf', 'stfu', 'fml', 'ugly', 'so ugly', 'very ugly', 'ugly af',

  // —— 簡體粗口 —— 
  'nmsl', 'cnm', 'tmd', 'sb',
  '傻逼', '煞筆', '草泥馬', '你媽死了',

  // —— 性相關（中文） —— 
  '色色', '色', '想色色',
  '做愛', '做愛', '約砲', '約炮', '約啪',
  '開房', '床上', '性', '性慾', 
  '胸部', '奶子', '奶', '大奶',
  '小穴', '下面', '下體',
  '屁股', '屁眼',
  '裸照', '裸', '裸體',
  '調教', '無套', '潮吹', '發情', '性器官',

  // —— 性相關（英文） —— 
  'sex', 'sexy', 'nsfw',
  'horny', 'nude', 'naked',
  'breast', 'boobs', 'tits',
  'ass', 'anal',
  'cum', 'sperm',
  'porn', 'pornhub', 'bdsm',

  // —— 性相關簡體 —— 
  '撩', '開車', '開黃腔',
  '啪', '涩涩', '涩',
  '丝袜', '情趣', '性福',

  // —— 變形字 / 躲避審查常見 —— 
  's3x', 'sx', 's.e.x',
  'nai', 'ㄋㄞ', '奶奶',
  'luo', 'luo zhao',
  '工口',
  '18禁', '18x', '成人'
];
  const normalized = name.toLowerCase();
  return !bannedWords.some((word) => normalized.includes(word));
}

function isMobileDevice() {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

function isSafariBrowser() {
  const ua = navigator.userAgent || '';
  const isSafari = /Safari/i.test(ua);
  const isOtherWebkit = /Chrome|CriOS|Chromium|Android|Edge|Edg|OPR/i.test(ua);
  return isSafari && !isOtherWebkit;
}

function requiresManualPlayback() {
  if (isMobileDevice()) return true;
  if (isSafariBrowser()) return true;
  return false;
}

function normalizeText(text) {
  return text
    .toLowerCase() 
    .replace(/[^\w\s\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTime(value = '0:00') {
  const [minutePart = '0', secondPart = '0'] = value.split(':');
  const minutes = parseInt(minutePart, 10) || 0;
  const seconds = parseInt(secondPart, 10) || 0;
  return minutes * 60 + seconds;
}

function formatTime(seconds = 0) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function extractVideoId(url) {
  if (!url) return '';
  const trimmed = url.trim();
  if (/^[\w-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  const match =
    trimmed.match(/[?&]v=([^&#]+)/) ||
    trimmed.match(/youtu.be\/([^?&#]+)/) ||
    trimmed.match(/youtube\.com\/embed\/([^?&#]+)/) ||
    trimmed.match(/shorts\/([^?&#]+)/);
  return match ? match[1] : '';
}

function mountTemplates() {
  const practiceView = document.getElementById('practice-view');
  const practiceTemplate = document.getElementById('practice-template');
  practiceView.appendChild(practiceTemplate.content.cloneNode(true));

  const settingsView = document.getElementById('settings-view');
  const settingsTemplate = document.getElementById('settings-template');
  settingsView.appendChild(settingsTemplate.content.cloneNode(true));
}

function applyInitialView() {
  const forced = document.body?.dataset?.forceSettings === '1';
  const practiceView = document.getElementById('practice-view');
  const settingsView = document.getElementById('settings-view');
  if (forced) {
    settingsView.classList.add('active');
    practiceView.classList.remove('active');
  } else {
    practiceView.classList.add('active');
    settingsView.classList.remove('active');
  }
}

async function fetchSongsFromServer({ silent = false } = {}) {
  if (!silent) setLoading(true, '讀取歌曲中...');
  try {
    // 原 App Script 寫法保留：
    // const response = await fetch(APP_SCRIPT_URL, {
    //   method: 'POST',
    //   body: JSON.stringify({ action: 'list' })
    // });
    // const raw = await response.json().catch(() => []);
    const raw = await FirebaseApi.listSongs();
    const songs = normalizeFetchedSongs(raw);
    SongStore.setSongs(songs);
    if (!silent) toast('歌曲已更新', 'success');
    return songs;
  } catch (err) {
    console.error('讀取歌曲失敗', err);
    if (!silent) toast('讀取歌曲失敗', 'error');
    throw err;
  } finally {
    if (!silent) setLoading(false);
  }
}

function normalizeFetchedSongs(raw) {
  const flatten = (value) => {
    if (Array.isArray(value)) {
      return value.flatMap((item) => flatten(item));
    }
    return value == null ? [] : [value];
  };

  if (typeof raw === 'string') {
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return normalizeFetchedSongs(lines);
  }

  const source = Array.isArray(raw)
    ? flatten(raw)
    : Array.isArray(raw?.songs)
    ? flatten(raw.songs)
    : Array.isArray(raw?.info)
    ? flatten(raw.info)
    : flatten(raw ? [raw] : []);
  return source
    .map((entry) => parseSongEntry(entry))
    .map((song) => normalizeSong(song))
    .filter(Boolean);
}

function parseSongEntry(entry) {
  if (!entry) return null;
  if (Array.isArray(entry)) {
    return parseSongRow(entry);
  }
  if (typeof entry === 'string') {
    return parseSongString(entry);
  }
  if (entry.song) return entry.song;
  if (entry.info && entry.info.song) return entry.info.song;
  if (entry.id) return entry;
  return null;
}

function parseSongRow(row) {
  if (!Array.isArray(row)) return null;
  if (row.length === 1) return parseSongEntry(row[0]);
  const [idCell, payload] = row;
  let song = {};
  if (typeof payload === 'string') {
    song = parseSongString(payload) || {};
  } else if (payload && typeof payload === 'object') {
    song = payload.song || payload.info?.song || payload;
  }
  if (idCell && !song.id) {
    song.id = String(idCell).trim();
  }
  return song;
}

function parseSongString(text = '') {
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  const songMatch = trimmed.match(/song=\{(.+)\}\s*}?$/);
  if (songMatch) {
    return mapStringToObject(songMatch[1]);
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return mapStringToObject(trimmed);
  }
  return null;
}

function mapStringToObject(str) {
  const content = str.trim();
  const inner = content.startsWith('{') && content.endsWith('}') ? content.slice(1, -1) : content;
  const pairs = splitTopLevelPairs(inner);
  const result = {};
  pairs.forEach(({ key, value }) => {
    if (!key) return;
    const trimmedValue = value.trim();
    if (trimmedValue.startsWith('{') && trimmedValue.endsWith('}')) {
      result[key] = mapStringToObject(trimmedValue);
    } else {
      result[key] = trimmedValue;
    }
  });
  return result;
}

function splitTopLevelPairs(str) {
  const entries = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < str.length; i += 1) {
    const char = str[i];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      entries.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) entries.push(current);
  const merged = [];
  entries.forEach((entry) => {
    if (!entry.trim()) return;
    if (!entry.includes('=') && merged.length) {
      merged[merged.length - 1] += `,${entry}`;
    } else {
      merged.push(entry);
    }
  });
  return merged.map((entry) => {
    const idx = entry.indexOf('=');
    if (idx < 0) return { key: entry.trim(), value: '' };
    return {
      key: entry.slice(0, idx).trim(),
      value: entry.slice(idx + 1).trim()
    };
  });
}

function normalizeRankingEntries(raw) {
  const collected = [];
  (function collect(value) {
    if (Array.isArray(value)) {
      value.forEach((item) => collect(item));
    } else if (value != null) {
      collected.push(value);
    }
  })(raw);
  return collected
    .map((entry) => parseRankingEntry(entry))
    .filter((entry) => entry && entry.name);
}

function parseRankingEntry(entry) {
  if (!entry) return null;
  if (Array.isArray(entry)) return parseRankingEntry(entry[0]);
  if (typeof entry === 'string') {
    const obj = mapStringToObject(entry);
    if (obj.entry) return obj.entry;
    return obj;
  }
  if (entry.entry) return entry.entry;
  return entry;
}

function normalizeSong(song) {
  if (!song || !song.id) return null;
  return {
    id: song.id,
    artist: song.artist || '',
    title: song.title || '',
    cheerVideo: song.cheerVideo || '',
    cheerStart: song.cheerStart || '0:00',
    plainVideo: song.plainVideo || '',
    plainStart: song.plainStart || '0:00',
    segments: normalizeSegments(song.segments),
    hints: normalizeHints(song.hints)
  };
}

function normalizeSegments(rawSegments) {
  if (Array.isArray(rawSegments)) {
    return rawSegments
      .map((segment) => ({
        range: segment?.range || '',
        phrase: segment?.phrase || ''
      }))
      .filter((segment) => segment.range && segment.phrase);
  }
  if (rawSegments && typeof rawSegments === 'object') {
    const range = rawSegments.range || '';
    const phrase = rawSegments.phrase || '';
    return range && phrase ? [{ range, phrase }] : [];
  }
  if (typeof rawSegments === 'string') {
    const [range, phrase] = rawSegments.split(',').map((value) => value.trim());
    return range && phrase ? [{ range, phrase }] : [];
  }
  return [];
}

function normalizeHints(rawHints) {
  if (Array.isArray(rawHints)) {
    return rawHints
      .flatMap((hint) => splitHints(String(hint)))
      .filter(Boolean);
  }
  if (typeof rawHints === 'string') {
    return splitHints(rawHints);
  }
  if (rawHints) return [String(rawHints)];
  return [];
}

function splitHints(text) {
  return text
    .split(',')
    .map((hint) => hint.trim())
    .filter(Boolean);
}

function main() {
  mountTemplates();
  applyInitialView();
  const practiceController = new PracticeController(document.getElementById('practice-view'));
  const settingsController = new SettingsController(document.getElementById('settings-view'), {
    onSongsChange: () => practiceController.populateSongs()
  });
  fetchSongsFromServer()
    .then(() => {
      settingsController.renderSongList();
      practiceController.populateSongs();
      const forcedSettings = document.body?.dataset?.forceSettings === '1';
      if (!forcedSettings) {
        UserPrefs.saveChallenger(practiceController.challengerInput.value.trim());
        practiceController.handleChallengerInput();
      }
    })
    .catch((err) => {
      console.error('初始化歌曲資料失敗', err);
    });
  return { practiceController, settingsController };
}

main();
