"use strict";
/* ============================================================
   game.js — Hedef Avı oyun mantığı
   ADIM 3: tek kişi oyun mantığı
   ADIM 4: 1-3 oyuncu; skorlar oyuncu indeksiyle tutulur, çarpışmada
           hedefe en yakın bilek puanı alır
   İçerik: Sound (Web Audio beep) + Game (geri sayım, hedefler,
   çarpışma, skor, 30 sn tur, localStorage rekoru)
   ============================================================ */

/* ============================================================
   SES — Web Audio API (dosya gerekmez)
   Tarayıcılar sesi ancak kullanıcı dokunuşundan sonra açar;
   bu yüzden unlock() "Başla" / "Tekrar Oyna" butonunda çağrılır.
   ============================================================ */
const Sound = {
  ctx: null,
  volume: 0.5,   // 0-1 (Adım 5'te ses kontrolü buna bağlanacak)

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  },

  // freq: Hz, dur: saniye, delay: kaç saniye sonra çalsın
  beep(freq = 880, dur = 0.08, delay = 0, type = "sine") {
    if (!this.ctx || this.volume <= 0) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    // Küçük "tık" sesini önlemek için yumuşak giriş/çıkış
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.4 * this.volume, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  },

  hit()   { this.beep(880, 0.07); this.beep(1320, 0.09, 0.05); },  // vuruş: iki kısa nota
  tick()  { this.beep(520, 0.1); },                                // geri sayım
  go()    { this.beep(990, 0.25); },                               // "Başla!"
  end()   { this.beep(660, 0.15); this.beep(440, 0.3, 0.18); },    // tur bitti
};

/* ============================================================
   OYUN
   ============================================================ */
