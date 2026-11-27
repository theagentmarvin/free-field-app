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

  /* ---------- Phones: a shorter page ----------
     Below 768 px the reference material folds away and the four core steps become tabs. Nothing is
     removed: [data-more] blocks go into a "more" disclosure, the cost ledger becomes an accordion.
     At 768 px and up (or with no JS) the page is exactly the long-form original. */
  var ES = (root.lang || '').indexOf('es') === 0;
  var mqPhone = window.matchMedia('(max-width: 767px)');
  function icon(name, cls) {
    return '<svg class="icon ' + cls + '" aria-hidden="true" focusable="false"><use href="#i-' + name + '"/></svg>';
  }
  function onPhoneChange(fn) {
    fn(mqPhone.matches);
    if (mqPhone.addEventListener) mqPhone.addEventListener('change', function (e) { fn(e.matches); });
    else if (mqPhone.addListener) mqPhone.addListener(function (e) { fn(e.matches); });
  }

  /* [data-more]: consecutive siblings share one disclosure, labelled by the first one's value. */
  (function () {
    var groups = [], cur = null;
    Array.prototype.forEach.call(document.querySelectorAll('[data-more]'), function (el) {
      if (cur && cur.nodes[cur.nodes.length - 1].nextElementSibling === el) cur.nodes.push(el);
      else { cur = { nodes: [el], label: el.getAttribute('data-more') || (ES ? 'Ver detalles' : 'More details'), box: null }; groups.push(cur); }
    });
    if (!groups.length) return;
    onPhoneChange(function (phone) {
      groups.forEach(function (g) {
        if (phone && !g.box) {
          var d = document.createElement('details');
          d.className = 'more';
          d.innerHTML = '<summary><span>' + g.label + '</span>' + icon('plus', 'more__icon') + '</summary>';
          g.nodes[0].parentNode.insertBefore(d, g.nodes[0]);
          g.nodes.forEach(function (n) { d.appendChild(n); });
          g.box = d;
        } else if (!phone && g.box) {
          g.nodes.forEach(function (n) { g.box.parentNode.insertBefore(n, g.box); });
          g.box.parentNode.removeChild(g.box);
          g.box = null;
        }
      });
    });
  })();

  /* Cost ledger and "own it" rows: on phones each heading opens its paragraph. The key ledger cell stays open. */
  (function () {
    var cells = Array.prototype.filter.call(document.querySelectorAll('.ledger__cell, .own__row'), function (c) {
      return !c.classList.contains('ledger__cell--key') && c.querySelector('h3') && c.querySelector('p');
    });
    if (!cells.length) return;
    onPhoneChange(function (phone) {
      cells.forEach(function (c) {
        var d = c.querySelector(':scope > details');
        if (phone && !d) {
          var h = c.querySelector('h3'), p = c.querySelector('p');
          d = document.createElement('details');
          d.className = 'acc';
          var s = document.createElement('summary');
          s.appendChild(h);
          s.insertAdjacentHTML('beforeend', icon('plus', 'more__icon'));
          d.appendChild(s); d.appendChild(p);
          c.appendChild(d);
        } else if (!phone && d) {
          c.appendChild(d.querySelector('h3'));
          c.appendChild(d.querySelector('p'));
          c.removeChild(d);
        }
      });
    });
  })();

  /* Core loop: on phones the four steps become tabs over one panel instead of four stacked clips. */
  (function () {
    var list = document.querySelector('.core .details');
    if (!list) return;
    var steps = Array.prototype.slice.call(list.children);
    if (steps.length < 2) return;
    var bar = null, active = 0;
    function select(i, focus) {
      active = i;
      steps.forEach(function (li, k) {
        li.classList.toggle('is-active', k === i);
        var b = bar && bar.children[k];
        if (b) { b.setAttribute('aria-selected', k === i ? 'true' : 'false'); b.tabIndex = k === i ? 0 : -1; }
      });
      if (focus && bar) bar.children[i].focus();
    }
    onPhoneChange(function (phone) {
      if (phone && !bar) {
        bar = document.createElement('div');
        bar.className = 'steps';
        bar.setAttribute('role', 'tablist');
        bar.setAttribute('aria-label', ES ? 'Pasos' : 'Steps');
        steps.forEach(function (li, k) {
          var h = li.querySelector('h3');
          li.id = li.id || 'core-step-' + (k + 1);
          li.setAttribute('role', 'tabpanel');
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'steps__tab'; b.id = li.id + '-tab';
          b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', li.id);
          li.setAttribute('aria-labelledby', b.id);
          b.innerHTML = '<span class="steps__n" aria-hidden="true">' + (k + 1) + '</span><span class="steps__t"></span>';
          b.querySelector('.steps__t').textContent = h ? h.textContent : String(k + 1);
          b.addEventListener('click', function () { select(k); });
          bar.appendChild(b);
        });
        bar.addEventListener('keydown', function (e) {
          var n = steps.length, k = active;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') k = (active + 1) % n;
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') k = (active - 1 + n) % n;
          else if (e.key === 'Home') k = 0;
          else if (e.key === 'End') k = n - 1;
          else return;
          e.preventDefault(); select(k, true);
        });
        list.parentNode.insertBefore(bar, list);
        list.classList.add('is-tabbed');
        select(active);
      } else if (!phone && bar) {
        bar.parentNode.removeChild(bar); bar = null;
        list.classList.remove('is-tabbed');
        steps.forEach(function (li) { li.classList.remove('is-active'); li.removeAttribute('role'); li.removeAttribute('aria-labelledby'); });
      }
    });
  })();

  /* Section bar (below 1024 px, where the nav has no section links): where you are, how far down,
     and one tap to the section menu. Hidden over the hero and the index. */
  (function () {
    var nav = document.querySelector('.nav');
    var menu = document.querySelector('.nav__menu');
    if (!nav || !menu || !hasIO) return;
    var labels = {};
    Array.prototype.forEach.call(menu.querySelectorAll('a[href^="#"]'), function (a) {
      labels[a.getAttribute('href').slice(1)] = a.textContent.trim();
    });
    var bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'secbar';
    bar.hidden = true;
    bar.setAttribute('aria-label', ES ? 'Abrir el menú de secciones' : 'Open the section menu');
    bar.innerHTML = '<span class="secbar__label"></span><span class="secbar__hint">' + (ES ? 'Secciones' : 'Sections') + icon('menu', 'icon--sm') + '</span><span class="secbar__track" aria-hidden="true"><span class="secbar__fill"></span></span>';
    nav.appendChild(bar);
    var label = bar.querySelector('.secbar__label'), fill = bar.querySelector('.secbar__fill');
    var currentId = null;
    bar.addEventListener('click', function () {
      menu.open = true;
      var a = (currentId && menu.querySelector('.nav__panel a[href="#' + currentId + '"]')) || menu.querySelector('.nav__panel a');
      if (a) a.focus();
    });
    var quiet = { top: 1, index: 1 };
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var id = e.target.id;
        currentId = id;
        var text = labels[id] || e.target.getAttribute('data-label');
        if (quiet[id] || !text) { bar.hidden = true; root.classList.remove('has-secbar'); return; }
        label.textContent = text;
        bar.hidden = false; root.classList.add('has-secbar');
      });
    }, { rootMargin: '-30% 0px -65% 0px' });
    Array.prototype.forEach.call(document.querySelectorAll('main > section'), function (s) { spy.observe(s); });
    var ticking = false;
    function progress() {
      ticking = false;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      fill.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, window.scrollY / max) : 0).toFixed(4) + ')';
    }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(progress); } }, { passive: true });
    progress();
  })();

  /* Reveal: section headings are drafted on like the hero (a coral rule traces, the text inks in behind it),
     leads and index rows settle in. Once per element, only when it scrolls into view, skipped under
     reduced motion. Without JS or IntersectionObserver nothing is ever hidden. */
  (function () {
    if (reduce || !hasIO) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -10% 0px' });
    function watch(el, cls, delay) {
      el.classList.add(cls);
      if (delay) el.style.setProperty('--rv-d', delay + 'ms');
      io.observe(el);
    }
    Array.prototype.forEach.call(document.querySelectorAll('main > section:not(#top) h2'), function (h) { watch(h, 'rv-h'); });
    Array.prototype.forEach.call(document.querySelectorAll('main > section:not(#top) .lead, .core .intro, .problem__resolution'), function (p) { watch(p, 'rv-s', 260); });
    Array.prototype.forEach.call(document.querySelectorAll('.pick__item'), function (li, i) { watch(li, 'rv-s', 120 + i * 70); });
    window.addEventListener('beforeprint', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.rv-h, .rv-s'), function (el) { el.classList.add('is-in'); });
    });
  })();

})();
