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

  /* A reload always starts at the top. Phones restore the old scroll position, and a menu tap
     leaves #section in the URL, so every refresh used to jump back into the middle of the page.
     Shared links to a section (#tasks, #compare...) still work on a first visit. */
  var navEntry = window.performance && performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
  if (navEntry && navEntry.type === 'reload') {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    window.scrollTo(0, 0);
    window.addEventListener('load', function () { window.scrollTo(0, 0); }, { once: true });
  }

  /* Phones may block muted autoplay (battery or data saver). Any tap retries the clips in view. */
  var retryOnGesture = [];
  ['pointerdown', 'touchend', 'keydown'].forEach(function (type) {
    window.addEventListener(type, function () { retryOnGesture.forEach(function (fn) { fn(); }); }, { passive: true });
  });

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
    video.muted = true; video.defaultMuted = true;
    video.playsInline = true; video.setAttribute('playsinline', '');
    cell.hidden = false;

    function render() {
      var playing = !video.paused && !video.ended;
      label.textContent = playing ? T.pause : T.play;
      setIcon(btn, playing ? 'pause' : 'play');
    }
    function tryPlay() {
      var p = video.play();
      /* AbortError only means a pause() or a fast scroll interrupted the start: keep trying.
         NotAllowedError means the browser blocks autoplay: show Play and wait for a tap. */
      if (p && p.catch) p.catch(function () { render(); });
    }
    retryOnGesture.push(function () { if (state.wants && state.inView && video.paused) tryPlay(); });

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

  /* Tasks tour: the feature list beside the clip follows its segments (data-segments, in seconds).
     timeupdate drives which label is current; a click on a label seeks the clip to that segment.
     Until the clip has played (always, with no JS; by default, with reduced motion) the list stays static. */
  function initTour(video) {
    var list = document.getElementById(video.getAttribute('data-tour'));
    var segs;
    try { segs = JSON.parse(video.getAttribute('data-segments') || '[]'); } catch (err) { return; }
    if (!list || !segs || !segs.length) return;
    var sheet = video.closest('.sheet');
    var toggle = sheet && sheet.querySelector('.clip-toggle');

    var bar = document.createElement('div');
    bar.className = 'tour__bar';
    bar.setAttribute('aria-hidden', 'true');
    var fills = segs.map(function (s) {
      var seg = document.createElement('span');
      seg.className = 'tour__seg';
      seg.style.flexGrow = String(Math.max(0.1, s.end - s.start));
      var fill = document.createElement('span');
      fill.className = 'tour__fill';
      seg.appendChild(fill);
      bar.appendChild(seg);
      return fill;
    });
    if (sheet) sheet.insertBefore(bar, sheet.querySelector('.sheet__cells'));

    var items = [];
    segs.forEach(function (s, i) {
      var li = list.querySelector('[data-seg="' + s.id + '"]');
      var label = li && li.querySelector('.tour__label');
      if (!label) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tour__btn';
      btn.setAttribute('aria-controls', video.id);
      label.parentNode.insertBefore(btn, label);
      btn.appendChild(label);
      btn.addEventListener('click', function () { seek(i); });
      items[i] = { li: li, btn: btn };
    });

    var engaged = false, current = -1, raf = 0;
    function indexAt(t) {
      for (var i = 0; i < segs.length; i++) if (t >= segs[i].start && t < segs[i].end) return i;
      return t >= segs[segs.length - 1].end ? segs.length - 1 : -1;
    }
    function setCurrent(i) {
      if (i === current) return;
      var prev = items[current];
      if (prev) { prev.li.classList.remove('is-current'); prev.btn.removeAttribute('aria-current'); }
      current = i;
      var next = items[i];
      if (next) { next.li.classList.add('is-current'); next.btn.setAttribute('aria-current', 'true'); }
    }
    function update() {
      var t = video.currentTime;
      fills.forEach(function (f, i) {
        var s = segs[i];
        var p = t >= s.end ? 1 : t <= s.start ? 0 : (t - s.start) / (s.end - s.start);
        f.style.transform = 'scaleX(' + p.toFixed(4) + ')';
      });
      if (engaged) setCurrent(indexAt(t));
    }
    /* Smooth fill while playing; with reduced motion the bar steps with timeupdate only. */
    function frame() { update(); raf = video.paused ? 0 : requestAnimationFrame(frame); }
    function seek(i) {
      engaged = true;
      video.currentTime = segs[i].start + 0.05;
      setCurrent(i);
      update();
      if (video.paused) { if (toggle) toggle.click(); else video.play(); }
    }

    video.addEventListener('timeupdate', update);
    video.addEventListener('seeked', update);
    video.addEventListener('play', function () {
      engaged = true;
      update();
      if (!reduce && !raf) raf = requestAnimationFrame(frame);
    });
    list.classList.add('tour--live');
  }
  Array.prototype.forEach.call(document.querySelectorAll('video[data-segments]'), initTour);

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
  /* Hero headline: after the draft-in, the last line cycles once through who the BIM opens to,
     then settles back on the real headline. Under 5 s, once, stops on any interaction,
     skipped under reduced motion. The real sentence lives in the h1's .sr-only text. */
  (function () {
    var el = document.querySelector('.swap[data-swap]');
    if (!el || reduce) return;
    var words;
    try { words = JSON.parse(el.getAttribute('data-swap')); } catch (e) { return; }
    if (!words || !words.length) return;
    var original = el.textContent;
    var seq = words.concat([original]);
    var i = 0, stopped = false, timer;
    function finish() {
      stopped = true; clearTimeout(timer);
      el.classList.remove('is-out', 'is-in'); el.textContent = original;
    }
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (type) {
      window.addEventListener(type, function () { if (!stopped) finish(); }, { once: true, passive: true });
    });
    function step() {
      if (stopped || i >= seq.length) return;
      if (document.hidden) { timer = setTimeout(step, 600); return; }
      el.classList.remove('is-in');
      el.classList.add('is-out');
      timer = setTimeout(function () {
        if (stopped) return;
        el.textContent = seq[i++];
        el.classList.remove('is-out');
        void el.offsetWidth;
        el.classList.add('is-in');
        if (i < seq.length) timer = setTimeout(step, 1150); else stopped = true;
      }, 210);
    }
    timer = setTimeout(step, 2300);
  })();

})();
