"use strict";
/* ============================================================
   main.js — Ekran geçişleri, oyuncu yönetimi, kamera
   ADIM 1: kamera izni + canvas'a kamera önizlemesi
   ADIM 2: pose.js (MediaPipe) bağlandı; model hazır olunca "Başla" açılır
   ADIM 3: game.js (hedefler, çarpışma, skor, 30 sn tur, rekor) bağlandı
   ADIM 4: 1-3 oyuncu (renkler, skor panelleri, kazanan rengi)
   ADIM 5: Ayarlar (zorluk, ses, FPS), Perf (FPS ölçümü + ısınma yönetimi),
           ekranı uyanık tutma
   ============================================================ */

/* ---------- Sabitler ---------- */
// Oyuncu renkleri (Adım 4'te iskelet ve skor paneli bu renkleri kullanacak)
const PLAYER_COLORS = [
  { name: "Kırmızı", hex: "#ff4d5a" },
  { name: "Mavi",    hex: "#3d8bff" },
  { name: "Yeşil",   hex: "#2fe07a" },
];

/* ---------- Genel durum ---------- */
const App = {
  state: {
    screen: "menu",
    playerCount: 1,
    facing: "environment",   // "environment" = arka kamera, "user" = ön kamera
    mirror: false,           // ön kamerada görüntü ayna gibi çevrilir
    cameraReady: false,
    scores: [],              // oyuncu başına puan (Adım 3-4'te kullanılacak)
  },
  video: null,
  canvas: null,
  ctx: null,
  stream: null,
  camToken: 0,               // eski/yarım kalmış kamera isteklerini iptal etmek için
  // Her karede canvas üzerine çizim yapmak isteyen modüller buraya fonksiyon ekler:
  // App.frameHooks.push((ctx, w, h) => { ... });
  frameHooks: [],
  // Kullanıcı ayarları (localStorage'da saklanır, Ayarlar ekranından değişir)
  settings: {
    difficulty: "normal",    // "easy" | "normal" | "hard"
    volume: 0.5,             // 0-1
    showFps: false,          // FPS rozeti
  },
};

const $ = (id) => document.getElementById(id);

/* ============================================================
   EKRAN YÖNETİMİ
   ============================================================ */
function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => {
    s.classList.toggle("active", s.dataset.screen === name);
  });
  App.state.screen = name;

  // Oyun ekranından çıkılırsa tur durur (süre/hedefler sıfırlanır)
  if (name !== "game") Game.stop();

  // Kalibrasyon ve oyun sırasında telefon ekranı kararmasın
  keepAwake(name === "calibration" || name === "game");

  if (name === "calibration") {
    moveCanvasTo("slot-calibration");
    if (!App.state.cameraReady) startCamera();
    // Model kamerayla paralel yüklenir; oyuncu sayısı kadar kişi aranır
    Pose.init(App.state.playerCount).then(updateStartButton);
  } else if (name === "game") {
    // Kamera akışı yoksa (kopmuş vb.) önce kalibrasyona dön
    if (!App.state.cameraReady) { showScreen("calibration"); return; }
    moveCanvasTo("slot-game");
    resetScores();
    renderScorePanels();
    Game.start();            // 3-2-1 geri sayım → 30 sn tur
  } else if (name === "result") {
    renderResult();
  } else {
    // menü ve oyuncu seçimi: kameraya gerek yok, kapat (pil + ısınma)
    stopCamera();
  }
}

// Tek bir canvas var; aktif ekrandaki "slot"a taşınır
function moveCanvasTo(slotId) {
  $(slotId).prepend(App.canvas);
}

/* ============================================================
   OYUNCU / SKOR PANELİ (iskelet — mantık Adım 3-4'te)
   ============================================================ */
function resetScores() {
  App.state.scores = new Array(App.state.playerCount).fill(0);
}

function renderScorePanels() {
  const bar = $("score-bar");
  bar.innerHTML = "";
  for (let i = 0; i < App.state.playerCount; i++) {
    const c = PLAYER_COLORS[i];
    const panel = document.createElement("div");
    panel.className = "score-panel";
    panel.style.setProperty("--c", c.hex);
    panel.innerHTML =
      `<span class="name">${c.name}</span>` +
      `<span class="score" data-player="${i}">0</span>`;
    bar.appendChild(panel);
  }
}

