// ============================================================
// roboticRenderer.js — Dibuja el video de cámara y transforma
// ÚNICAMENTE los píxeles reconocidos como cuerpo humano (según la
// máscara de segmentación de PoseLandmarker) en una "piel" metálica
// animada, y añade luces/circuitos en articulaciones, dedos, ojos y
// boca a partir de los landmarks de pose, manos y rostro.
//
// El fondo y cualquier objeto que no sea una persona quedan intactos.
// ============================================================

const TAU = Math.PI * 2;

export class RoboticRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });

    // Canvas auxiliares (offscreen) reutilizados cada frame para evitar
    // asignar memoria nueva constantemente.
    this._maskCanvas = document.createElement('canvas');
    this._maskCtx = this._maskCanvas.getContext('2d');
    this._personLayer = document.createElement('canvas');
    this._personLayerCtx = this._personLayer.getContext('2d');

    this._metalTile = this._createMetalTile(128);

    // Parámetros de "cover fit" del último frame (para mapear puntos).
    this.drawParams = null;
    this.isMirrored = true;

    // Trackers de conexión (se inyectan desde trackers.js una vez cargada
    // la librería, porque los índices vienen de las clases MediaPipe).
    this.connections = {
      pose: [],
      hand: [],
      faceLeftIris: [],
      faceRightIris: [],
      faceLips: [],
    };

    this.showJointLights = true;
  }

  setConnections(connections) {
    this.connections = { ...this.connections, ...connections };
  }

  resize(width, height) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this._personLayer.width = this.canvas.width;
    this._personLayer.height = this.canvas.height;
  }

  /** Calcula el rectángulo "cover" (como object-fit: cover) del video dentro del canvas. */
  _computeCoverRect(sourceW, sourceH) {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const scale = Math.max(cw / sourceW, ch / sourceH);
    const destW = sourceW * scale;
    const destH = sourceH * scale;
    const destX = (cw - destW) / 2;
    const destY = (ch - destH) / 2;
    return { destX, destY, destW, destH };
  }

  /**
   * Dibuja `source` (video o canvas) dentro del canvas principal (o de
   * destino indicado) aplicando cover-fit + espejo, usando el rect ya
   * calculado en this.drawParams.
   */
  _drawAligned(ctx, source, sourceW, sourceH) {
    const { destX, destY, destW, destH } = this.drawParams;
    ctx.save();
    if (this.isMirrored) {
      ctx.translate(ctx.canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, 0, 0, sourceW, sourceH, destX, destY, destW, destH);
    ctx.restore();
  }

  /**
   * Convierte un punto normalizado (0..1, relativo al frame crudo de la
   * cámara) a coordenadas de píxel del canvas visible, respetando el
   * cover-fit y el espejo actuales. Lo usan tanto el propio renderer
   * como game.js para detectar colisiones con los orbes.
   */
  mapNormalizedPoint(nx, ny) {
    if (!this.drawParams) return { x: 0, y: 0 };
    const { destX, destY, destW, destH } = this.drawParams;
    const px = destX + nx * destW;
    const py = destY + ny * destH;
    const x = this.isMirrored ? this.canvas.width - px : px;
    return { x, y: py };
  }

  /** Punto medio de una lista de índices de landmarks (para iris, etc). */
  static averagePoint(landmarks, indices) {
    let sx = 0, sy = 0, n = 0;
    for (const i of indices) {
      const p = landmarks[i];
      if (!p) continue;
      sx += p.x; sy += p.y; n++;
    }
    if (n === 0) return null;
    return { x: sx / n, y: sy / n };
  }

  /** Extrae los índices únicos de una lista de conexiones {start,end}. */
  static uniqueIndices(connections) {
    const set = new Set();
    for (const c of connections) { set.add(c.start); set.add(c.end); }
    return [...set];
  }

  // ---------------------------------------------------------------
  // Render principal
  // ---------------------------------------------------------------
  renderFrame(video, trackerResults, isMirrored, timeMs) {
    const ctx = this.ctx;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;

    this.isMirrored = isMirrored;
    this.drawParams = this._computeCoverRect(vw, vh);

    // 1) Fondo: el frame de cámara tal cual (incluye personas y entorno).
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this._drawAligned(ctx, video, vw, vh);

    const poseResult = trackerResults.pose;
    const handResult = trackerResults.hand;
    const faceResult = trackerResults.face;

    // 2) Piel metálica SOLO donde la máscara de segmentación dice "persona".
    let hasMask = false;
    if (poseResult && poseResult.segmentationMasks && poseResult.segmentationMasks[0]) {
      hasMask = this._drawRoboticSkin(poseResult.segmentationMasks[0], vw, vh, timeMs);
    }

    // 3) Acentos de circuitos/luces sobre articulaciones, dedos y rostro.
    if (this.showJointLights) {
      if (poseResult && poseResult.landmarks && poseResult.landmarks[0]) {
        this._drawPoseAccents(poseResult.landmarks[0], timeMs);
      }
      if (handResult && handResult.landmarks) {
        for (const hand of handResult.landmarks) {
          this._drawHandAccents(hand, timeMs);
        }
      }
      if (faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks[0]) {
        this._drawFaceAccents(faceResult.faceLandmarks[0], timeMs);
      }
    }

    return { hasMask };
  }

  // ---------------------------------------------------------------
  // Piel robótica (segmentación → material metálico animado)
  // ---------------------------------------------------------------
  _drawRoboticSkin(mask, vw, vh, timeMs) {
    const mw = mask.width;
    const mh = mask.height;
    if (!mw || !mh) return false;

    let floatData;
    try {
      floatData = mask.getAsFloat32Array();
    } catch (err) {
      return false;
    }

    // Construye un canvas alfa: blanco puro con alpha = confianza de persona.
    if (this._maskCanvas.width !== mw || this._maskCanvas.height !== mh) {
      this._maskCanvas.width = mw;
      this._maskCanvas.height = mh;
    }
    const imageData = this._maskCtx.createImageData(mw, mh);
    const data = imageData.data;
    for (let i = 0; i < floatData.length; i++) {
      const a = floatData[i] > 0.35 ? Math.min(1, floatData[i] * 1.15) : floatData[i] * 0.4;
      const o = i * 4;
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255;
      data[o + 3] = a * 255;
    }
    this._maskCtx.putImageData(imageData, 0, 0);

    if (typeof mask.close === 'function') {
      try { mask.close(); } catch (_) { /* noop */ }
    }

    // Capa de "persona": patrón metálico + brillo animado, recortado por la máscara.
    const layer = this._personLayer;
    const lctx = this._personLayerCtx;
    lctx.clearRect(0, 0, layer.width, layer.height);

    // Relleno base con el tile metálico repetido.
    const pattern = lctx.createPattern(this._metalTile, 'repeat');
    lctx.fillStyle = pattern;
    lctx.fillRect(0, 0, layer.width, layer.height);

    // Tinte de color cian/azulado para look "robot".
    lctx.globalCompositeOperation = 'source-atop';
    const tint = lctx.createLinearGradient(0, 0, layer.width, layer.height);
    tint.addColorStop(0, 'rgba(40,120,160,0.55)');
    tint.addColorStop(0.5, 'rgba(20,60,90,0.35)');
    tint.addColorStop(1, 'rgba(60,150,190,0.55)');
    lctx.fillStyle = tint;
    lctx.fillRect(0, 0, layer.width, layer.height);

    // Barrido de brillo animado (efecto "escáner").
    const sweepT = (timeMs / 900) % 2; // 0..2
    const sweepPos = (sweepT <= 1 ? sweepT : 2 - sweepT); // rebote 0..1..0
    const bandY = sweepPos * layer.height * 1.4 - layer.height * 0.2;
    const bandGrad = lctx.createLinearGradient(0, bandY - 90, 0, bandY + 90);
    bandGrad.addColorStop(0, 'rgba(150,240,255,0)');
    bandGrad.addColorStop(0.5, 'rgba(150,240,255,0.55)');
    bandGrad.addColorStop(1, 'rgba(150,240,255,0)');
    lctx.globalCompositeOperation = 'lighter';
    lctx.fillStyle = bandGrad;
    lctx.fillRect(0, 0, layer.width, layer.height);
    lctx.globalCompositeOperation = 'source-over';

    // Recorta todo lo anterior con la forma de la persona (máscara).
    lctx.globalCompositeOperation = 'destination-in';
    this._drawAligned(lctx, this._maskCanvas, mw, mh);
    lctx.globalCompositeOperation = 'source-over';

    // Compone la capa "persona" ya recortada sobre el canvas principal.
    this.ctx.drawImage(layer, 0, 0);

    return true;
  }

  _createMetalTile(size) {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, '#7fa7b8');
    grad.addColorStop(0.3, '#c9e7f2');
    grad.addColorStop(0.55, '#8fb6c6');
    grad.addColorStop(0.8, '#5f818f');
    grad.addColorStop(1, '#a9d2e0');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Rayas de cepillado diagonal.
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = '#0a1a22';
    for (let i = -size; i < size * 2; i += 6) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + size, size);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Líneas tipo "circuito" (patrón fijo pseudo-aleatorio).
    ctx.strokeStyle = 'rgba(20,50,60,0.35)';
    ctx.lineWidth = 1.5;
    let seed = 7;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let i = 0; i < 6; i++) {
      const x = rand() * size, y = rand() * size;
      const w = 10 + rand() * 24, h = 10 + rand() * 24;
      ctx.strokeRect(x, y, w, h);
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, TAU);
      ctx.fillStyle = 'rgba(20,50,60,0.4)';
      ctx.fill();
    }

    return c;
  }

  // ---------------------------------------------------------------
  // Acentos: luces en articulaciones / dedos / rostro
  // ---------------------------------------------------------------
  _glowDot(x, y, radius, color) {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = radius * 2.2;
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.35, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** Factor de escala relativo a una referencia de 720px, para que los
   * grosores/radios se vean consistentes sin importar la resolución real
   * del canvas (que varía con el dispositivo y devicePixelRatio). */
  _uiScale() {
    return Math.min(this.canvas.width, this.canvas.height) / 720;
  }

  _glowLine(x1, y1, x2, y2, color, width) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.shadowColor = color;
    ctx.shadowBlur = width * 3;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  _drawPoseAccents(landmarks, timeMs) {
    const s = this._uiScale();
    const pulse = 0.75 + 0.25 * Math.sin(timeMs / 260);
    const jointIdx = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

    // Líneas de esqueleto muy sutiles (refuerzan la sensación de robot).
    for (const conn of this.connections.pose) {
      const a = landmarks[conn.start];
      const b = landmarks[conn.end];
      if (!a || !b) continue;
      if ((a.visibility !== undefined && a.visibility < 0.3) ||
          (b.visibility !== undefined && b.visibility < 0.3)) continue;
      const pa = this.mapNormalizedPoint(a.x, a.y);
      const pb = this.mapNormalizedPoint(b.x, b.y);
      this._glowLine(pa.x, pa.y, pb.x, pb.y, 'rgba(56,240,255,0.25)', 2 * s);
    }

    for (const idx of jointIdx) {
      const p = landmarks[idx];
      if (!p || (p.visibility !== undefined && p.visibility < 0.4)) continue;
      const { x, y } = this.mapNormalizedPoint(p.x, p.y);
      this._glowDot(x, y, 7 * pulse * s, '#38f0ff');
    }
  }

  _drawHandAccents(landmarks, timeMs) {
    const s = this._uiScale();
    const pulse = 0.75 + 0.25 * Math.sin(timeMs / 200 + 1);
    for (const conn of this.connections.hand) {
      const a = landmarks[conn.start];
      const b = landmarks[conn.end];
      if (!a || !b) continue;
      const pa = this.mapNormalizedPoint(a.x, a.y);
      const pb = this.mapNormalizedPoint(b.x, b.y);
      this._glowLine(pa.x, pa.y, pb.x, pb.y, 'rgba(56,255,158,0.5)', 2.5 * s);
    }
    const tipIndices = [4, 8, 12, 16, 20];
    for (const idx of tipIndices) {
      const p = landmarks[idx];
      if (!p) continue;
      const { x, y } = this.mapNormalizedPoint(p.x, p.y);
      this._glowDot(x, y, 8 * pulse * s, '#38ff9e');
    }
  }

  _drawFaceAccents(landmarks, timeMs) {
    const s = this._uiScale();
    const pulse = 0.8 + 0.2 * Math.sin(timeMs / 300);

    const leftIris = RoboticRenderer.uniqueIndices(this.connections.faceLeftIris);
    const rightIris = RoboticRenderer.uniqueIndices(this.connections.faceRightIris);
    const leftEye = RoboticRenderer.averagePoint(landmarks, leftIris.length ? leftIris : [468]);
    const rightEye = RoboticRenderer.averagePoint(landmarks, rightIris.length ? rightIris : [473]);

    for (const eye of [leftEye, rightEye]) {
      if (!eye) continue;
      const { x, y } = this.mapNormalizedPoint(eye.x, eye.y);
      this._glowDot(x, y, 10 * pulse * s, '#ff5a5a');
    }

    // "Rejilla" luminosa de la boca.
    const lips = this.connections.faceLips;
    for (const conn of lips) {
      const a = landmarks[conn.start];
      const b = landmarks[conn.end];
      if (!a || !b) continue;
      const pa = this.mapNormalizedPoint(a.x, a.y);
      const pb = this.mapNormalizedPoint(b.x, b.y);
      this._glowLine(pa.x, pa.y, pb.x, pb.y, 'rgba(255,158,56,0.55)', 1.5 * s);
    }
  }
}
