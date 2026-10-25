"use strict";
/* ============================================================
   pose.js — MediaPipe Pose Landmarker: yükleme, çıkarım, iskelet
   ADIM 2: model yükleme, çıkarım, iskelet çizimi, bilek koordinatları
   ADIM 4: oyuncu izleme — poses[i] artık i. OYUNCUNUN iskeleti (yoksa null);
           kareler arasında kimlik karışmasın diye en yakın eşleştirme yapılır
   ============================================================ */

/* ---------- CDN adresleri (net olarak) ----------
   1) JS paketi  : jsDelivr üzerinden @mediapipe/tasks-vision
   2) WASM klasörü: aynı paketin /wasm klasörü
   3) Model       : Google'ın resmi depolaması (pose_landmarker_lite)
   Sürüm sabitlendi; yeni sürüm denemek istersen sadece MP_VERSION'u değiştir. */
const MP_VERSION   = "0.10.14";
const MP_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_WASM_URL   = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MP_MODEL_URL  = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

/* ---------- Landmark numaraları (33 nokta) ---------- */
const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_WRIST: 15,    RIGHT_WRIST: 16,
};

// İskelet çizgileri (gövde, kollar, bacaklar, eller, ayaklar)
const POSE_CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],      // omuzlar + kollar
  [11, 23], [12, 24], [23, 24],                          // gövde
  [23, 25], [25, 27], [24, 26], [26, 28],                // bacaklar
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32], // ayaklar
  [15, 17], [15, 19], [15, 21], [17, 19],                // sol el
  [16, 18], [16, 20], [16, 22], [18, 20],                // sağ el
];

const MIN_VISIBILITY = 0.5;   // bundan düşük görünürlükteki noktalar çizilmez

function poseName(i) {
  return (typeof PLAYER_COLORS !== "undefined" && PLAYER_COLORS[i])
    ? PLAYER_COLORS[i].name : "Oyuncu " + (i + 1);
}

function poseColor(i) {
  // main.js'deki PLAYER_COLORS (Kırmızı/Mavi/Yeşil); yoksa beyaz
  return (typeof PLAYER_COLORS !== "undefined" && PLAYER_COLORS[i])
    ? PLAYER_COLORS[i].hex : "#ffffff";
}

