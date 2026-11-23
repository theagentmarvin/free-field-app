/* FreeField landing page: progressive enhancement only. The page is complete without this file. */
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');
  var T = (root.lang || '').indexOf('es') === 0
    ? { pause: 'Pausar', play: 'Reproducir', copy: 'Copiar', copied: 'Copiado', copiedSr: 'Comandos copiados al portapapeles.', press: 'Presiona Ctrl+C', pressSr: 'Comandos seleccionados. Presiona Ctrl+C para copiar.' }
    : { pause: 'Pause', play: 'Play clip', copy: 'Copy', copied: 'Copied', copiedSr: 'Commands copied to the clipboard.', press: 'Press Ctrl+C', pressSr: 'Commands selected. Press Ctrl+C to copy.' };

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasIO = 'IntersectionObserver' in window;

  function setIcon(btn, name) {
    var use = btn.querySelector('use');
    if (use) use.setAttribute('href', '#i-' + name);
  }

  /* Start clips only after the page has loaded, so video bytes never compete with fonts and the hero poster. */
  function whenLoaded(fn) {
    if (document.readyState === 'complete') fn();
    else window.addEventListener('load', fn, { once: true });
  }

  /* Clips: play in view, pause out of view; a visible Play/Pause toggle per clip (WCAG 2.2.2). */
  function initClip(video) {
    var cell = video.closest('figure') && video.closest('figure').querySelector('.cell--control');
    if (!cell) return;
    var btn = cell.querySelector('.clip-toggle');
    var label = btn.querySelector('.clip-toggle__label');
    var state = { wants: !reduce, inView: false };

    video.removeAttribute('controls');
    cell.hidden = false;

    function render() {
      var playing = !video.paused && !video.ended;
      label.textContent = playing ? T.pause : T.play;
      setIcon(btn, playing ? 'pause' : 'play');
    }
    function tryPlay() {
      var p = video.play();
      if (p && p.catch) p.catch(function () { state.wants = false; render(); });
    }

    video.addEventListener('play', render);
    video.addEventListener('pause', render);
    render();

    btn.addEventListener('click', function () {
      if (video.paused) { state.wants = true; tryPlay(); }
      else { state.wants = false; video.pause(); }
    });

    if (!hasIO) { if (state.wants) tryPlay(); return; }
    whenLoaded(function () { new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        state.inView = e.isIntersecting;
        if (state.inView && state.wants) tryPlay();
        else if (!state.inView && !video.paused) video.pause();
      });
    }, { threshold: 0.35 }).observe(video); });
  }
  Array.prototype.forEach.call(document.querySelectorAll('video[data-autoplay]'), initClip);

  /* Copy buttons on code blocks. */
  Array.prototype.forEach.call(document.querySelectorAll('.code'), function (block) {
    var btn = block.querySelector('.code__copy');
    var code = block.querySelector('code');
    var status = block.querySelector('.code__status');
    var label = btn && btn.querySelector('.code__copy-label');
    if (!btn || !code) return;
    btn.hidden = false;
    var timer;
    function show(text, icon, announce) {
      label.textContent = text;
      setIcon(btn, icon);
      if (status) status.textContent = announce;
      clearTimeout(timer);
      timer = setTimeout(function () {
        label.textContent = T.copy; setIcon(btn, 'copy'); if (status) status.textContent = '';
      }, 2000);
    }
    function selectCode() {
      var range = document.createRange();
      range.selectNodeContents(code);
      var sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
    }
    btn.addEventListener('click', function () {
      var text = code.textContent.split(/\r?\n/).map(function (l) { return l.replace(/^\$ /, ''); }).join('\n').trim();
      if (!navigator.clipboard || !navigator.clipboard.writeText) { selectCode(); show(T.press, 'copy', T.pressSr); return; }
      navigator.clipboard.writeText(text).then(
        function () { show(T.copied, 'check', T.copiedSr); },
        function () { selectCode(); show(T.press, 'copy', T.pressSr); }
      );
    });
  });

  /* Mobile menu: close on link click and on Escape. */
  var menu = document.querySelector('.nav__menu');
  if (menu) {
    var summary = menu.querySelector('summary');
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) menu.open = false;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.open) { menu.open = false; summary.focus(); }
    });
    menu.addEventListener('focusout', function (e) {
      if (menu.open && e.relatedTarget && !menu.contains(e.relatedTarget)) menu.open = false;
    });
  }

  /* Current section in the nav. */
  if (hasIO) {
    var links = {};
    Array.prototype.forEach.call(document.querySelectorAll('.nav__link[href^="#"]'), function (a) {
      links[a.getAttribute('href').slice(1)] = a;
    });
    var current = null;
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        if (current) current.removeAttribute('aria-current');
        current = links[e.target.id] || null;
        if (current) current.setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    Array.prototype.forEach.call(document.querySelectorAll('main > section'), function (s) { spy.observe(s); });
  }
})();