// "Başla" sadece kamera VE model hazırsa açılır
function updateStartButton() {
  $("btn-start").disabled = !(App.state.cameraReady && Pose.ready);
}

function renderResult() {
  const scores = App.state.scores;
  const res = Game.lastResult || {};

  // Skor satırları
  const table = $("result-table");
  table.innerHTML = "";
  scores.forEach((pts, i) => {
    const c = PLAYER_COLORS[i];
    const row = document.createElement("div");
    row.className = "result-row";
    row.style.setProperty("--c", c.hex);
    row.innerHTML = `<span>${c.name}</span><span class="pts">${pts}</span>`;
    table.appendChild(row);
  });

  // Başlık: tek kişide rekor, çok kişide kazanan
  let text;
  let color = "";        // çok oyunculuda tek kazanan varsa başlık onun renginde
  if (App.state.playerCount === 1) {
    const lvl = Game.DIFFICULTY[res.difficulty || Game.difficulty].label;   // rekor seviyeye göre
    text = res.isNew
      ? `🎉 Yeni rekor! ${scores[0]} puan (${lvl})`
      : `Skorun: ${scores[0]} · Rekor (${lvl}): ${res.record}`;
  } else {
    const max = Math.max(...scores);
    const winners = [];
    scores.forEach((s, i) => { if (s === max) winners.push(i); });
    text = winners.length === 1
      ? `🏆 ${PLAYER_COLORS[winners[0]].name} kazandı!`
      : "🤝 Berabere!";
    if (winners.length === 1) color = PLAYER_COLORS[winners[0]].hex;
  }
  const banner = $("winner-banner");
  banner.textContent = text;
  banner.style.color = color;
  banner.classList.remove("pop");   // animasyonu yeniden başlat
  void banner.offsetWidth;
  banner.classList.add("pop");
}

/* ============================================================
   KAMERA
   ============================================================ */
function setCamStatus(text, opts = {}) {
  // opts.hide: katmanı gizle | opts.retry: "Tekrar Dene" butonunu göster
  $("cam-status").classList.toggle("hidden", !!opts.hide);
  $("cam-status-text").textContent = text;
  $("btn-cam-retry").hidden = !opts.retry;
}

function explainCameraError(err) {
  switch (err && err.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Kamera izni verilmedi. Chrome'da adres çubuğundaki ayarlar/kilit simgesine dokun → İzinler → Kamera → İzin ver. Sonra “Tekrar Dene”.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Kamera bulunamadı.";
    case "NotReadableError":
      return "Kamera başka bir uygulama tarafından kullanılıyor olabilir. Diğer uygulamaları kapatıp tekrar dene.";
    default:
      return "Kamera açılamadı (" + (err && err.name ? err.name : "bilinmeyen hata") + ").";
  }
}

async function startCamera() {
  stopCamera();
  const token = ++App.camToken;
  setCamStatus("Kamera izni isteniyor…");
  updateStartButton();

  // getUserMedia sadece https:// veya http://localhost üzerinde çalışır
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setCamStatus(
      "Bu sayfada kamera kullanılamıyor. Sayfa https:// veya localhost üzerinden açılmalı (file:// çalışmayabilir). GitHub Pages ya da Netlify Drop ile yayınla.",
      { retry: true }
    );
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        // "ideal": arka kamera yoksa (ör. bilgisayar) mevcut kameraya düşer
        facingMode: { ideal: App.state.facing },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    // Beklerken kullanıcı geri bastıysa akışı hemen kapat
    if (token !== App.camToken) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    App.stream = stream;
    App.video.srcObject = stream;
    await App.video.play();

    const settings = stream.getVideoTracks()[0].getSettings();
    const facing = settings.facingMode || App.state.facing;
    App.state.mirror = facing === "user";
    App.state.cameraReady = true;

    $("cam-info").textContent =
      `${App.video.videoWidth}×${App.video.videoHeight} · ` +
      (facing === "user" ? "ön kamera" : "arka kamera");
    setCamStatus("", { hide: true });
    updateStartButton();
  } catch (err) {
    if (token !== App.camToken) return;
    console.error("Kamera hatası:", err);
    setCamStatus(explainCameraError(err), { retry: true });
  }
}

function stopCamera() {
  App.camToken++;   // bekleyen istekleri geçersiz kıl
  if (App.stream) {
    App.stream.getTracks().forEach((t) => t.stop());
    App.stream = null;
  }
  App.video.srcObject = null;
  App.state.cameraReady = false;
  Pose.clear();   // eski iskelet ekranda kalmasın
}