const Pose = {
  landmarker: null,
  ready: false,
  delegate: "",
  initPromise: null,
  numPoses: 1,

  frameSkip: 1,          // 1 = her kamera karesinde analiz, 2 = her 2. karede (Perf otomatik ayarlar)
  _frame: 0,
  detections: 0,         // başarılı analiz sayısı (main.js'deki Perf okur)
  _lastVideoTime: -1,

  poses: [],             // poses[oyuncu] = 33 noktalı iskelet {x,y,z,visibility} (0-1 aralığı)
                         // ya da null (o oyuncu şu an görünmüyor). Sıra: 0=Kırmızı, 1=Mavi, 2=Yeşil
  _slots: [],            // oyuncu başına izleme kaydı: { centroid: {x,y} | null }

  _lastLog: 0,
  _lastInfo: 0,

  /* ---------- Model yükleme (bir kere; tekrar çağrılırsa aynı sözü döner) ---------- */
  init(numPoses) {
    this.numPoses = numPoses || 1;
    this._ensureSlots();
    if (this.ready) {
      this.landmarker.setOptions({ numPoses: this.numPoses });
      return Promise.resolve(true);
    }
    if (!this.initPromise) {
      this.initPromise = this._load().catch((err) => {
        console.error("[Pose] Model yüklenemedi:", err);
        this.initPromise = null;    // sonraki denemede yeniden yüklensin
        this._setInfo("Model yüklenemedi (internet var mı?).\nSayfayı yenileyip tekrar dene.\n" + (err && err.message ? err.message : ""));
        return false;
      });
    }
    return this.initPromise;
  },

  async _load() {
    this._setInfo("Model yükleniyor… (ilk seferde birkaç MB iner)");

    // Klasik script'ten ES modülünü dinamik import ile alıyoruz
    const { FilesetResolver, PoseLandmarker } = await import(MP_BUNDLE_URL);
    const vision = await FilesetResolver.forVisionTasks(MP_WASM_URL);

    const make = (delegate) =>
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MP_MODEL_URL, delegate },
        runningMode: "VIDEO",
        numPoses: this.numPoses,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

    try {
      this.landmarker = await make("GPU");
      this.delegate = "GPU";
    } catch (e) {
      console.warn("[Pose] GPU olmadı, CPU'ya düşülüyor:", e);
      this.landmarker = await make("CPU");
      this.delegate = "CPU";
    }

    // Yükleme sürerken oyuncu sayısı değişmiş olabilir
    this.landmarker.setOptions({ numPoses: this.numPoses });
    this.ready = true;
    this._setInfo("Model hazır (" + this.delegate + ")");
    return true;
  },

  /* ---------- Çıkarım: her çizim karesinde çağrılır ---------- */
  detect(video) {
    if (!this.ready) return;
    if (video.readyState < 2) return;
    if (video.currentTime === this._lastVideoTime) return;     // aynı kareyi iki kez işleme
    this._lastVideoTime = video.currentTime;
    // Isınma yönetimi: frameSkip=2 → her 2. YENİ kamera karesinde analiz (kamera ~30 kare/sn)
    if (++this._frame % this.frameSkip !== 0) return;

    try {
      const result = this.landmarker.detectForVideo(video, performance.now());
      this._assign(result.landmarks || []);   // iskeletleri oyunculara dağıt
      this.detections++;                      // FPS göstergesi "analiz/sn" için
    } catch (err) {
      console.error("[Pose] Algılama hatası:", err);
      this._setInfo("Algılama hatası: " + (err && err.message ? err.message : err));
      return;
    }
    this._report();
  },

  clear() {
    this.poses = [];
    this._slots = [];          // izleme sıfırlanır: sıradaki görüşte yine soldan sağa atanır
    this._lastVideoTime = -1;
  },

  /* ---------- Oyuncu izleme (Adım 4) ----------
     MediaPipe kareler arasında kişi kimliği vermez: bir karede result[0] A kişisi,
     sonrakinde B kişisi olabilir. Çözüm: her oyuncunun son "merkez" noktasını
     (omuz + kalça ortalaması) saklar, yeni karedeki iskeletleri en yakın merkeze eşleriz.
     İlk kez görülen iskeletler soldan sağa sıralanır → Kırmızı, Mavi, Yeşil. */
  _ensureSlots() {
    while (this._slots.length < this.numPoses) this._slots.push({ centroid: null });
    this._slots.length = this.numPoses;
  },

  _centroid(lms) {
    let sx = 0, sy = 0, n = 0;
    for (const k of [11, 12, 23, 24]) {
      const p = lms[k];
      if (p.visibility === undefined || p.visibility >= 0.3) { sx += p.x; sy += p.y; n++; }
    }
    if (!n) for (const p of lms) { sx += p.x; sy += p.y; n++; }   // gövde görünmüyorsa tüm noktalar
    return { x: sx / n, y: sy / n };
  },

  _assign(found) {
    this._ensureSlots();
    const slots = this._slots;
    const mirror = typeof App !== "undefined" && App.state.mirror;
    const items = found.slice(0, slots.length).map((lms) => ({ lms, c: this._centroid(lms) }));
    const bySlot = new Array(slots.length).fill(null);   // yuva → eşleşen iskelet
    const used = new Set();

    // 1) Daha önce görülmüş yuvalara en yakın iskelet (açgözlü; 3 kişide yeterli)
    const pairs = [];
    items.forEach((it, i) => slots.forEach((s, j) => {
      if (s.centroid) pairs.push({ i, j, d: Math.hypot(it.c.x - s.centroid.x, it.c.y - s.centroid.y) });
    }));
    pairs.sort((a, b) => a.d - b.d);
    for (const p of pairs) {
      if (used.has(p.i) || bySlot[p.j]) continue;
      bySlot[p.j] = items[p.i];
      used.add(p.i);
    }

    // 2) Kalan (yeni) iskeletler → hiç görülmemiş yuvalar, ekranda soldan sağa
    const sx = (it) => (mirror ? 1 - it.c.x : it.c.x);
    const fresh = items.filter((_, i) => !used.has(i)).sort((a, b) => sx(a) - sx(b));
    const empty = [];
    slots.forEach((s, j) => { if (!bySlot[j] && !s.centroid) empty.push(j); });
    fresh.forEach((it, k) => { if (k < empty.length) bySlot[empty[k]] = it; });

    // 3) Sonucu yaz; görünmeyen oyuncunun son merkezi korunur (geri dönünce yerini bulsun)
    this.poses = bySlot.map((it) => (it ? it.lms : null));
    bySlot.forEach((it, j) => { if (it) slots[j].centroid = it.c; });
  },

  /* ---------- Bilek koordinatları (canvas pikseli) ----------
     Adım 3'te game.js çarpışma testi için bunu kullanacak.
     Dönüş: [{ left:{x,y,visible}, right:{x,y,visible} }, ...]  (kişi başına bir kayıt) */
  getWrists(w, h, mirror) {
    const conv = (p) => ({
      x: (mirror ? 1 - p.x : p.x) * w,
      y: p.y * h,
      visible: p.visibility === undefined || p.visibility >= MIN_VISIBILITY,
    });
    // Oyuncu görünmüyorsa o indekste null döner
    return this.poses.map((lms) => lms ? ({
      left: conv(lms[LM.LEFT_WRIST]),
      right: conv(lms[LM.RIGHT_WRIST]),
    }) : null);
  },

  /* ---------- İskelet çizimi: her kişi kendi renginde ---------- */
  draw(ctx, w, h, mirror) {
    if (!this.poses.some(Boolean)) return;
    const lw = Math.max(3, w / 220);

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    this.poses.forEach((lms, i) => {
      if (!lms) return;               // bu oyuncu şu an görünmüyor
      const color = poseColor(i);

      // normalize (0-1) → canvas pikseli; ön kamerada x ters çevrilir
      const pt = (k) => {
        const p = lms[k];
        return {
          x: (mirror ? 1 - p.x : p.x) * w,
          y: p.y * h,
          ok: p.visibility === undefined || p.visibility >= MIN_VISIBILITY,
        };
      };

      // Çizgiler
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      for (const [a, b] of POSE_CONNECTIONS) {
        const pa = pt(a), pb = pt(b);
        if (!pa.ok || !pb.ok) continue;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }

      // Eklem noktaları (burun + omuzdan ayağa)
      ctx.fillStyle = color;
      const joints = [LM.NOSE];
      for (let k = 11; k <= 32; k++) joints.push(k);
      for (const k of joints) {
        const p = pt(k);
        if (!p.ok) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, lw * 0.9, 0, Math.PI * 2);
        ctx.fill();
      }

      // Bilekler: oyunda "vuruş" noktası olacak, o yüzden büyük + beyaz halka
      for (const k of [LM.LEFT_WRIST, LM.RIGHT_WRIST]) {
        const p = pt(k);
        if (!p.ok) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, lw * 2.4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = lw * 0.6;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      }

      // Çok oyunculuda kafanın üstüne renk adı: kim hangi renk, görünsün
      if (this.numPoses > 1) {
        const nose = pt(LM.NOSE);
        if (nose.ok) {
          const fs = Math.round(lw * 5);
          ctx.font = `bold ${fs}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          const ty = Math.max(fs * 1.2, nose.y - lw * 8);
          ctx.lineWidth = lw * 1.2;
          ctx.strokeStyle = "rgba(0,0,0,0.7)";
          ctx.strokeText(poseName(i), nose.x, ty);
          ctx.fillStyle = color;
          ctx.fillText(poseName(i), nose.x, ty);
        }
      }
    });

    ctx.restore();
  },

  /* ---------- Konsol logu + ekrandaki bilgi yazısı (saniyede ~2 kez) ---------- */
  _report() {
    const now = performance.now();
    if (now - this._lastLog < 500) return;
    this._lastLog = now;

    const head = "Model hazır (" + this.delegate + ")";
    const present = this.poses.filter(Boolean).length;
    if (!present) {
      this._setInfo(head + "\nKimse algılanmadı — tam görünecek şekilde geri çekil");
      return;
    }

    const f = (p) => p.x.toFixed(2) + ", " + p.y.toFixed(2);
    const lines = [head + " · " + present + "/" + this.numPoses + " kişi"];

    this.poses.forEach((lms, i) => {
      const name = poseName(i);
      if (!lms) {
        lines.push(name + ": görünmüyor");
        return;
      }
      const L = lms[LM.LEFT_WRIST], R = lms[LM.RIGHT_WRIST];
      console.log(`[Pose] ${name} | sol bilek: ${f(L)} | sağ bilek: ${f(R)}`);
      lines.push(`${name} sol: ${f(L)}  sağ: ${f(R)}`);
    });

    if (this.numPoses > 1) lines.push("Renkler ilk görülme sırasıyla (soldan sağa) verilir");
    this._setInfo(lines.join("\n"));
  },

  _setInfo(text) {
    const el = document.getElementById("pose-info");
    if (el) el.textContent = text;
  },
};

// main.js bunu App.frameHooks'a ekler: önce çıkarım, sonra çizim
Pose.frameHook = function (ctx, w, h) {
  Pose.detect(App.video);
  Pose.draw(ctx, w, h, App.state.mirror);
};
