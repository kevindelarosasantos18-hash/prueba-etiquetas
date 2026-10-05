(function () {
  'use strict';

  // ---- Ajustes de lectura ----
  var INTERVALO_DETECCION_MS = 100;  // limita el uso de CPU en teléfonos de gama baja
  var CONFIRMAR_VENTANA_MS = 450;    // el mismo código debe verse en 2 cuadros seguidos dentro de esta ventana
  var AUSENCIA_PARA_REPETIR_MS = 800; // el mismo código solo se vuelve a contar si salió del recuadro este tiempo
  var PAUSA_ENTRE_CODIGOS_MS = 300;  // pausa mínima antes de aceptar un código distinto
  // Recuadro blanco en pantalla, en fracciones del área visible (debe coincidir con .guia en el CSS).
  var GUIA = { x0: 0.10, x1: 0.90, y0: 0.30, y1: 0.70 };
  var FORMATOS_NATIVOS = ['code_128', 'ean_13', 'ean_8', 'upc_a'];

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');

  var flujo = null, pista = null;
  var detectorNativo = null, lienzo = null, ctx = null;
  var motorActivo = '', activo = false, temporizador = null, audio = null, linternaOn = false;
  var lecturas = [], cuadros = 0, msAnalisis = 0;
  var costoPorLector = {};   // { lector: { cuadros, ms } } acumulado en toda la sesión

  // Estado de la lógica de aceptación
  var pendiente = null;        // { texto, formato, t } visto una vez, esperando confirmación
  var ultimoAceptado = '';     // último código contado
  var tAceptado = 0;           // cuándo se contó
  var ultimoVistoEnZona = 0;   // última vez que ese mismo código seguía en el recuadro
  var listoDesde = 0;          // inicio del cronómetro de la lectura actual
  var esperandoToque = false;  // modo "una a la vez": pausa hasta tocar "Leer siguiente"

  function estado(texto, error) {
    $('estado').textContent = texto;
    $('estado').className = error ? 'estado error' : 'ayuda';
  }

  function eanValido(c) {
    if (!/^\d{13}$/.test(c)) return false;
    var s = 0;
    for (var i = 0; i < 12; i++) s += Number(c[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (s % 10)) % 10 === Number(c[12]);
  }

  // Códigos que existen en las hojas de prueba. Cualquier otro es una lectura errónea.
  // (Un EAN-13 mal leído suele tener dígito verificador válido, por eso se compara con la lista exacta.)
  var EAN_DE_PRUEBA = ['7861234567898'];
  function esperado(c) {
    return /^90(20|25|30|35|40|50)000[1-3]$/.test(c) || /^200000(0[1-9]|[1-9]\d)$/.test(c) || EAN_DE_PRUEBA.indexOf(c) !== -1;
  }

  function describir(codigo, formato) {
    var m = /^90(\d{2})(\d{4})$/.exec(codigo);
    if (m) return 'Calibración: barra de 0,' + m[1] + ' mm (copia ' + Number(m[2]) + ')';
    if (/^20\d{6}$/.test(codigo)) return 'Código interno de producto';
    if (/^ean_?13$/i.test(formato)) return 'EAN-13 (de fábrica)';
    return 'Otro (' + formato + ')';
  }

  function pitido() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 1800; g.gain.value = 0.15;
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.08);
    } catch (e) { /* sin sonido */ }
    if (navigator.vibrate) navigator.vibrate(60);
    var f = $('flash');
    f.classList.add('on');
    setTimeout(function () { f.classList.remove('on'); }, 120);
  }

  function modoUnaAUna() { return $('modo').value === 'una'; }

  // Convierte el recuadro de pantalla a coordenadas del video (0–1), considerando el recorte
  // de object-fit: cover. Funciona con el teléfono vertical u horizontal.
  function zonaVideo() {
    var vw = video.videoWidth, vh = video.videoHeight;
    var cw = video.clientWidth || vw, ch = video.clientHeight || vh;
    var escala = Math.max(cw / vw, ch / vh);
    var visW = cw / escala / vw, visH = ch / escala / vh;   // fracción visible del video
    var offX = (1 - visW) / 2, offY = (1 - visH) / 2;
    return {
      x0: offX + GUIA.x0 * visW, x1: offX + GUIA.x1 * visW,
      y0: offY + GUIA.y0 * visH, y1: offY + GUIA.y1 * visH
    };
  }

  // ---- Decide si un cuadro produce una lectura válida ----
  // candidatos: [{ texto, formato, cx, cy }] con el centro en coordenadas 0–1 del video.
  function procesar(candidatos) {
    var ahora = performance.now();
    var z = zonaVideo();
    var enZona = candidatos.filter(function (c) {
      return c.cx >= z.x0 && c.cx <= z.x1 && c.cy >= z.y0 && c.cy <= z.y1;
    });

    // El código ya contado sigue en el recuadro: no se repite.
    if (ultimoAceptado && enZona.some(function (c) { return c.texto === ultimoAceptado; })) {
      ultimoVistoEnZona = ahora;
    }
    if (!enZona.length) { pendiente = null; return; }

    // Con varios códigos en el recuadro, se elige el más cercano al centro.
    enZona.sort(function (a, b) {
      return (Math.pow(a.cx - 0.5, 2) + Math.pow(a.cy - 0.5, 2)) - (Math.pow(b.cx - 0.5, 2) + Math.pow(b.cy - 0.5, 2));
    });
    var c = enZona[0];

    if (c.texto === ultimoAceptado && ahora - ultimoVistoEnZona < AUSENCIA_PARA_REPETIR_MS) return;
    if (ahora - tAceptado < PAUSA_ENTRE_CODIGOS_MS) return;

    // Confirmación: dos cuadros seguidos con el mismo código.
    if (!pendiente || pendiente.texto !== c.texto || ahora - pendiente.t > CONFIRMAR_VENTANA_MS) {
      pendiente = { texto: c.texto, formato: c.formato, t: ahora };
      return;
    }
    pendiente = null;
    aceptar(c.texto, c.formato, ahora);
  }

  function aceptar(codigo, formato, ahora) {
    var ms = Math.round(ahora - listoDesde);
    ultimoAceptado = codigo;
    tAceptado = ahora;
    ultimoVistoEnZona = ahora;
    listoDesde = ahora;

    var ok = esperado(codigo);
    var desc = describir(codigo, formato) + (ok ? '' : ' ⚠ código inesperado: posible lectura errónea');
    lecturas.push({ codigo: codigo, desc: desc, ms: ms, ok: ok, motor: motorActivo, modo: $('modo').value, hora: new Date().toLocaleTimeString() });
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

    if (modoUnaAUna()) {
      esperandoToque = true;
      $('siguiente').classList.remove('oculto');
    }
  }

  function actualizarResumen() {
    $('r-total').textContent = lecturas.length;
    var malas = lecturas.filter(function (l) { return !l.ok; }).length;
    $('r-malas').textContent = malas;
    if (!lecturas.length) { $('r-media').textContent = '—'; return; }
    var suma = 0;
    lecturas.forEach(function (l) { suma += l.ms; });
    $('r-media').textContent = (suma / lecturas.length / 1000).toFixed(1) + ' s';
  }

  function sumarCosto(ms) {
    cuadros++; msAnalisis += ms;
    var c = costoPorLector[motorActivo] || (costoPorLector[motorActivo] = { cuadros: 0, ms: 0 });
    c.cuadros++; c.ms += ms;
  }

  function puedeAnalizar() {
    return activo && !esperandoToque && video.readyState >= 2 && video.videoWidth;
  }

  // ---- Motor nativo (BarcodeDetector) ----
  async function nativoDisponible() {
    if (!('BarcodeDetector' in window)) return false;
    try {
      var soportados = await window.BarcodeDetector.getSupportedFormats();
      return soportados.indexOf('code_128') !== -1;
    } catch (e) { return false; }
  }

  async function cicloNativo() {
    if (!activo || motorActivo !== 'nativo') return;
    if (puedeAnalizar()) {
      var t0 = performance.now();
      try {
        var res = await detectorNativo.detect(video);
        var vw = video.videoWidth, vh = video.videoHeight;
        procesar(res.map(function (r) {
          var b = r.boundingBox;
          return { texto: r.rawValue, formato: r.format, cx: (b.x + b.width / 2) / vw, cy: (b.y + b.height / 2) / vh };
        }));
      } catch (e) { /* cuadro no disponible; se reintenta */ }
      sumarCosto(performance.now() - t0);
    }
    temporizador = setTimeout(cicloNativo, INTERVALO_DETECCION_MS);
  }

  // ---- Motor ZXing-C++ (WebAssembly): más robusto, lee varios códigos y su posición ----
  var wasmListo = null;
  function iniciarWasm() {
    if (!wasmListo) {
      wasmListo = ZXingWASM.prepareZXingModule({
        overrides: { locateFile: function (ruta, prefijo) { return ruta.endsWith('.wasm') ? new URL('vendor/' + ruta, location.href).href : prefijo + ruta; } },
        fireImmediately: true
      });
    }
    lienzo = document.createElement('canvas');
    ctx = lienzo.getContext('2d', { willReadFrequently: true });
    estado('Cargando lector ZXing-C++…');
    return wasmListo.then(function () { cicloWasm(); });
  }

  var OPCIONES_WASM = { formats: ['Code128', 'EAN13', 'EAN8', 'UPCA'], tryHarder: true, maxNumberOfSymbols: 4 };

  async function cicloWasm() {
    if (!activo || motorActivo !== 'wasm') return;
    if (puedeAnalizar()) {
      var vw = video.videoWidth, vh = video.videoHeight, z = zonaVideo();
      var x = Math.round(vw * z.x0), y = Math.round(vh * z.y0);
      var w = Math.round(vw * (z.x1 - z.x0)), h = Math.round(vh * (z.y1 - z.y0));
      if (lienzo.width !== w || lienzo.height !== h) { lienzo.width = w; lienzo.height = h; }
      var t0 = performance.now();
      ctx.drawImage(video, x, y, w, h, 0, 0, w, h);
      try {
        var res = await ZXingWASM.readBarcodes(ctx.getImageData(0, 0, w, h), OPCIONES_WASM);
        procesar(res.filter(function (r) { return r.isValid; }).map(function (r) {
          var p = r.position;
          var px = (p.topLeft.x + p.topRight.x + p.bottomLeft.x + p.bottomRight.x) / 4;
          var py = (p.topLeft.y + p.topRight.y + p.bottomLeft.y + p.bottomRight.y) / 4;
          return { texto: r.text, formato: r.format, cx: (x + px) / vw, cy: (y + py) / vh };
        }));
      } catch (e) { /* cuadro no disponible; se reintenta */ }
      sumarCosto(performance.now() - t0);
    }
    temporizador = setTimeout(cicloWasm, INTERVALO_DETECCION_MS);
  }

  // ---- Cámara ----
  async function iniciar() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      estado('Este navegador no permite usar la cámara. Abre la página con https:// en Chrome.', true);
      return;
    }
    $('iniciar').disabled = true;
    estado('Pidiendo permiso de cámara…');
    try {
      var elegida = $('camara').value;
      var video_ = {
        width: { ideal: 1280 }, height: { ideal: 720 },
        advanced: [{ focusMode: 'continuous' }]
      };
      if (elegida) video_.deviceId = { exact: elegida };
      else video_.facingMode = { ideal: 'environment' };
      flujo = await navigator.mediaDevices.getUserMedia({ audio: false, video: video_ });
    } catch (e) {
      $('iniciar').disabled = false;
      estado('No se pudo abrir la cámara: ' + (e.name === 'NotAllowedError' ? 'permiso denegado.' : e.message), true);
      return;
    }
    pista = flujo.getVideoTracks()[0];
    await llenarCamaras(pista);
    video.srcObject = flujo;
    await video.play().catch(function () {});

    var eleccion = $('motor').value;
    if (eleccion === 'auto') motorActivo = (await nativoDisponible()) ? 'nativo' : 'wasm';
    else motorActivo = eleccion;
    activo = true;
    cuadros = 0; msAnalisis = 0;
    pendiente = null; ultimoAceptado = ''; tAceptado = 0; esperandoToque = false;
    listoDesde = performance.now();
    $('siguiente').classList.add('oculto');

    if (motorActivo === 'nativo') {
      detectorNativo = new window.BarcodeDetector({ formats: FORMATOS_NATIVOS });
      cicloNativo();
    } else if (motorActivo === 'wasm') {
      try { await iniciarWasm(); } catch (e) {
        estado('No se pudo cargar el lector ZXing-C++: ' + e.message, true);
        return;
      }
    }

    var ajustes = pista.getSettings ? pista.getSettings() : {};
    var caps = pista.getCapabilities ? pista.getCapabilities() : {};
    // Enfoque: algunos navegadores ignoran el enfoque continuo pedido al abrir la cámara;
    // se vuelve a pedir ya con la cámara abierta y se ofrecen controles manuales.
    var modosEnfoque = caps.focusMode || [];
    if (modosEnfoque.indexOf('continuous') !== -1) {
      pista.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
    }
    $('panel-enfoque').classList.toggle('oculto', !modosEnfoque.length);
    $('enfoque-manual').checked = false;
    $('enfoque-manual').disabled = !(caps.focusDistance && modosEnfoque.indexOf('manual') !== -1);
    $('panel-distancia').classList.add('oculto');
    if (caps.focusDistance) {
      var fd = caps.focusDistance, d = $('distancia');
      d.min = fd.min; d.max = fd.max; d.step = fd.step || (fd.max - fd.min) / 100;
      d.value = ajustes.focusDistance !== undefined ? ajustes.focusDistance : (fd.min + fd.max) / 2;
    }

    $('linterna').classList.toggle('oculto', !caps.torch);
    $('linterna').classList.remove('on');
    $('linterna').textContent = 'Linterna';
    // Compensación de exposición: permite oscurecer la imagen cuando el papel refleja mucha luz.
    if (caps.exposureCompensation && caps.exposureCompensation.max > caps.exposureCompensation.min) {
      var b = $('brillo'), ec = caps.exposureCompensation;
      b.min = ec.min; b.max = ec.max; b.step = ec.step || 0.1;
      b.value = ajustes.exposureCompensation !== undefined ? ajustes.exposureCompensation : 0;
      $('panel-brillo').classList.remove('oculto');
    } else {
      $('panel-brillo').classList.add('oculto');
    }
    $('detener').disabled = false;
    estado('Lector: ' + ({ nativo: 'nativo del navegador', wasm: 'ZXing-C++' })[motorActivo] +
      ' · cámara ' + (ajustes.width || '?') + '×' + (ajustes.height || '?') +
      (caps.focusMode ? ' · enfoque: ' + caps.focusMode.join('/') : ''));
  }

  // Lista las cámaras disponibles. Algunos celulares tienen varias traseras (principal,
  // gran angular, macro, profundidad) y el navegador puede elegir una que enfoca mal.
  async function llenarCamaras(pistaActual) {
    try {
      var disp = (await navigator.mediaDevices.enumerateDevices()).filter(function (d) { return d.kind === 'videoinput'; });
      var sel = $('camara');
      var actual = pistaActual.getSettings ? pistaActual.getSettings().deviceId : '';
      sel.innerHTML = '';
      disp.forEach(function (d, i) {
        var o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || ('Cámara ' + (i + 1));
        if (d.deviceId === actual) o.selected = true;
        sel.appendChild(o);
      });
      $('panel-camara').classList.toggle('oculto', disp.length < 2);
    } catch (e) { /* sin lista de cámaras */ }
  }

  function detener() {
    activo = false;
    clearTimeout(temporizador);
    if (flujo) { flujo.getTracks().forEach(function (t) { t.stop(); }); flujo = null; }
    pista = null;
    linternaOn = false;
    video.srcObject = null;
    esperandoToque = false;
    $('siguiente').classList.add('oculto');
    $('iniciar').disabled = false;
    $('detener').disabled = true;
    $('linterna').classList.add('oculto');
    $('panel-brillo').classList.add('oculto');
    $('panel-enfoque').classList.add('oculto');
    estado('Cámara apagada.');
  }

  $('iniciar').addEventListener('click', iniciar);
  $('detener').addEventListener('click', detener);
  $('motor').addEventListener('change', function () { if (activo) { detener(); iniciar(); } });
  $('camara').addEventListener('change', function () { if (activo) { detener(); iniciar(); } });
  $('modo').addEventListener('change', function () {
    esperandoToque = false;
    $('siguiente').classList.add('oculto');
    listoDesde = performance.now();
  });

  $('siguiente').addEventListener('click', function () {
    esperandoToque = false;
    ultimoAceptado = '';           // en este modo se puede volver a leer el mismo código a propósito
    pendiente = null;
    listoDesde = performance.now();
    $('siguiente').classList.add('oculto');
  });

  $('linterna').addEventListener('click', function () {
    if (!pista) return;
    linternaOn = !linternaOn;
    pista.applyConstraints({ advanced: [{ torch: linternaOn }] }).then(function () {
      $('linterna').classList.toggle('on', linternaOn);
      $('linterna').textContent = linternaOn ? 'Linterna: encendida' : 'Linterna';
    }).catch(function () {
      linternaOn = false;
      estado('La linterna no está disponible en este teléfono.', true);
    });
  });

  $('brillo').addEventListener('input', function () {
    if (!pista) return;
    pista.applyConstraints({ advanced: [{ exposureMode: 'continuous', exposureCompensation: Number(this.value) }] }).catch(function () {});
  });

  function enfocarAhora() {
    if (!pista || !pista.getCapabilities || $('enfoque-manual').checked) return;
    var modos = pista.getCapabilities().focusMode || [];
    if (modos.indexOf('single-shot') === -1) return;
    pista.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }).then(function () {
      setTimeout(function () {
        if (pista && !$('enfoque-manual').checked && modos.indexOf('continuous') !== -1) {
          pista.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
        }
      }, 1500);
    }).catch(function () {});
  }
  $('enfocar').addEventListener('click', enfocarAhora);

  $('enfoque-manual').addEventListener('change', function () {
    if (!pista) return;
    var manual = this.checked;
    $('panel-distancia').classList.toggle('oculto', !manual);
    var c = manual
      ? { focusMode: 'manual', focusDistance: Number($('distancia').value) }
      : { focusMode: 'continuous' };
    pista.applyConstraints({ advanced: [c] }).catch(function () {
      estado('Este navegador no permite cambiar el enfoque manualmente.', true);
    });
  });

  $('distancia').addEventListener('input', function () {
    if (!pista || !$('enfoque-manual').checked) return;
    pista.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: Number(this.value) }] }).catch(function () {});
  });

  // Tocar la imagen fuerza un enfoque puntual y luego vuelve al enfoque continuo.
  video.addEventListener('click', enfocarAhora);

  $('limpiar').addEventListener('click', function () {
    lecturas = [];
    $('lista').innerHTML = '';
    $('ultimo').textContent = '—';
    actualizarResumen();
  });

  $('copiar').addEventListener('click', function () {
    var texto = 'Prueba de escaneo · ' + new Date().toLocaleString() + '\n' +
      'Navegador: ' + navigator.userAgent + '\n' +
      'Lector: ' + (motorActivo || 'sin iniciar') + ' · modo: ' + $('modo').value + '\n' +
      'Cámara: ' + (($('camara').selectedOptions[0] || {}).textContent || 'predeterminada') + '\n' +
      'Enfoque: ' + (pista && pista.getSettings ? (pista.getSettings().focusMode || '?') + (pista.getSettings().focusDistance !== undefined ? ' · distancia ' + pista.getSettings().focusDistance : '') : '—') + '\n' +
      'Análisis por cuadro: ' + (Object.keys(costoPorLector).map(function (k) {
        var c = costoPorLector[k];
        return k + ' ' + (c.ms / c.cuadros).toFixed(0) + ' ms (' + c.cuadros + ' cuadros)';
      }).join(' · ') || '—') + '\n' +
      'Lecturas: ' + lecturas.length + ' · sospechosas: ' + $('r-malas').textContent + ' · promedio ' + $('r-media').textContent + '\n\n' +
      lecturas.map(function (l) { return l.hora + '\t' + l.codigo + '\t' + l.desc + '\t' + l.ms + ' ms\t' + l.motor + '\t' + l.modo; }).join('\n');
    var listo = function () { $('copiado').textContent = 'Copiado. Pégalo en el chat.'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(listo, function () { prompt('Copia este texto:', texto); });
    } else {
      prompt('Copia este texto:', texto);
    }
  });

  document.addEventListener('visibilitychange', function () { if (document.hidden && activo) detener(); });
})();
