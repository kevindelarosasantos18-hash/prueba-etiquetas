# Etapa 0 — Prueba de etiquetas y escaneo

Prototipo sin servidor ni base de datos. Responde una sola pregunta antes de construir la app: **¿las etiquetas impresas en una impresora normal se leen rápido y bien con la cámara de un celular de gama baja?**

## Contenido

| Archivo | Qué hace |
|---|---|
| `etiquetas.html` | Genera hojas A4: una **hoja de calibración** (6 grosores de barra, de 0,20 a 0,50 mm) y **etiquetas de productos** en 3 tamaños, con líneas de corte, precio opcional y posición de inicio para aprovechar hojas usadas |
| `escanear.html` | Escanea con la cámara del celular con dos lectores: nativo del navegador y ZXing-C++ (WebAssembly) como respaldo. ZXing JS se retiró el 5 oct 2026 tras leer mal dos EAN-13 en la prueba real. Solo lee dentro del recuadro blanco y, si hay varios códigos, toma el más cercano al centro. Pide dos cuadros seguidos iguales antes de contar una lectura. Modo **continuo** (no repite un código hasta que sale del recuadro) y modo **una a la vez** (espera a que toques "Leer siguiente"). Mide tiempos, marca lecturas sospechosas y copia los resultados |
| `vendor/` | JsBarcode 3.12.3 y zxing-wasm 3.1.4 (lector), copiados localmente (sin depender de CDN) |

Códigos internos: 8 dígitos que empiezan con `20` (rango reservado para uso interno de tiendas). Códigos de 13 dígitos válidos se imprimen como EAN-13.

## Publicar (requiere HTTPS: la cámara no funciona en http)

**Opción recomendada para esta etapa: GitHub Pages** (gratis, HTTPS incluido, sin tocar el servidor de RedactaPro):

1. Subir esta carpeta a un repositorio de GitHub.
2. En el repositorio: **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.
3. En 1–2 minutos queda en `https://<usuario>.github.io/<repositorio>/`.

## Protocolo de prueba

**Impresión (computadora):**

1. Abrir `etiquetas.html` → *Hoja de calibración* → **Imprimir** con papel A4, márgenes *Ninguno* y escala **100 %**.
2. Medir con una regla la línea de 50 mm. Si no mide 50 mm, corregir la escala de impresión y repetir.
3. Imprimir la hoja en **adhesivo mate** y en **adhesivo fotográfico**.
4. Cambiar a *Etiquetas de productos* e imprimir una hoja de cada tamaño (pequeña, mediana, grande) en adhesivo mate.

**Escaneo (celular Tecno Spark 30C, Chrome):**

1. Abrir `escanear.html` → **Iniciar cámara** → permitir la cámara.
2. Con el lector *Automático*, escanear cada fila de la hoja de calibración (3 copias por fila), sosteniendo el celular a unos 10–15 cm.
3. Repetir con la hoja en papel fotográfico.
4. Repetir con luz baja (o activar la linterna si aparece el botón).
5. Repetir la hoja mate con el lector *ZXing-C++*.
6. Probar los dos modos: *Continua* (dejar el celular quieto sobre un código: debe contarlo una sola vez) y *Una a la vez*.
7. Escanear las etiquetas de productos de los 3 tamaños.
8. **Copiar resultados** después de cada bloque y pegarlos en el chat, indicando papel y luz.

**Anotar a mano:** la fila más fina que se lee en menos de 2 segundos en cada papel, y cualquier código que se haya leído mal (otro número).

## Criterio de éxito

- Etiqueta **pequeña** en papel mate: lectura promedio de menos de 1,5 s, sin lecturas equivocadas.
- Si la pequeña falla y la mediana pasa, la mediana se fija como tamaño mínimo.
- Si ninguna pasa con el lector nativo ni con ZXing, se replantea el escaneo por cámara antes de construir la app.

## Verificación hecha antes de entregar

- Sintaxis de los scripts revisada con `node --check`.
- Hojas generadas en Chromium e impresas a PDF A4: los 18 códigos de calibración y las 45 etiquetas de producto (3 tamaños) se decodificaron correctamente con zxing-cpp a 300 ppp.
- Escáner probado en Chromium con una cámara simulada: ZXing leyó la etiqueta mediana en ~60–90 ms por lectura, sin errores de consola.
- Versión 2 (5 oct 2026), con cámara simulada sobre una fila de 3 códigos de calibración: ZXing-C++ y ZXing JS leen solo el código central, una sola vez en modo continuo (antes se repetía cada segundo), y una vez por toque en modo "una a la vez". Sobre una etiqueta mediana con vecinas y líneas de corte, ambos leen el código correcto.
- No probado aún: cámara real, impresora real, lector nativo (no existe en Chromium de Linux).
