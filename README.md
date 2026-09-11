# ROBOT AR — Desactiva los núcleos

Juego de realidad aumentada que corre 100% en el navegador del celular. Usa la cámara (frontal o trasera) para detectar tu cuerpo completo, tus manos/dedos y tu rostro con [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) de Google, y reemplaza únicamente los píxeles reconocidos como cuerpo humano por una "piel" metálica animada tipo robot. El fondo y cualquier objeto que no sea una persona quedan intactos.

Sobre esa base se juega un reto simple: van apareciendo **núcleos de energía** (orbes) en pantalla y hay que tocarlos con la punta de los dedos antes de que expiren. Cada acierto suma puntos y sube la dificultad; cada fallo resta una vida.

Todo el procesamiento (cámara + IA + render) ocurre **en el propio celular**, en el navegador. No hay backend ni se sube ningún video/imagen a ningún servidor.

## Cómo probarlo en local

No hace falta instalar nada: es HTML/CSS/JS puro con módulos ES. Solo necesitas servirlo por HTTP (abrir el `index.html` con doble clic **no** funciona por las restricciones de módulos y de cámara).

```bash
cd robot-ar-game
python3 -m http.server 8080
# abre http://localhost:8080 en el navegador
```

La cámara solo funciona en "contextos seguros": `http://localhost` está permitido para pruebas locales, pero en cualquier otro caso necesitas HTTPS (por eso GitHub Pages es ideal: ya sirve todo por HTTPS).

## Cómo publicarlo en GitHub Pages

1. Crea un repositorio nuevo en GitHub (público, para poder usar Pages gratis).
2. Sube el contenido de esta carpeta (`index.html`, `style.css`, `js/`) a la raíz del repositorio:

   ```bash
   cd robot-ar-game
   git init
   git add index.html style.css js README.md
   git commit -m "Robot AR: juego de realidad aumentada con cámara"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/TU-REPOSITORIO.git
   git push -u origin main
   ```

3. En GitHub, entra al repositorio → **Settings** → **Pages**.
4. En "Build and deployment", selecciona **Source: Deploy from a branch**, elige la rama **main** y la carpeta **/(root)**. Guarda.
5. Espera 1–2 minutos. GitHub te dará una URL como `https://TU-USUARIO.github.io/TU-REPOSITORIO/`.
6. Abre esa URL **desde el celular** (Chrome en Android o Safari en iPhone) y acepta el permiso de cámara.

No necesitas ninguna acción adicional: los modelos de IA se descargan automáticamente desde la CDN pública de MediaPipe (`jsdelivr.net` y `storage.googleapis.com`) la primera vez que alguien abre el juego; el navegador los cachea para las siguientes visitas.

## Estructura del proyecto

```
robot-ar-game/
├── index.html          Estructura de la página y todas las pantallas (menú, HUD, error, game over)
├── style.css            Estética "robot/sci-fi", totalmente responsive (funciona en celular)
└── js/
    ├── camera.js         Manejo de getUserMedia: cámara frontal/trasera, errores de permisos
    ├── trackers.js        Carga los 3 modelos de MediaPipe (cuerpo, manos, rostro) y corre la detección
    ├── roboticRenderer.js Dibuja el video + aplica el efecto de piel metálica solo sobre la persona
    ├── game.js            Lógica del juego: orbes, puntaje, niveles, vidas, mejor puntaje
    └── main.js            Conecta todo lo anterior y maneja la interfaz de usuario
```

## Cómo funciona el efecto robótico (por si quieres ajustarlo)

1. **`PoseLandmarker`** (con `outputSegmentationMasks: true`) genera, cuadro a cuadro, una máscara con la probabilidad de que cada píxel pertenezca a una persona.
2. Esa máscara se usa como un "recorte" (`globalCompositeOperation = 'destination-in'`): se pinta una textura metálica animada (definida en `_createMetalTile` y el barrido de brillo en `_drawRoboticSkin`, dentro de `roboticRenderer.js`) y solo se conserva donde la máscara dice "aquí hay una persona". El resto del frame (fondo, objetos) se deja tal cual viene de la cámara.
3. **`HandLandmarker`** y **`FaceLandmarker`** aportan los 21 puntos por mano y los 478 puntos de rostro que se usan para dibujar luces/circuitos en articulaciones, dedos, ojos (con brillo rojo tipo "ojos de robot") y boca.
4. Los mismos puntos de los dedos (o, si no hay manos detectadas, las muñecas del cuerpo completo) son los que el juego usa para saber si "tocaste" un núcleo de energía.

### Ideas para personalizarlo

- **Cambiar el color del metal / las luces**: edita los colores en `_createMetalTile()` y en las funciones `_drawPoseAccents` / `_drawHandAccents` / `_drawFaceAccents` de `js/roboticRenderer.js`.
- **Hacerlo más "exoesqueleto" y menos "piel completa"**: baja la opacidad del relleno metálico en `_drawRoboticSkin` y sube el tamaño/brillo de las luces de articulaciones.
- **Cambiar las reglas del juego**: todo el balance (velocidad de aparición, tiempo de vida de los orbes, puntos, niveles) está en `_difficulty()` dentro de `js/game.js`.
- **Rendimiento en celulares antiguos**: el selector "Rendimiento" del menú controla cuántos modelos corren y cada cuántos frames se actualiza el rostro (ver `QUALITY_PRESETS` en `js/trackers.js`). También puedes bajar la resolución de captura en `QUALITY_TO_CAPTURE` dentro de `js/main.js`.

## Compatibilidad y notas importantes

- **HTTPS obligatorio**: los navegadores solo permiten `getUserMedia` (acceso a cámara) en contextos seguros. GitHub Pages ya sirve todo por HTTPS, así que no tienes que configurar nada extra.
- **Navegadores recomendados**: Chrome/Edge actualizados en Android, Safari en iOS 16+. Necesitan soporte de WebAssembly + WebGL (prácticamente cualquier celular de los últimos ~5 años lo tiene).
- **Cámara trasera con varias personas**: la segmentación funciona mejor con una persona claramente visible. Con la cámara trasera y varias personas en cuadro, el modelo de pose sigue a la persona más prominente; el resto del fondo (incluyendo otras personas parcialmente visibles) puede no quedar cubierto por el efecto.
- **Consumo de batería/datos**: el primer uso descarga ~10-15 MB de modelos de IA (se cachean). El procesamiento de video en tiempo real consume batería como cualquier app de cámara con IA; el selector de "Rendimiento" ayuda a ajustar esto.
- **Privacidad**: ninguna imagen ni video sale del celular del usuario. Todo el cómputo (detección de cuerpo/manos/rostro y el efecto visual) ocurre localmente en el navegador.

## Créditos

Construido con [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision) (Google, licencia Apache 2.0) para la detección de cuerpo, manos y rostro. El resto (render robótico, juego, interfaz) es código propio en HTML/CSS/JavaScript puro, sin frameworks ni dependencias de build.
