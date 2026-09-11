// ============================================================
// game.js — Reto de juego: "Desactiva los núcleos de energía"
//
// Aparecen orbes en pantalla; el jugador debe tocarlos con la punta
// de los dedos (o la muñeca, si no hay manos detectadas) antes de que
// expiren. Cada acierto suma puntos y sube la dificultad; cada fallo
// resta una vida. Al perder las 3 vidas, termina la partida.
// ============================================================

const BEST_SCORE_KEY = 'robotArGame_bestScore';
const TAU = Math.PI * 2;

export class Orb {
  constructor(x, y, radius, ttlMs, points, kind = 'normal') {
    this.x = x;
    this.y = y;
    this.radius = radius;
    this.ttlMs = ttlMs;
    this.bornAt = performance.now();
    this.points = points;
    this.kind = kind; // 'normal' | 'bonus'
    this.dead = false;
    this.hit = false;
  }

  ageRatio(nowMs) {
    return Math.min(1, (nowMs - this.bornAt) / this.ttlMs);
  }

  isExpired(nowMs) {
    return nowMs - this.bornAt >= this.ttlMs;
  }
}

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.state = 'menu'; // 'menu' | 'playing' | 'paused' | 'gameover'
    this.score = 0;
    this.level = 1;
    this.lives = 3;
    this.orbs = [];
    this.popups = []; // texto flotante al acertar/fallar

    this._lastSpawnAt = 0;
    this._touchRadiusBase = 46; // radio de "dedo" (a 720px de referencia) para golpear un orbe

    this.onStateChange = null; // callback(state)
    this.onScoreChange = null; // callback(score, level, lives)
  }

  static getBestScore() {
    return Number(localStorage.getItem(BEST_SCORE_KEY) || '0');
  }

  static setBestScore(score) {
    const current = Game.getBestScore();
    if (score > current) localStorage.setItem(BEST_SCORE_KEY, String(score));
  }

  reset() {
    this.score = 0;
    this.level = 1;
    this.lives = 3;
    this.orbs = [];
    this.popups = [];
    this._lastSpawnAt = performance.now();
    this._notifyScore();
  }

  start() {
    this.reset();
    this.state = 'playing';
    this._notifyState();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this._notifyState();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this._lastSpawnAt = performance.now(); // evita ráfaga de spawns tras la pausa
    for (const orb of this.orbs) orb.bornAt += 1; // noop de seguridad
    this._notifyState();
  }

  _gameOver() {
    this.state = 'gameover';
    Game.setBestScore(this.score);
    this._notifyState();
  }

  _notifyState() { if (this.onStateChange) this.onStateChange(this.state); }
  _notifyScore() { if (this.onScoreChange) this.onScoreChange(this.score, this.level, this.lives); }

  /** Factor de escala para que el tamaño de orbes/áreas de toque sea
   * consistente sin importar la resolución real del canvas (que varía
   * según el dispositivo y devicePixelRatio). Referencia: 720px. */
  _scale() {
    return Math.min(this.canvas.width, this.canvas.height) / 720;
  }

  // ---------------------------------------------------------------
  // Dificultad según el nivel actual
  // ---------------------------------------------------------------
  _difficulty() {
    const lvl = this.level;
    const s = this._scale();
    return {
      spawnIntervalMs: Math.max(420, 1100 - lvl * 70),
      ttlMs: Math.max(1100, 2600 - lvl * 130),
      maxOrbs: Math.min(5, 2 + Math.floor(lvl / 2)),
      radius: Math.max(30, 52 - lvl * 1.5) * s,
      bonusChance: Math.min(0.28, 0.08 + lvl * 0.02),
    };
  }

  _maybeSpawn(nowMs) {
    const diff = this._difficulty();
    if (this.orbs.length >= diff.maxOrbs) return;
    if (nowMs - this._lastSpawnAt < diff.spawnIntervalMs) return;

    this._lastSpawnAt = nowMs;
    const margin = diff.radius + 20;
    const w = this.canvas.width;
    const h = this.canvas.height;
    // Evita la franja superior (HUD) e inferior (botones).
    const topSafe = h * 0.16;
    const bottomSafe = h * 0.14;

    const x = margin + Math.random() * (w - margin * 2);
    const y = topSafe + Math.random() * (h - topSafe - bottomSafe - margin);
    const isBonus = Math.random() < diff.bonusChance;

    this.orbs.push(
      new Orb(
        x, y,
        isBonus ? diff.radius * 0.8 : diff.radius,
        diff.ttlMs,
        isBonus ? 50 : 10,
        isBonus ? 'bonus' : 'normal'
      )
    );
  }

  /**
   * @param {number} nowMs
   * @param {Array<{x:number,y:number}>} interactionPoints Puntos activos (dedos/manos) en píxeles de canvas.
   */
  update(nowMs, interactionPoints) {
    if (this.state !== 'playing') return;

    this._maybeSpawn(nowMs);
    const touchRadius = this._touchRadiusBase * this._scale();

    for (const orb of this.orbs) {
      if (orb.dead) continue;

      // ¿Algún punto de interacción toca el orbe?
      for (const pt of interactionPoints) {
        const dx = pt.x - orb.x;
        const dy = pt.y - orb.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= orb.radius + touchRadius) {
          orb.hit = true;
          orb.dead = true;
          this.score += orb.points;
          this._spawnPopup(orb.x, orb.y, `+${orb.points}`, orb.kind === 'bonus' ? '#ffd23f' : '#38f0ff');
          this._maybeLevelUp();
          break;
        }
      }

      if (!orb.dead && orb.isExpired(nowMs)) {
        orb.dead = true;
        this.lives -= 1;
        this._spawnPopup(orb.x, orb.y, '¡PERDIDO!', '#ff5a7a');
        if (this.lives <= 0) {
          this._gameOver();
        }
      }
    }

    this.orbs = this.orbs.filter((o) => !o.dead);

    for (const p of this.popups) {
      p.y -= 0.6;
      p.life -= 1;
    }
    this.popups = this.popups.filter((p) => p.life > 0);

    this._notifyScore();
  }

  _maybeLevelUp() {
    const threshold = this.level * 120;
    if (this.score >= threshold) {
      this.level += 1;
    }
  }

  _spawnPopup(x, y, text, color) {
    this.popups.push({ x, y, text, color, life: 40 });
  }

  // ---------------------------------------------------------------
  // Dibujo de orbes y popups (se llama después del render robótico)
  // ---------------------------------------------------------------
  draw(nowMs) {
    if (this.state !== 'playing' && this.state !== 'paused') return;
    const ctx = this.ctx;
    const s = this._scale();

    for (const orb of this.orbs) {
      const ratio = orb.ageRatio(nowMs);
      const pulse = 1 + 0.08 * Math.sin(nowMs / 120 + orb.x);
      const baseColor = orb.kind === 'bonus' ? '#ffd23f' : '#38f0ff';

      ctx.save();
      ctx.shadowColor = baseColor;
      ctx.shadowBlur = 22 * s;

      // Núcleo del orbe.
      const grad = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, orb.radius * pulse);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.35, baseColor);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(orb.x, orb.y, orb.radius * pulse, 0, TAU);
      ctx.fill();

      // Anillo de cuenta regresiva (se vacía según el tiempo restante).
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 4 * s;
      ctx.beginPath();
      ctx.arc(orb.x, orb.y, orb.radius + 10 * s, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - ratio));
      ctx.stroke();

      ctx.restore();
    }

    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(20 * s)}px system-ui, sans-serif`;
    for (const p of this.popups) {
      ctx.globalAlpha = Math.max(0, p.life / 40);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 10 * s;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.restore();
  }
}