const Game = {
  // Zorluk / denge ayarları (setDifficulty() hedef ve doğma değerlerini değiştirir)
  config: {
    roundSeconds: 30,
    countdownSeconds: 3,
    maxTargets: 3,            // aynı anda en fazla
    spawnMinMs: 800,          // yeni hedef aralığı 0.8-1.2 sn
    spawnMaxMs: 1200,
    lifetimeMs: 3000,         // vurulmazsa kaç ms sonra kaybolur
    targetRadiusFrac: 0.08,   // hedef yarıçapı = kısa kenar × bu
    wristRadiusFrac: 0.035,   // bilek "vuruş" yarıçapı = kısa kenar × bu
  },

  /* Zorluk ön ayarları: seçilince config'in ilgili alanlarının üzerine yazılır.
     "normal" = ilk sürümdeki değerler (0.8-1.2 sn, max 3 hedef). */
  DIFFICULTY: {
    easy:   { label: "Kolay",  desc: "Büyük hedefler, yavaş doğma, uzun süre kalır",
              maxTargets: 2, spawnMinMs: 1100, spawnMaxMs: 1500, lifetimeMs: 4000, targetRadiusFrac: 0.095 },
    normal: { label: "Normal", desc: "Her 0.8–1.2 sn'de yeni hedef, en fazla 3",
              maxTargets: 3, spawnMinMs: 800,  spawnMaxMs: 1200, lifetimeMs: 3000, targetRadiusFrac: 0.08 },
    hard:   { label: "Zor",    desc: "Küçük hedefler, hızlı doğma, kısa süre kalır",
              maxTargets: 3, spawnMinMs: 500,  spawnMaxMs: 800,  lifetimeMs: 2000, targetRadiusFrac: 0.065 },
  },
  difficulty: "normal",

  setDifficulty(name) {
    const preset = this.DIFFICULTY[name];
    if (!preset) return;
    this.difficulty = name;
    const { label, desc, ...values } = preset;   // etiket/açıklama config'e girmez
    Object.assign(this.config, values);
  },

  RECORD_KEY: "hedefAvi.record.v2",   // sonuna ".easy/.normal/.hard" eklenir: her seviyenin rekoru ayrı

  phase: "idle",              // "idle" | "countdown" | "playing"
  countdownEnd: 0,
  playEnd: 0,
  nextSpawn: 0,
  hideCountdownAt: 0,
  flashUntil: 0,              // ekran geneli yeşil parlama bitişi
  targets: [],                // {x, y, r, born, phase}
  effects: [],                // vuruş halkaları {x, y, r, born}
  _lastCount: null,
  _lastSec: null,

  onEnd: null,                // main.js atar: tur bitince çağrılır
  lastResult: null,           // {scores, record, isNew}

  /* ---------- Başlat / durdur ---------- */
  start() {
    const c = this.config;
    this._reset();
    this.phase = "countdown";
    this.countdownEnd = performance.now() + c.countdownSeconds * 1000;
    this._setTimer(c.roundSeconds);
  },

  stop() {
    this._reset();
  },

  _reset() {
    this.phase = "idle";
    this.targets = [];
    this.effects = [];
    this.flashUntil = 0;
    this.hideCountdownAt = 0;
    this._lastCount = null;
    this._lastSec = null;
    this._showCountdown("");
  },

  /* ---------- Her karede çağrılır (App.frameHooks) ---------- */
  update(ctx, w, h) {
    if (this.phase === "idle" || App.state.screen !== "game") return;
    const now = performance.now();
    const c = this.config;

    /* --- 3-2-1 geri sayım --- */
    if (this.phase === "countdown") {
      const left = this.countdownEnd - now;
      if (left > 0) {
        const n = Math.ceil(left / 1000);
        if (n !== this._lastCount) {
          this._lastCount = n;
          this._showCountdown(String(n));
          Sound.tick();
        }
        return;
      }
      // Tur başlıyor
      this.phase = "playing";
      this.playEnd = now + c.roundSeconds * 1000;
      this.nextSpawn = now + 300;
      this.hideCountdownAt = now + 700;
      this._showCountdown("Başla!", true);
      Sound.go();
    }

    /* --- Oyun --- */
    if (this.hideCountdownAt && now > this.hideCountdownAt) {
      this.hideCountdownAt = 0;
      this._showCountdown("");
    }

    const msLeft = this.playEnd - now;
    if (msLeft <= 0) {
      this._finish();
      return;
    }
    this._setTimer(Math.ceil(msLeft / 1000));

    // Doğma: aralıkta bir kez, ekranda max 3 hedef varsa bekle
    if (now >= this.nextSpawn) {
      if (this.targets.length < c.maxTargets) this._spawn(w, h, now);
      this.nextSpawn = now + c.spawnMinMs + Math.random() * (c.spawnMaxMs - c.spawnMinMs);
    }

    // Süresi dolan hedefleri kaldır
    this.targets = this.targets.filter((t) => now - t.born < c.lifetimeMs);

    // Çarpışma + çizim
    this._collide(w, h, now);
    this._draw(ctx, w, h, now);
  },

  /* ---------- Hedef doğurma ---------- */
  _spawn(w, h, now) {
    const c = this.config;
    const m = Math.min(w, h);
    const r = m * c.targetRadiusFrac;
    const xMin = r * 1.3, xMax = w - r * 1.3;
    const yMin = Math.max(r * 1.3, h * 0.12);   // üst köşede süre göstergesi var
    const yMax = h - r * 1.3;
    if (xMax <= xMin || yMax <= yMin) return;

    // Diğer hedeflerle üst üste binmeyen bir yer bul
    for (let tries = 0; tries < 12; tries++) {
      const x = xMin + Math.random() * (xMax - xMin);
      const y = yMin + Math.random() * (yMax - yMin);
      const free = this.targets.every((t) => Math.hypot(t.x - x, t.y - y) > r * 2.5);
      if (free) {
        this.targets.push({ x, y, r, born: now, phase: Math.random() * 6.28 });
        return;
      }
    }
  },

  /* ---------- Daire-daire çarpışma: bilek ↔ hedef ----------
     Pose.getWrists() oyuncu sırasına göredir: [0]=Kırmızı, [1]=Mavi, [2]=Yeşil
     (görünmeyen oyuncu = null). Aynı hedefe birden fazla bilek değiyorsa
     HEDEFE EN YAKIN bilek (yani onun oyuncusu) puanı alır. Bir bilek, bir karede
     en fazla bir hedefi vurur; böylece iç içe iskeletlerde çifte sayım olmaz. */
  _collide(w, h, now) {
    if (!this.targets.length) return;
    const wrists = Pose.getWrists(w, h, App.state.mirror);
    const wristR = Math.min(w, h) * this.config.wristRadiusFrac;
    const players = Math.min(wrists.length, App.state.playerCount);

    // Görünür tüm bilekleri tek listeye topla
    const list = [];
    for (let p = 0; p < players; p++) {
      if (!wrists[p]) continue;
      for (const wrist of [wrists[p].left, wrists[p].right]) {
        if (wrist.visible) list.push({ player: p, x: wrist.x, y: wrist.y, used: false });
      }
    }
    if (!list.length) return;

    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i];
      const reach = t.r + wristR;
      let best = null, bestD = reach * reach;      // en iyi = erişim içindeki en yakın kullanılmamış bilek
      for (const wr of list) {
        if (wr.used) continue;
        const dx = wr.x - t.x, dy = wr.y - t.y;
        const d = dx * dx + dy * dy;
        if (d <= bestD) { best = wr; bestD = d; }
      }
      if (best) {
        best.used = true;
        this.targets.splice(i, 1);
        this._onHit(best.player, t, now);
      }
    }
  },

  _onHit(player, target, now) {
    App.state.scores[player] += 1;
    this._updateScorePanel(player);
    this.effects.push({ x: target.x, y: target.y, r: target.r, born: now });
    this.flashUntil = now + 200;
    Sound.hit();
  },

  /* ---------- Çizim ---------- */
  _draw(ctx, w, h, now) {
    // Yeşil ekran parlaması (kısa, hafif)
    if (now < this.flashUntil) {
      ctx.fillStyle = `rgba(57, 255, 136, ${0.16 * ((this.flashUntil - now) / 200)})`;
      ctx.fillRect(0, 0, w, h);
    }

    for (const t of this.targets) this._drawTarget(ctx, t, now);

    // Vuruş efektleri: genişleyen yeşil halka + parıltı
    this.effects = this.effects.filter((e) => now - e.born < 400);
    for (const e of this.effects) {
      const p = (now - e.born) / 400;           // 0 → 1
      ctx.save();
      ctx.globalAlpha = 1 - p;
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.r * (1.2 + p));
      g.addColorStop(0, "rgba(57,255,136,0.7)");
      g.addColorStop(1, "rgba(57,255,136,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * (1.2 + p), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#39ff88";
      ctx.lineWidth = Math.max(2, e.r * 0.22 * (1 - p));
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * (1 + 1.4 * p), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  },

  _drawTarget(ctx, t, now) {
    const life = this.config.lifetimeMs;
    const age = now - t.born;
    const appear = Math.min(1, age / 150);                    // hızlı büyüyerek belirir
    const pulse = 1 + 0.05 * Math.sin(now / 120 + t.phase);   // hafif nabız
    const r = t.r * appear * pulse;
    const alpha = Math.min(1, (life - age) / 500);            // son yarım saniyede solar

    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);

    // Parlayan gövde
    ctx.shadowColor = "#ffd60a";
    ctx.shadowBlur = r * 0.7;
    const g = ctx.createRadialGradient(t.x, t.y, r * 0.1, t.x, t.y, r);
    g.addColorStop(0, "rgba(255, 248, 190, 0.95)");
    g.addColorStop(0.6, "rgba(255, 190, 20, 0.85)");
    g.addColorStop(1, "rgba(255, 120, 0, 0.45)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // İç halka
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = Math.max(2, r * 0.09);
    ctx.beginPath();
    ctx.arc(t.x, t.y, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();

    // Kalan süre halkası (saat yönünde azalır)
    const remain = Math.max(0, 1 - age / life);
    ctx.lineWidth = Math.max(2, r * 0.1);
    ctx.beginPath();
    ctx.arc(t.x, t.y, r * 1.18, -Math.PI / 2, -Math.PI / 2 + remain * Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  },

  /* ---------- Tur sonu ---------- */
  _finish() {
    const scores = App.state.scores.slice();
    this._reset();
    this._setTimer(0);

    let record = null, isNew = false;
    if (App.state.playerCount === 1) {
      ({ record, isNew } = this._updateRecord(scores[0]));
    }
    this.lastResult = { scores, record, isNew, difficulty: this.difficulty };
    Sound.end();
    if (this.onEnd) this.onEnd(this.lastResult);
  },

  /* ---------- Kişisel rekor (localStorage) ---------- */
  getRecord() {
    try {
      const v = Number(localStorage.getItem(this.RECORD_KEY + "." + this.difficulty));
      return Number.isFinite(v) ? v : 0;
    } catch (e) {
      return 0;     // gizli sekme vb. durumda sessizce 0
    }
  },

  _updateRecord(score) {
    const prev = this.getRecord();
    if (score > prev) {
      try { localStorage.setItem(this.RECORD_KEY + "." + this.difficulty, String(score)); } catch (e) { /* yoksay */ }
      return { record: score, isNew: true };
    }
    return { record: prev, isNew: false };
  },

  /* ---------- Ekran (DOM) yardımcıları ---------- */
  _setTimer(sec) {
    if (sec === this._lastSec) return;
    this._lastSec = sec;
    const el = document.getElementById("timer");
    if (!el) return;
    el.textContent = sec;
    el.classList.toggle("low", sec <= 5 && sec > 0);
  },

  _showCountdown(text, isWord = false) {
    const el = document.getElementById("countdown");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("word", isWord);
    if (text) {                       // animasyonu yeniden başlat
      el.classList.remove("tick");
      void el.offsetWidth;
      el.classList.add("tick");
    }
  },

  _updateScorePanel(player) {
    const el = document.querySelector(`.score[data-player="${player}"]`);
    if (!el) return;
    el.textContent = App.state.scores[player];
    const panel = el.parentElement;
    panel.classList.remove("bump");
    void panel.offsetWidth;
    panel.classList.add("bump");
  },
};

// main.js bunu App.frameHooks'a ekler (Pose.frameHook'tan SONRA, çıkarım güncel olsun)
Game.frameHook = function (ctx, w, h) {
  Game.update(ctx, w, h);
};
