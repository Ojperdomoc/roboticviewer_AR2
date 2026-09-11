// ============================================================
// main.js — Punto de entrada: conecta cámara, tracking, render
// robótico, juego y la interfaz de usuario.
// ============================================================

import { CameraController } from './camera.js';
import { BodyTrackers, POSE_JOINTS } from './trackers.js';
import { RoboticRenderer } from './roboticRenderer.js';
import { Game } from './game.js';

// ------------------------- DOM refs -------------------------
const videoEl = document.getElementById('camera-video');
const canvasEl = document.getElementById('scene-canvas');

const screens = {
  start: document.getElementById('screen-start'),
  loading: document.getElementById('screen-loading'),
  error: document.getElementById('screen-error'),
  gameover: document.getElementById('screen-gameover'),
  pause: document.getElementById('screen-pause'),
};
const hud = document.getElementById('hud');

const selectFacing = document.getElementById('select-camera-facing');
const selectQuality = document.getElementById('select-quality');
const btnStart = document.getElementById('btn-start');
const bestScoreValue = document.getElementById('best-score-value');
const loadingText = document.getElementById('loading-text');
const errorMessage = document.getElementById('error-message');
const btnRetry = document.getElementById('btn-retry');

const hudScore = document.getElementById('hud-score');
const hudLevel = document.getElementById('hud-level');
const hudLives = document.getElementById('hud-lives');
const btnSwitchCamera = document.getElementById('btn-switch-camera');
const btnPause = document.getElementById('btn-pause');
const dotPose = document.querySelector('.dot-pose');
const dotHand = document.querySelector('.dot-hand');
const dotFace = document.querySelector('.dot-face');

const gameoverScore = document.getElementById('gameover-score');
const gameoverBest = document.getElementById('gameover-best');
const btnRestart = document.getElementById('btn-restart');
const btnMenu = document.getElementById('btn-menu');

const btnResume = document.getElementById('btn-resume');
const btnPauseMenu = document.getElementById('btn-pause-menu');

// ------------------------- Estado global -------------------------
const camera = new CameraController(videoEl);
const trackers = new BodyTrackers();
const renderer = new RoboticRenderer(canvasEl);
const game = new Game(canvasEl);

let rafId = null;
let running = false;

const QUALITY_TO_CAPTURE = {
  high: { width: 1280, height: 960 },
  medium: { width: 960, height: 720 },
  low: { width: 640, height: 480 },
};

// ------------------------- Utilidades de pantallas -------------------------
function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name);
  }
}

function hideAllScreens() {
  for (const key of Object.keys(screens)) screens[key].classList.add('hidden');
}

function updateBestScoreLabels() {
  const best = Game.getBestScore();
  bestScoreValue.textContent = best;
  gameoverBest.textContent = `Mejor puntaje: ${best}`;
}

// ------------------------- Canvas responsive -------------------------
function resizeCanvasToWindow() {
  renderer.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resizeCanvasToWindow);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvasToWindow, 200));
resizeCanvasToWindow();

// ------------------------- Flujo de arranque -------------------------
async function handleStart() {
  hideAllScreens();
  showScreen('loading');
  loadingText.textContent = 'Solicitando acceso a la cámara…';

  const facing = selectFacing.value;
  const qualityKey = selectQuality.value;
  const capture = QUALITY_TO_CAPTURE[qualityKey] || QUALITY_TO_CAPTURE.medium;

  try {
    await camera.start(facing, capture);
  } catch (err) {
    showError(err.message);
    return;
  }

  try {
    if (!trackers.poseLandmarker) {
      await trackers.init(qualityKey, (msg) => { loadingText.textContent = msg; });
      renderer.setConnections({
        pose: trackers.POSE_CONNECTIONS,
        hand: trackers.HAND_CONNECTIONS,
        faceLeftIris: trackers.FACE_LEFT_IRIS,
        faceRightIris: trackers.FACE_RIGHT_IRIS,
        faceLips: trackers.FACE_LIPS,
      });
    }
  } catch (err) {
    console.error(err);
    showError('No se pudieron cargar los modelos de IA de MediaPipe. Revisa tu conexión a internet e inténtalo de nuevo.');
    return;
  }

  hideAllScreens();
  hud.classList.remove('hidden');
  game.start();
  startRenderLoop();
}