function flipCamera() {
  App.state.facing = App.state.facing === "environment" ? "user" : "environment";
  startCamera();
}

/* ============================================================
   AYARLAR (zorluk, ses, FPS rozeti) — localStorage'da saklanır
   ============================================================ */
const SETTINGS_KEY = "hedefAvi.settings.v1";

function loadSettings() {
  try {
    Object.assign(App.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
  } catch (e) { /* bozuk/yok: varsayılanlarla devam */ }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(App.settings)); } catch (e) { /* yoksay */ }
}

// Ayarları oyuna uygula + Ayarlar ekranındaki kontrolleri güncelle
function applySettings() {
  const s = App.settings;
  if (!Game.DIFFICULTY[s.difficulty]) s.difficulty = "normal";
  s.volume = Math.min(1, Math.max(0, Number(s.volume) || 0));

  Game.setDifficulty(s.difficulty);
  Sound.volume = s.volume;
  $("fps-badge").hidden = !s.showFps;

  document.querySelectorAll("[data-diff]").forEach((b) => {
    b.classList.toggle("active", b.dataset.diff === s.difficulty);
  });
  $("diff-desc").textContent = Game.DIFFICULTY[s.difficulty].desc;
  $("range-volume").value = Math.round(s.volume * 100);
  $("volume-val").textContent = Math.round(s.volume * 100);
  $("chk-fps").checked = s.showFps;
}

/* ============================================================
   EKRANI UYANIK TUT (Screen Wake Lock) — destekleyen tarayıcılarda
   ============================================================ */
let wakeLock = null;

async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) { /* desteklenmiyor / pil tasarrufu reddetti: sorun değil */ }
}

/* ============================================================
   PERF: FPS ölçümü + ısınma yönetimi
   - Her saniye çizim FPS'i ve saniyedeki analiz sayısı ölçülür.
   - FPS < 20 iki saniye sürerse analiz her 2. kamera karesine düşer
     (Pose.frameSkip = 2): telefon daha az ısınır, çizim akıcı kalır.
   - FPS uzun süre (20 sn) rahatsa tekrar her kareye dönülür.
   ============================================================ */
const Perf = {
  LOW_FPS: 20,          // bunun altı "yük fazla"
  LOW_SECONDS: 2,       // kaç saniye üst üste düşük olursa yavaşlat
  HIGH_FPS: 45,         // bunun üstü "rahat"
  HIGH_SECONDS: 20,     // kaç saniye rahat olursa eski hıza dön

  frames: 0,
  windowStart: 0,
  lastTick: 0,
  lastDet: 0,
  fps: 0,
  analysisFps: 0,
  lowStreak: 0,
  highStreak: 0,

  // Her çizilen karede çağrılır
  tick(now) {
    // Çizim durmuşsa (ekran değişti vb.) ölçümü baştan başlat; yoksa sahte düşük FPS çıkar
    if (now - this.lastTick > 250) {
      this.frames = 0;
      this.windowStart = now;
      this.lastDet = Pose.detections;
      this.lowStreak = 0;
      this.highStreak = 0;
    }
    this.lastTick = now;
    this.frames++;

    const dt = now - this.windowStart;
    if (dt < 1000) return;

    this.fps = (this.frames * 1000) / dt;
    this.analysisFps = ((Pose.detections - this.lastDet) * 1000) / dt;
    this.frames = 0;
    this.windowStart = now;
    this.lastDet = Pose.detections;

    this.manageHeat();
    this.show();
  },

  manageHeat() {
    if (Pose.frameSkip === 1) {
      this.lowStreak = this.fps < this.LOW_FPS ? this.lowStreak + 1 : 0;
      if (this.lowStreak >= this.LOW_SECONDS) {
        Pose.frameSkip = 2;
        this.lowStreak = 0;
        this.highStreak = 0;
        console.log("[Perf] FPS düşük (" + this.fps.toFixed(0) + "): analiz her 2. karede");
      }
    } else {
      this.highStreak = this.fps > this.HIGH_FPS ? this.highStreak + 1 : 0;
      if (this.highStreak >= this.HIGH_SECONDS) {
        Pose.frameSkip = 1;
        this.highStreak = 0;
        console.log("[Perf] FPS rahat: analiz yine her karede");
      }
    }
  },

  show() {
    const el = $("fps-badge");
    if (el.hidden) return;
    el.textContent =
      "FPS " + Math.round(this.fps) +
      " · analiz " + Math.round(this.analysisFps) + "/sn" +
      " · " + (Pose.frameSkip === 1 ? "her kare" : "her 2. kare") +
      " · " + (Pose.delegate || "-");
  },
};

