// ============================================================
// trackers.js — Carga e inferencia de los modelos MediaPipe:
//   · PoseLandmarker  (cuerpo completo + máscara de segmentación)
//   · HandLandmarker  (manos y dedos, 21 puntos por mano)
//   · FaceLandmarker  (malla facial, 478 puntos)
//
// Todo corre 100% en el navegador (WASM + WebGL). No se envía
// ninguna imagen a ningún servidor.
// ============================================================

const TASKS_VISION_VERSION = '1.0.1';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;

const MODEL_URLS = {
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};

// Índices semánticos de PoseLandmarker (BlazePose de 33 puntos).
export const POSE_JOINTS = {
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
};
export const POSE_LIGHT_POINTS = Object.values(POSE_JOINTS);

// Índices de HandLandmarker (21 puntos por mano).
export const HAND_TIPS = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
export const HAND_TIP_POINTS = Object.values(HAND_TIPS);

/**
 * Calidad de tracking → qué modelos se activan y cada cuántos frames
 * corre el más pesado (rostro).
 */
export const QUALITY_PRESETS = {
  high: { pose: true, hand: true, face: true, faceEveryNFrames: 1 },
  medium: { pose: true, hand: true, face: true, faceEveryNFrames: 3 },
  low: { pose: true, hand: true, face: false, faceEveryNFrames: 0 },
};

export class BodyTrackers {
  constructor() {
    this.vision = null;
    this.poseLandmarker = null;
    this.handLandmarker = null;
    this.faceLandmarker = null;

    this.quality = QUALITY_PRESETS.medium;
    this._frameCount = 0;

    this._lastPoseVideoTime = -1;
    this._lastHandVideoTime = -1;
    this._lastFaceVideoTime = -1;

    // Últimos resultados válidos (se conservan entre frames si un modelo
    // corre a menor frecuencia que el render).
    this.lastPoseResult = null;
    this.lastHandResult = null;
    this.lastFaceResult = null;

    // Constantes de conexión que expone la librería (para dibujar líneas).
    this.POSE_CONNECTIONS = null;
    this.HAND_CONNECTIONS = null;
    this.FACE_LEFT_IRIS = null;
    this.FACE_RIGHT_IRIS = null;
    this.FACE_LIPS = null;
  }

  /**
   * Carga el runtime de MediaPipe y los modelos según el preset de calidad.
   * onProgress(mensaje) permite mostrar texto en la pantalla de carga.
   */
  async init(qualityKey = 'medium', onProgress = () => {}) {
    this.quality = QUALITY_PRESETS[qualityKey] || QUALITY_PRESETS.medium;

    const visionModule = await import(
      /* webpackIgnore: true */
      `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/vision_bundle.mjs`
    );
    const { FilesetResolver, PoseLandmarker, HandLandmarker, FaceLandmarker } = visionModule;

    this.POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS || [];
    this.HAND_CONNECTIONS = HandLandmarker.HAND_CONNECTIONS || [];
    this.FACE_LEFT_IRIS = FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS || [];
    this.FACE_RIGHT_IRIS = FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS || [];
    this.FACE_LIPS = FaceLandmarker.FACE_LANDMARKS_LIPS || [];

    onProgress('Cargando motor de visión (WASM)…');
    this.vision = await FilesetResolver.forVisionTasks(WASM_BASE);

    onProgress('Cargando modelo de cuerpo completo…');
    this.poseLandmarker = await this._createWithFallback(PoseLandmarker, {
      baseOptions: { modelAssetPath: MODEL_URLS.pose, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: true,
    });

    if (this.quality.hand) {
      onProgress('Cargando modelo de manos y dedos…');
      this.handLandmarker = await this._createWithFallback(HandLandmarker, {
        baseOptions: { modelAssetPath: MODEL_URLS.hand, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }

    if (this.quality.face) {
      onProgress('Cargando modelo de rostro…');
      this.faceLandmarker = await this._createWithFallback(FaceLandmarker, {
        baseOptions: { modelAssetPath: MODEL_URLS.face, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    }

    onProgress('Listo.');
  }

  async _createWithFallback(LandmarkerClass, options) {
    try {
      return await LandmarkerClass.createFromOptions(this.vision, options);
    } catch (err) {
      // Algunos dispositivos/navegadores no soportan bien el delegate GPU.
      console.warn('Fallo creando landmarker con delegate GPU, reintentando con CPU:', err);
      const cpuOptions = {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: 'CPU' },
      };
      return await LandmarkerClass.createFromOptions(this.vision, cpuOptions);
    }
  }

  /**
   * Corre la detección para el frame actual del video. Debe llamarse una
   * vez por frame de animación; internamente evita reprocesar el mismo
   * frame de video dos veces y aplica el muestreo de rostro configurado.
   */
  detect(videoElement) {
    const nowMs = performance.now();
    this._frameCount++;

    if (this.poseLandmarker && videoElement.currentTime !== this._lastPoseVideoTime) {
      this._lastPoseVideoTime = videoElement.currentTime;
      const result = this.poseLandmarker.detectForVideo(videoElement, nowMs);
      this._disposeOldMasks(this.lastPoseResult);
      this.lastPoseResult = result;
    }

    if (this.handLandmarker && videoElement.currentTime !== this._lastHandVideoTime) {
      this._lastHandVideoTime = videoElement.currentTime;
      this.lastHandResult = this.handLandmarker.detectForVideo(videoElement, nowMs);
    }

    if (
      this.faceLandmarker &&
      this.quality.faceEveryNFrames > 0 &&
      this._frameCount % this.quality.faceEveryNFrames === 0 &&
      videoElement.currentTime !== this._lastFaceVideoTime
    ) {
      this._lastFaceVideoTime = videoElement.currentTime;
      this.lastFaceResult = this.faceLandmarker.detectForVideo(videoElement, nowMs);
    }

    return {
      pose: this.lastPoseResult,
      hand: this.lastHandResult,
      face: this.lastFaceResult,
    };
  }

  /** Libera la textura/mask anterior antes de reemplazarla (evita fugas de memoria). */
  _disposeOldMasks(previousResult) {
    if (previousResult && previousResult.segmentationMasks) {
      for (const mask of previousResult.segmentationMasks) {
        if (mask && typeof mask.close === 'function') {
          try { mask.close(); } catch (_) { /* noop */ }
        }
      }
    }
  }

  isHandTrackingEnabled() { return !!this.handLandmarker; }
  isFaceTrackingEnabled() { return !!this.faceLandmarker; }

  dispose() {
    this._disposeOldMasks(this.lastPoseResult);
    if (this.poseLandmarker) this.poseLandmarker.close();
    if (this.handLandmarker) this.handLandmarker.close();
    if (this.faceLandmarker) this.faceLandmarker.close();
  }
}