function showError(message) {
  hideAllScreens();
  errorMessage.textContent = message;
  showScreen('error');
}

// ------------------------- Loop de render + juego -------------------------
function startRenderLoop() {
  if (running) return;
  running = true;

  const loop = (timeMs) => {
    if (!running) return;

    if (videoEl.readyState >= 2) {
      const results = trackers.detect(videoEl);
      renderer.renderFrame(videoEl, results, camera.isMirrored, timeMs);

      updateTrackingDots(results);

      const interactionPoints = collectInteractionPoints(results);
      game.update(timeMs, interactionPoints);
      game.draw(timeMs);
    }

    rafId = requestAnimationFrame(loop);
  };

  rafId = requestAnimationFrame(loop);
}

function stopRenderLoop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function updateTrackingDots(results) {
  dotPose.classList.toggle('active', !!(results.pose && results.pose.landmarks && results.pose.landmarks.length));
  dotHand.classList.toggle('active', !!(results.hand && results.hand.landmarks && results.hand.landmarks.length));
  dotFace.classList.toggle('active', !!(results.face && results.face.faceLandmarks && results.face.faceLandmarks.length));
}

/** Junta los puntos "activos" para el juego: puntas de dedos y, si no hay
 * manos detectadas, las muñecas del cuerpo completo como respaldo. */
function collectInteractionPoints(results) {
  const points = [];

  if (results.hand && results.hand.landmarks && results.hand.landmarks.length) {
    for (const hand of results.hand.landmarks) {
      for (const idx of [4, 8, 12, 16, 20]) {
        const p = hand[idx];
        if (p) points.push(renderer.mapNormalizedPoint(p.x, p.y));
      }
    }
  } else if (results.pose && results.pose.landmarks && results.pose.landmarks[0]) {
    const lm = results.pose.landmarks[0];
    for (const idx of [POSE_JOINTS.leftWrist, POSE_JOINTS.rightWrist]) {
      const p = lm[idx];
      if (p && (p.visibility === undefined || p.visibility > 0.4)) {
        points.push(renderer.mapNormalizedPoint(p.x, p.y));
      }
    }
  }

  return points;
}

// ------------------------- Eventos de UI -------------------------
btnStart.addEventListener('click', handleStart);
btnRetry.addEventListener('click', handleStart);

btnSwitchCamera.addEventListener('click', async () => {
  try {
    await camera.switchCamera();
  } catch (err) {
    showError(err.message);
    stopRenderLoop();
  }
});

btnPause.addEventListener('click', () => {
  game.pause();
  showScreen('pause');
});

btnResume.addEventListener('click', () => {
  hideAllScreens();
  game.resume();
});

btnPauseMenu.addEventListener('click', () => {
  goToMenu();
});

btnRestart.addEventListener('click', () => {
  hideAllScreens();
  hud.classList.remove('hidden');
  game.start();
});

btnMenu.addEventListener('click', () => {
  goToMenu();
});

function goToMenu() {
  hud.classList.add('hidden');
  game.state = 'menu';
  updateBestScoreLabels();
  showScreen('start');
}

game.onScoreChange = (score, level, lives) => {
  hudScore.textContent = score;
  hudLevel.textContent = level;
  hudLives.textContent = '❤'.repeat(Math.max(0, lives)) + '♡'.repeat(Math.max(0, 3 - lives));
};

game.onStateChange = (state) => {
  if (state === 'gameover') {
    gameoverScore.textContent = game.score;
    updateBestScoreLabels();
    hud.classList.add('hidden');
    showScreen('gameover');
  }
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.state === 'playing') {
    game.pause();
    showScreen('pause');
  }
});

// ------------------------- Inicial -------------------------
updateBestScoreLabels();
showScreen('start');