/* ============================================================
   ÇİZİM DÖNGÜSÜ: kamera → canvas (+ overlay)
   ============================================================ */
function renderLoop() {
  requestAnimationFrame(renderLoop);

  const { screen, cameraReady, mirror } = App.state;
  if (screen !== "calibration" && screen !== "game") return;
  if (!cameraReady || App.video.readyState < 2) return;

  Perf.tick(performance.now());   // FPS ölç, gerekirse analiz sıklığını düşür

  const v = App.video;
  const w = v.videoWidth;
  const h = v.videoHeight;
  if (!w || !h) return;

  // Canvas çözünürlüğü = video çözünürlüğü (CSS ile ekrana sığdırılır)
  if (App.canvas.width !== w || App.canvas.height !== h) {
    App.canvas.width = w;
    App.canvas.height = h;
  }

  const ctx = App.ctx;
  ctx.save();
  if (mirror) {            // ön kamera: ayna görüntüsü
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(v, 0, 0, w, h);
  ctx.restore();

  // Oyun ekranında yarı saydam koyu overlay (hedefler daha belirgin olsun)
  if (screen === "game") {
    ctx.fillStyle = "rgba(10, 16, 32, 0.25)";
    ctx.fillRect(0, 0, w, h);
  }

  // Diğer modüllerin (pose.js, game.js) çizimleri
  for (const hook of App.frameHooks) hook(ctx, w, h);
}

/* ============================================================
   OLAY BAĞLAMA
   ============================================================ */
function init() {
  App.video = $("video");
  App.canvas = $("stage");
  App.ctx = App.canvas.getContext("2d");

  // Her karede: önce MediaPipe çıkarımı, sonra iskelet çizimi (pose.js)
  App.frameHooks.push(Pose.frameHook);
  // Ardından oyun: hedefleri güncelle, çarpışmaları test et, çiz (game.js)
  App.frameHooks.push(Game.frameHook);
  Game.onEnd = () => showScreen("result");

  // Ayarlar: yükle, uygula, kontrolleri bağla
  loadSettings();
  applySettings();
  document.querySelectorAll("[data-diff]").forEach((b) => {
    b.addEventListener("click", () => {
      App.settings.difficulty = b.dataset.diff;
      saveSettings();
      applySettings();
    });
  });
  $("range-volume").addEventListener("input", (e) => {   // sürüklerken canlı değişir
    App.settings.volume = Number(e.target.value) / 100;
    applySettings();
  });
  $("range-volume").addEventListener("change", () => {   // bırakınca kaydet + deneme sesi
    saveSettings();
    Sound.unlock();
    Sound.hit();
  });
  $("chk-fps").addEventListener("change", (e) => {
    App.settings.showFps = e.target.checked;
    saveSettings();
    applySettings();
  });

  // Uygulamadan çıkıp dönünce ekran kilidi yeniden istenir (tarayıcı otomatik bırakır)
  document.addEventListener("visibilitychange", () => {
    const s = App.state.screen;
    if (document.visibilityState === "visible" && (s === "calibration" || s === "game")) keepAwake(true);
  });

  // data-goto="ekranAdı" olan tüm butonlar
  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => showScreen(btn.dataset.goto));
  });

  // Oyuncu sayısı seçimi → kalibrasyona geç
  document.querySelectorAll("[data-players]").forEach((btn) => {
    btn.addEventListener("click", () => {
      App.state.playerCount = Number(btn.dataset.players);
      showScreen("calibration");   // kamera izni burada (kullanıcı dokunuşuyla) istenir
    });
  });

  $("btn-cam-retry").addEventListener("click", startCamera);
  $("btn-flip").addEventListener("click", flipCamera);
  // Ses, ancak kullanıcı dokunuşundan sonra açılabilir → unlock burada
  $("btn-start").addEventListener("click", () => { Sound.unlock(); showScreen("game"); });
  $("btn-again").addEventListener("click", () => { Sound.unlock(); showScreen("game"); });

  renderLoop();
}

document.addEventListener("DOMContentLoaded", init);
