// ============================================================
// camera.js — Manejo de getUserMedia: cámara frontal / trasera
// ============================================================

/**
 * Controlador simple de cámara. Guarda el stream activo, permite
 * cambiar entre frontal ("user") y trasera ("environment"), y expone
 * si el video actual debe dibujarse en espejo (solo la frontal).
 */
export class CameraController {
  constructor(videoElement) {
    this.video = videoElement;
    this.stream = null;
    this.facingMode = 'user'; // 'user' = frontal, 'environment' = trasera
    this.captureSize = { width: 960, height: 720 };
  }

  get isMirrored() {
    return this.facingMode === 'user';
  }

  /**
   * Pide permiso y arranca la cámara con el facingMode indicado.
   * Lanza un Error con un mensaje entendible si algo falla.
   */
  async start(facingMode = 'user', captureSize = null) {
    this.facingMode = facingMode;
    if (captureSize) this.captureSize = captureSize;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(
        'Este navegador no soporta acceso a la cámara (getUserMedia). Prueba con Chrome o Safari actualizados.'
      );
    }

    if (!window.isSecureContext) {
      throw new Error(
        'La página no se está sirviendo por HTTPS. La cámara solo funciona en contextos seguros (https:// o localhost).'
      );
    }

    this.stop();

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: this.captureSize.width },
        height: { ideal: this.captureSize.height },
      },
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      throw new Error(this._translateError(err));
    }

    this.stream = stream;
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', 'true');

    await new Promise((resolve, reject) => {
      const onReady = () => {
        this.video.removeEventListener('loadedmetadata', onReady);
        resolve();
      };
      this.video.addEventListener('loadedmetadata', onReady);
      // Salvavidas por si el evento ya pasó.
      setTimeout(() => {
        if (this.video.readyState >= 1) resolve();
      }, 1500);
      this.video.play().catch(reject);
    });

    return this.stream;
  }

  /** Cambia entre cámara frontal y trasera, reiniciando el stream. */
  async switchCamera() {
    const next = this.facingMode === 'user' ? 'environment' : 'user';
    return this.start(next);
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
  }

  _translateError(err) {
    const name = err && err.name;
    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Permiso de cámara denegado. Actívalo en la configuración del navegador para este sitio.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No se encontró ninguna cámara disponible en este dispositivo.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'La cámara está siendo usada por otra aplicación. Ciérrala e inténtalo de nuevo.';
      case 'OverconstrainedError':
        return 'No se pudo configurar la cámara solicitada (frontal/trasera) en este dispositivo.';
      default:
        return `No se pudo acceder a la cámara (${name || 'error desconocido'}).`;
    }
  }
}
