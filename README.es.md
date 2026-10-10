# SoundRadar

**[▶ Abrir la app en vivo](https://atarantini.github.io/soundradar/)** — se
ejecuta en tu navegador, no hay nada que instalar.

Un analizador de espectro de audio en tiempo real con waterfall que funciona
completamente en tu navegador. Apuntá un micrófono a una habitación, un
motor, un parlante o una pared, y leé lo que realmente hay en el aire — sin
instalación, sin cuenta, sin subir nada.

HTML, CSS y módulos ES puros. Sin paso de build, sin bundler, sin
dependencias. El audio se analiza en la pestaña y nunca sale del dispositivo.

## Inicio rápido

Cualquier servidor de archivos estático funciona. La app necesita servirse
por HTTP(S) en lugar de abrirse como una URL `file://`, porque
`getUserMedia` requiere un contexto seguro — `localhost` cuenta como tal.

```bash
./web.sh          # servidor integrado de PHP en :8080, abre un navegador
./web.sh 9000     # ...en otro puerto
```

O usá lo que ya tengas:

```bash
python3 -m http.server 8080
npx serve .
```

Luego abrí `http://localhost:8080/` y presioná **Start capture**.

También se despliega tal cual en cualquier hosting estático — GitHub Pages,
Netlify, un bucket de S3. Todas las rutas son relativas, así que servirla
desde un subdirectorio funciona.

## Qué hace

- **Placa de espectro** — magnitud de frecuencia en vivo, con retención de
  pico opcional (decaimiento en dB/s), relleno bajo la traza, y persistencia
  estilo fósforo.
- **Placa de waterfall** — espectrograma desplazable sobre una ventana de
  historial seleccionable (5 s a 2 min) en una de siete paletas. El historial
  se guarda como datos, no como píxeles, así que cambiar la paleta, la
  ventana de dB o el zoom vuelve a pintar la *misma* grabación en lugar de
  descartarla.
- **Regla de frecuencia compartida** entre las dos placas. Ambas placas
  mapean la frecuencia al mismo eje X, así que un pico, su pin y su franja
  quedan alineados verticalmente.
- **Marcadores** — colocá uno en una frecuencia, dale un nombre, un ancho de
  banda, y observá su nivel en vivo, pico y tendencia en la tabla de
  informe. Se guardan por frecuencia en Hz (no en píxeles), así que
  sobreviven a cambios de zoom, tamaño de FFT y ventana, y persisten en
  `localStorage`.
- **Alarma de marcador (el "buscador")** — armá la campana en un marcador y
  dale un nivel de disparo: cuando esa banda lo alcanza, la app suena,
  subiendo de tono y repitiendo más rápido cuanto más fuerte sea. Caminá con
  una notebook o el celular y escuchá cómo te acercás a la fuente sin mirar
  la pantalla. Silenciar apaga todas las alarmas sin desarmarlas;
  "Disable all alarms" las apaga a todas. (Usá auriculares — con parlantes
  el sonido retroalimenta al micrófono.)
- **Detección de sonidos** — activá en el menú Detect los sonidos que te
  interesan y cada vez que se escucha uno queda registrado, marcado en la
  cascada en el momento en que ocurrió y (si querés) anunciado con un
  campanazo. Dos tipos de detector, lado a lado:
  - *Reglas de patrón*, instantáneas y livianas: **sirena** (ulular, yelp o
    dos tonos, reconocida por cómo se mueve el tono) y **zumbido de
    mosquito** (un tono de aleteo que deambula, con armónicos). Estas además
    marcan en la cascada la frecuencia que escucharon.
  - *El clasificador de sonidos YAMNet* — el modelo de Google de 521 clases
    de AudioSet, que viene incluido con SoundRadar y corre en un worker en
    segundo plano: **pájaro, perro, sirena, insecto / mosquito, tránsito,
    tren, choque / rotura, puerta**. Unos 16 MB, que se cargan desde este
    mismo sitio sólo cuando activás alguno de ellos.

  Cada detector tiene un medidor de confianza en vivo con su umbral marcado,
  así el umbral se ajusta mirando, y el registro de detecciones se exporta
  como CSV — dejá una tablet en una habitación toda la noche y volvé a una
  lista de cuándo pasó. Agregar un sonido nuevo es una entrada en el catálogo
  (ver `CLAUDE.md`). Los choques son la categoría más débil: YAMNet tiende a
  oír la rotura de un vidrio chico como campanitas o pájaros.
- **Sesiones** — estados guardados con nombre, cada uno con su propia
  configuración de pantalla y marcadores, que se cambian desde el menú de
  Sesión. Un relevamiento por habitación, por máquina, por visita a un
  sitio. La app siempre abre en la última sesión usada, y arranca su vida en
  una llamada *Default*.
- **Marcar armónicos** — coloca un marcador en cada armónico de la
  frecuencia más fuerte, la forma más rápida de confirmar una única fuente
  tonal (un motor, un ventilador, zumbido de línea eléctrica).
- **Ajustar a la señal** — fija el piso y el techo de dB según lo que esté
  haciendo la entrada en ese momento.
- **Preajustes de rango** — rango completo, retumbo, voz, siseo, zumbido de
  línea eléctrica.
- **Exportar** — guardá la vista actual como PNG, la tabla de marcadores
  como CSV, o todas tus sesiones como un único archivo JSON que se puede
  importar en otra máquina. Importar agrega sesiones junto a las tuyas;
  nunca las sobrescribe.
- Temas claro y oscuro, un selector de dispositivo de entrada, y un diseño
  pensado tanto para tablet/touch como para escritorio.

## Controles

| Gesto | Acción |
| --- | --- |
| Arrastrar una placa | Desplazar el rango de frecuencia |
| Rueda / pellizco | Zoom alrededor del puntero |
| Shift + arrastrar | Seleccionar un rango para hacer zoom |
| Doble clic / tap | Colocar un marcador en esa frecuencia |
| Presión prolongada (touch) | Colocar un marcador |
| Arrastrar un pin | Mover un marcador a lo largo de la regla |

| Tecla | Acción |
| --- | --- |
| <kbd>Espacio</kbd> | Iniciar captura, o pausarla / reanudarla |
| <kbd>M</kbd> | Colocar un marcador en el cursor |
| <kbd>←</kbd> <kbd>→</kbd> | Desplazar |
| <kbd>+</kbd> <kbd>−</kbd> | Zoom |
| <kbd>Esc</kbd> | Cerrar el menú de la barra de herramientas abierto |

## Requisitos

Un navegador moderno con la Web Audio API y `getUserMedia` (Chrome, Edge,
Firefox, Safari). No se planea soporte para navegadores antiguos o con
prefijos de proveedor. El permiso de micrófono se solicita al presionar
**Start capture** y puede revocarse en cualquier momento.

## Privacidad

No hay componente de servidor ni tráfico de red más allá de cargar la propia
app. El audio se procesa en la página mediante la Web Audio API y nunca se
graba, sube ni persiste. La detección de sonidos también es local: el modelo
YAMNet y su runtime son archivos de este repositorio, que se descargan del
mismo lugar que el resto de la app y corren en un worker dentro de tu
pestaña — ni el audio, ni sus características, ni los resultados salen nunca
del dispositivo. Ése es el sentido de hacerlo así: todas las apps
comparables responden "¿qué fue ese sonido?" mandando tu micrófono a un
servidor.

Lo único que se guarda son tus sesiones — configuración de pantalla,
marcadores y qué detectores están activos — además de tu tema, en el
`localStorage` de este navegador (claves con el prefijo `soundradar.`).
Exportar escribe un archivo en tu propio disco; no se envía nada a ningún
lado.

## Estructura del repositorio

```
index.html            markup y todos los controles
css/style.css         todos los estilos, con tema vía propiedades CSS personalizadas
js/app.js             raíz de composición: settings, cableado, bucle de render
js/core/              módulos de análisis y renderizado reutilizables, sin DOM
js/core/sessions.js   estados guardados con nombre, y exportación/importación JSON de todos ellos
js/core/alarm.js      el tono de la alarma de marcador y el campanazo de detección
js/core/detect/       detección de sonidos: catálogo, motor, reglas, worker de YAMNet
js/core/capture.js    toma de audio crudo (AudioWorklet) para el clasificador
js/vendor/            TensorFlow.js, incluido como un único módulo ES
models/yamnet/        los pesos del modelo YAMNet y su mapa de clases
js/ruler.js           la regla de frecuencia compartida entre las placas
js/markers-table.js   la tabla de informe de marcadores
js/detect-menu.js     el menú Detect: detectores, medidores, umbrales
js/detections-table.js el registro de detecciones
js/theme.js           lee los colores del canvas desde la hoja de estilos
CHANGELOG.md          qué cambió en cada versión
SPEC.md               objetivos del proyecto y el pipeline de audio compartido
spec-spectrum-analyzer.md   intención de diseño para la herramienta de analizador
spec-recognition.md   intención de diseño para el reconocimiento / detección de señales
CLAUDE.md             notas de arquitectura y convenciones para contribuidores
```

## Contribuir

Se aceptan issues y pull requests. No hay configuración de build, lint ni
test — editá los archivos y recargá la página. Dos convenciones importan:

- Toda la matemática de frecuencia/dB ↔ píxeles vive en `js/core/scale.js`.
  No vuelvas a derivar la escala logarítmica ni el mapeo de dB en el código
  de dibujo.
- Los settings nuevos van en `BASE_DEFAULTS` en `js/core/settings.js` para
  que la validación, la persistencia y "Reset all settings" sigan siendo
  autoritativas.

`CLAUDE.md` tiene el recorrido de arquitectura completo.

## Licencia

MIT — ver [LICENSE](./LICENSE). Dos componentes de terceros vienen incluidos
bajo su propia licencia, Apache-2.0: TensorFlow.js (`js/vendor/`) y el modelo
YAMNet (`models/yamnet/`). Cada directorio tiene un README con su origen y
versión.
