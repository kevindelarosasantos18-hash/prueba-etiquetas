(function () {
  'use strict';

  var PAUSA_TRAS_LECTURA_MS = 1000;   // tiempo para pasar al siguiente código
  var INTERVALO_DETECCION_MS = 100;   // limita el uso de CPU en teléfonos de gama baja
  var FORMATOS_NATIVOS = ['code_128', 'ean_13', 'ean_8', 'upc_a'];

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');

  var flujo = null;          // MediaStream
  var pista = null;          // MediaStreamTrack de video
  var lectorZxing = null;
  var detectorNativo = null;
  var motorActivo = '';
  var activo = false;
  var listoDesde = 0;        // momento en que el escáner quedó listo
  var pausadoHasta = 0;
  var linternaOn = false;
  var lecturas = [];
  var temporizador = null;
  var audio = null;
  var cuadros = 0;           // cuadros analizados
  var msAnalisis = 0;        // tiempo total de análisis, para medir la carga en el teléfono

  function estado(texto, error) {
    $('estado').textContent = texto;
    $('estado').className = error ? 'estado error' : 'ayuda';
  }

  function describir(codigo, formato) {
    var m = /^90(\d{2})(\d{4})$/.exec(codigo);
    if (m) return 'Calibración: barra de 0,' + m[1] + ' mm (copia ' + Number(m[2]) + ')';
    if (/^20\d{6}$/.test(codigo)) return 'Código interno de producto';
    if (formato === 'ean_13' || formato === 'EAN_13') return 'EAN-13 (de fábrica)';
    return 'Otro (' + formato + ')';
  }

  function pitido() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var o = audio.createOscillator();
      var g = audio.createGain();
      o.frequency.value = 1800;
      g.gain.value = 0.15;
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.08);
    } catch (e) { /* sin sonido */ }
    if (navigator.vibrate) navigator.vibrate(60);
    var f = $('flash');
    f.classList.add('on');
    setTimeout(function () { f.classList.remove('on'); }, 120);
  }

  function registrar(codigo, formato) {
    var ahora = performance.now();
    if (ahora < pausadoHasta) return;
    var ms = Math.round(ahora - listoDesde);
    pausadoHasta = ahora + PAUSA_TRAS_LECTURA_MS;
    listoDesde = pausadoHasta;

    var desc = describir(codigo, formato);
    lecturas.push({ codigo: codigo, desc: desc, ms: ms, motor: motorActivo, hora: new Date().toLocaleTimeString() });
    pitido();

    $('ultimo').textContent = codigo;
    $('detalle').textContent = desc + ' · ' + ms + ' ms';

    var tr = document.createElement('tr');
    [codigo, desc, ms + ' ms'].forEach(function (t) {
      var td = document.createElement('td');
      td.textContent = t;
      tr.appendChild(td);
    });
    $('lista').insertBefore(tr, $('lista').firstChild);
    actualizarResumen();
  }

  function actualizarResumen() {
    $('r-total').textContent = lecturas.length;
    if (!lecturas.length) { $('r-media').textContent = '—'; $('r-max').textContent = '—'; return; }
    var suma = 0, max = 0;
    lecturas.forEach(function (l) { suma += l.ms; if (l.ms > max) max = l.ms; });
    $('r-media').textContent = (suma / lecturas.length / 1000).toFixed(1) + ' s';
    $('r-max').textContent = (max / 1000).toFixed(1) + ' s';
  }

  // ---------- Motor nativo (BarcodeDetector) ----------
  async function nativoDisponible() {
    if (!('BarcodeDetector' in window)) return false;
    try {
      var soportados = await window.BarcodeDetector.getSupportedFormats();
      return soportados.indexOf('code_128') !== -1;
    } catch (e) { return false; }
  }

  async function cicloNativo() {
    if (!activo || motorActivo !== 'nativo') return;
    if (performance.now() >= pausadoHasta && video.readyState >= 2) {
      var t0 = performance.now();
      try {
        var res = await detectorNativo.detect(video);
        if (res.length) registrar(res[0].rawValue, res[0].format);
      } catch (e) { /* cuadro no disponible; se reintenta */ }
      cuadros++; msAnalisis += performance.now() - t0;
    }
    temporizador = setTimeout(cicloNativo, INTERVALO_DETECCION_MS);
  }

  // ---------- Motor ZXing ----------
  // Se decodifica una franja central del cuadro (60 % del alto) para ahorrar CPU.
  var lienzo = null;
  var ctx = null;

  function iniciarZxing() {
    var hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.EAN_13,
      ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A
    ]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    lectorZxing = new ZXing.MultiFormatReader();
    lectorZxing.setHints(hints);
    lienzo = document.createElement('canvas');
    ctx = lienzo.getContext('2d', { willReadFrequently: true });
    cicloZxing();
  }

  function cicloZxing() {
    if (!activo || motorActivo !== 'zxing') return;
    if (performance.now() >= pausadoHasta && video.readyState >= 2 && video.videoWidth) {
      var w = video.videoWidth;
      var h = Math.round(video.videoHeight * 0.6);
      var y = Math.round((video.videoHeight - h) / 2);
      if (lienzo.width !== w || lienzo.height !== h) { lienzo.width = w; lienzo.height = h; }
      var t0 = performance.now();
      ctx.drawImage(video, 0, y, w, h, 0, 0, w, h);
      try {
        var fuente = new ZXing.HTMLCanvasElementLuminanceSource(lienzo);
        var mapa = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(fuente));
        var r = lectorZxing.decodeWithState(mapa);
        registrar(r.getText(), ZXing.BarcodeFormat[r.getBarcodeFormat()]);
      } catch (e) {
        /* ningún código en este cuadro */
      } finally {
        lectorZxing.reset();
        cuadros++; msAnalisis += performance.now() - t0;
      }
    }
    temporizador = setTimeout(cicloZxing, INTERVALO_DETECCION_MS);
  }

  // ---------- Cámara ----------
  async function iniciar() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      estado('Este navegador no permite usar la cámara. Abre la página con https:// en Chrome.', true);
      return;
    }
    $('iniciar').disabled = true;
    estado('Pidiendo permiso de cámara…');
    try {
      flujo = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 }, height: { ideal: 720 },
          advanced: [{ focusMode: 'continuous' }]
        }
      });
    } catch (e) {
      $('iniciar').disabled = false;
      estado('No se pudo abrir la cámara: ' + (e.name === 'NotAllowedError' ? 'permiso denegado.' : e.message), true);
      return;
    }
    pista = flujo.getVideoTracks()[0];
    video.srcObject = flujo;
    await video.play().catch(function () {});

    var quiereNativo = $('motor').value === 'auto' && await nativoDisponible();
    motorActivo = quiereNativo ? 'nativo' : 'zxing';
    activo = true;
    cuadros = 0; msAnalisis = 0;
    listoDesde = performance.now();
    pausadoHasta = 0;

    if (motorActivo === 'nativo') {
      detectorNativo = new window.BarcodeDetector({ formats: FORMATOS_NATIVOS });
      cicloNativo();
    } else {
      iniciarZxing();
    }

    var ajustes = pista.getSettings ? pista.getSettings() : {};
    var caps = pista.getCapabilities ? pista.getCapabilities() : {};
    $('linterna').classList.toggle('oculto', !caps.torch);
    $('detener').disabled = false;
    estado('Lector: ' + (motorActivo === 'nativo' ? 'nativo del navegador' : 'ZXing') +
      ' · cámara ' + (ajustes.width || '?') + '×' + (ajustes.height || '?') +
      (caps.focusMode ? ' · enfoque: ' + caps.focusMode.join('/') : ''));
  }

  function detener() {
    activo = false;
    clearTimeout(temporizador);
    lectorZxing = null;
    if (flujo) { flujo.getTracks().forEach(function (t) { t.stop(); }); flujo = null; }
    pista = null;
    linternaOn = false;
    video.srcObject = null;
    $('iniciar').disabled = false;
    $('detener').disabled = true;
    $('linterna').classList.add('oculto');
    estado('Cámara apagada.');
  }

  $('iniciar').addEventListener('click', iniciar);
  $('detener').addEventListener('click', detener);
  $('motor').addEventListener('change', function () { if (activo) { detener(); iniciar(); } });

  $('linterna').addEventListener('click', function () {
    if (!pista) return;
    linternaOn = !linternaOn;
    pista.applyConstraints({ advanced: [{ torch: linternaOn }] }).catch(function () {
      estado('La linterna no está disponible en este teléfono.', true);
    });
  });

  $('limpiar').addEventListener('click', function () {
    lecturas = [];
    $('lista').innerHTML = '';
    $('ultimo').textContent = '—';
    actualizarResumen();
  });

  $('copiar').addEventListener('click', function () {
    var texto = 'Prueba de escaneo · ' + new Date().toLocaleString() + '\n' +
      'Navegador: ' + navigator.userAgent + '\n' +
      'Lector: ' + (motorActivo || 'sin iniciar') + '\n' +
      'Análisis por cuadro: ' + (cuadros ? (msAnalisis / cuadros).toFixed(0) + ' ms (' + cuadros + ' cuadros)' : '—') + '\n' +
      'Lecturas: ' + lecturas.length + ' · promedio ' + $('r-media').textContent + ' · más lenta ' + $('r-max').textContent + '\n\n' +
      lecturas.map(function (l) { return l.hora + '\t' + l.codigo + '\t' + l.desc + '\t' + l.ms + ' ms\t' + l.motor; }).join('\n');
    var listo = function () { $('copiado').textContent = 'Copiado. Pégalo en el chat.'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(listo, function () { prompt('Copia este texto:', texto); });
    } else {
      prompt('Copia este texto:', texto);
    }
  });

  document.addEventListener('visibilitychange', function () { if (document.hidden && activo) detener(); });
})();
