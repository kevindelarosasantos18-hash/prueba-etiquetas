(function () {
  'use strict';

  var TAMANOS = {
    pequena: { ancho: 40, alto: 20, cols: 5, filas: 14, moduloMax: 0.30, altoBarras: 8, fNombre: 2.4, fCodigo: 2.2, fPrecio: 2.6 },
    mediana: { ancho: 50, alto: 25, cols: 4, filas: 11, moduloMax: 0.38, altoBarras: 10, fNombre: 2.8, fCodigo: 2.5, fPrecio: 3.2 },
    grande:  { ancho: 63, alto: 38, cols: 3, filas: 7,  moduloMax: 0.50, altoBarras: 15, fNombre: 3.4, fCodigo: 3.0, fPrecio: 4.2 }
  };
  var MODULO_MINIMO_RECOMENDADO = 0.25;
  var DENSIDADES_CALIBRACION = [0.20, 0.25, 0.30, 0.35, 0.40, 0.50];
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var $ = function (id) { return document.getElementById(id); };

  function textoEl(clase, texto, tamanoMm) {
    var d = document.createElement('div');
    d.className = clase;
    d.textContent = texto;
    d.style.fontSize = tamanoMm + 'mm';
    return d;
  }

  function eanValido(codigo) {
    if (!/^\d{13}$/.test(codigo)) return false;
    var suma = 0;
    for (var i = 0; i < 12; i++) suma += Number(codigo[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (suma % 10)) % 10 === Number(codigo[12]);
  }

  // Crea el SVG del código con un ancho de módulo exacto en milímetros.
  // Devuelve { svg, modulos } donde modulos incluye las zonas en blanco.
  function crearSvg(valor, formato) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    var margen = formato === 'EAN13' ? 11 : 10;
    JsBarcode(svg, valor, {
      format: formato, width: 1, height: 100, margin: margen,
      displayValue: false, background: '#ffffff', lineColor: '#000000', flat: true
    });
    var modulos = parseFloat(svg.getAttribute('width'));
    svg.setAttribute('viewBox', '0 0 ' + modulos + ' 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.transform = '';
    return { svg: svg, modulos: modulos };
  }

  function dimensionar(svg, modulos, moduloMm, altoMm) {
    svg.setAttribute('width', (modulos * moduloMm).toFixed(3) + 'mm');
    svg.setAttribute('height', altoMm + 'mm');
  }

  function nuevaHoja() {
    var h = document.createElement('div');
    h.className = 'hoja';
    $('vista').appendChild(h);
    return h;
  }

  function reglaDe50mm(hoja) {
    var r = document.createElement('div');
    r.className = 'regla';
    r.innerHTML = 'Esta línea debe medir 50 mm exactos:<div class="linea"></div>';
    hoja.appendChild(r);
  }

  // ---------- Hoja de calibración ----------
  function generarCalibracion() {
    var hoja = nuevaHoja();
    hoja.appendChild(textoEl('cal-titulo', 'Hoja de calibración — códigos Code 128', 4.5));
    var nota = textoEl('cal-nota', 'Cada fila usa un ancho de barra más fino que la siguiente. Escanea cada código con el celular y anota cuál es la fila más pequeña que se lee rápido y sin errores. Esa será la medida mínima para tus etiquetas. Imprime esta hoja en papel adhesivo mate y en adhesivo fotográfico y compara.', 3);
    hoja.appendChild(nota);

    var arriba = 32;
    DENSIDADES_CALIBRACION.forEach(function (dens, idx) {
      var fila = document.createElement('div');
      fila.className = 'cal-fila';
      fila.style.top = (arriba + idx * 38) + 'mm';

      var rot = document.createElement('div');
      rot.className = 'cal-rotulo';
      var mm = dens.toFixed(2).replace('.', ',');
      rot.innerHTML = 'Fila ' + (idx + 1) + '<small>barra de ' + mm + ' mm</small>';
      fila.appendChild(rot);

      for (var copia = 1; copia <= 3; copia++) {
        var codigo = '90' + String(Math.round(dens * 100)).padStart(2, '0') + String(copia).padStart(4, '0');
        var r = crearSvg(codigo, 'CODE128');
        dimensionar(r.svg, r.modulos, dens, 12);
        var item = document.createElement('div');
        item.className = 'cal-item';
        item.appendChild(r.svg);
        var t = document.createElement('div');
        t.textContent = codigo + ' · ' + (r.modulos * dens).toFixed(1).replace('.', ',') + ' mm de ancho';
        item.appendChild(t);
        fila.appendChild(item);
      }
      hoja.appendChild(fila);
    });
    reglaDe50mm(hoja);
    return '';
  }

  // ---------- Etiquetas de productos ----------
  function leerProductos() {
    var lineas = $('lista').value.split(/\r?\n/);
    var productos = [];
    var errores = [];
    var usados = {};
    var siguiente = 1;

    lineas.forEach(function (linea, i) {
      if (!linea.trim()) return;
      var partes = linea.split(';').map(function (p) { return p.trim(); });
      var nombre = partes[0];
      var precio = partes[1] ? Number(partes[1].replace(',', '.')) : null;
      var codigo = partes[2] || '';
      if (!nombre) { errores.push('Línea ' + (i + 1) + ': falta el nombre.'); return; }
      if (partes[1] && (isNaN(precio) || precio < 0)) { errores.push('Línea ' + (i + 1) + ': precio no válido.'); return; }
      if (codigo && !/^[\x20-\x7E]{1,40}$/.test(codigo)) { errores.push('Línea ' + (i + 1) + ': el código solo admite letras, números y símbolos básicos.'); return; }
      productos.push({ nombre: nombre, precio: precio, codigo: codigo });
      if (codigo) usados[codigo] = true;
    });

    productos.forEach(function (p) {
      if (p.codigo) return;
      var c;
      do { c = '20' + String(siguiente++).padStart(6, '0'); } while (usados[c]);
      usados[c] = true;
      p.codigo = c;
    });
    return { productos: productos, errores: errores };
  }

  function crearEtiqueta(p, t, verPrecio, verCorte) {
    var et = document.createElement('div');
    et.className = 'etiqueta' + (verCorte ? ' corte' : '');
    et.style.width = t.ancho + 'mm';
    et.style.height = t.alto + 'mm';

    var formato = eanValido(p.codigo) ? 'EAN13' : 'CODE128';
    var r = crearSvg(p.codigo, formato);
    var disponible = t.ancho - 2;
    var modulo = Math.min(t.moduloMax, disponible / r.modulos);
    dimensionar(r.svg, r.modulos, modulo, t.altoBarras);

    et.appendChild(textoEl('nombre', p.nombre, t.fNombre));
    et.appendChild(r.svg);
    et.appendChild(textoEl('codigo', p.codigo, t.fCodigo));
    if (verPrecio && p.precio !== null) {
      et.appendChild(textoEl('precio', '$' + p.precio.toFixed(2), t.fPrecio));
    }
    return { el: et, modulo: modulo };
  }

  function generarProductos() {
    var t = TAMANOS[$('tamano').value];
    var copias = Math.max(1, Math.min(200, parseInt($('copias').value, 10) || 1));
    var porHoja = t.cols * t.filas;
    var inicio = Math.max(1, Math.min(porHoja, parseInt($('inicio').value, 10) || 1));
    var verPrecio = $('ver-precio').checked;
    var verCorte = $('ver-corte').checked;

    var leido = leerProductos();
    if (leido.errores.length) return leido.errores.join(' ');
    if (!leido.productos.length) return 'Escribe al menos un producto.';

    var izquierda = (210 - t.cols * t.ancho) / 2;
    var arriba = (297 - t.filas * t.alto) / 2;
    var posicion = inicio - 1;
    var hoja = nuevaHoja();
    var finos = [];

    leido.productos.forEach(function (p) {
      for (var c = 0; c < copias; c++) {
        if (posicion >= porHoja) { hoja = nuevaHoja(); posicion = 0; }
        var res = crearEtiqueta(p, t, verPrecio, verCorte);
        var col = posicion % t.cols;
        var fila = Math.floor(posicion / t.cols);
        res.el.style.left = (izquierda + col * t.ancho) + 'mm';
        res.el.style.top = (arriba + fila * t.alto) + 'mm';
        hoja.appendChild(res.el);
        if (res.modulo < MODULO_MINIMO_RECOMENDADO && finos.indexOf(p.nombre) === -1) finos.push(p.nombre);
        posicion++;
      }
    });

    if (finos.length) {
      return 'Aviso: el código de "' + finos.join('", "') + '" es muy largo para este tamaño y salió con barras finas. Usa una etiqueta más grande.';
    }
    return '';
  }

  function generar() {
    $('vista').innerHTML = '';
    var aviso = $('modo').value === 'calibracion' ? generarCalibracion() : generarProductos();
    $('aviso').textContent = aviso || 'Listo. Revisa la vista previa y pulsa Imprimir.';
    $('aviso').className = 'estado ' + (aviso ? 'error' : 'ok');
  }

  $('modo').addEventListener('change', function () {
    $('panel-productos').classList.toggle('oculto', this.value !== 'productos');
    generar();
  });
  $('generar').addEventListener('click', generar);
  $('imprimir').addEventListener('click', function () { window.print(); });

  generar();
})();
