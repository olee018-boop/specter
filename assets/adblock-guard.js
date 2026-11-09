/* Aether ad-block guard
 * Locks the site while an ad blocker is stripping the Adsterra units.
 * Fails open: if data/ads.json cannot be read, no ads are enabled, or the
 * browser is offline, nothing is enforced.
 */
(function () {
  'use strict';

  if (window.top !== window.self) return; // never run inside game iframes

  var OVERLAY_ID = 'specter-adblock-overlay';
  var STYLE_ID = 'specter-adblock-style';
  var POLL_MS = 2500;
  var PROBE_TIMEOUT = 5000;
  var pollId = null;
  var busy = false;

  var CSS = [
    'html.specter-adblock, html.specter-adblock body { overflow: hidden !important; }',
    '#' + OVERLAY_ID + ' { position: fixed; inset: 0; z-index: 2147483000; display: flex;',
    '  align-items: center; justify-content: center; padding: 24px;',
    '  background: rgba(4, 7, 12, 0.94); backdrop-filter: blur(10px);',
    '  font-family: var(--font, "Courier New", monospace); color: #eaf4ff; }',
    '#' + OVERLAY_ID + ' .sab-card { max-width: 540px; width: 100%;',
    '  background: var(--card-bg, #0d131b); border: 1px solid var(--accent, #6ecbff);',
    '  border-radius: 16px; padding: 28px; text-align: center;',
    '  box-shadow: 0 0 60px rgba(110, 203, 255, 0.25); }',
    '#' + OVERLAY_ID + ' h2 { margin: 0 0 10px; font-size: 1.3rem; letter-spacing: 1px;',
    '  color: var(--accent, #6ecbff); text-transform: uppercase; }',
    '#' + OVERLAY_ID + ' p { margin: 0 0 14px; line-height: 1.55; font-size: 0.92rem; color: #b9c7d6; }',
    '#' + OVERLAY_ID + ' ol { text-align: left; margin: 0 auto 18px; padding-left: 22px;',
    '  color: #b9c7d6; font-size: 0.88rem; line-height: 1.7; max-width: 420px; }',
    '#' + OVERLAY_ID + ' button { font-family: inherit; font-size: 0.9rem; letter-spacing: 1px;',
    '  text-transform: uppercase; cursor: pointer; border-radius: 10px; padding: 12px 22px;',
    '  border: 1px solid var(--accent, #6ecbff); background: var(--accent, #6ecbff);',
    '  color: #04121d; font-weight: 700; transition: opacity 0.15s ease; }',
    '#' + OVERLAY_ID + ' button[disabled] { opacity: 0.55; cursor: wait; }',
    '#' + OVERLAY_ID + ' .sab-status { margin: 14px 0 0; font-size: 0.78rem; color: #7d8c9c; }'
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* Classic bait elements: filter lists hide anything named like an ad box. */
  function baitsHidden() {
    var baits = [
      'adsbox ad-placement ad-banner',
      'pub_300x250 pub_300x250m text-ad textAd',
      'ads adsbygoogle ad-slot-leaderboard'
    ];
    var hidden = false;
    baits.forEach(function (cls) {
      var el = document.createElement('div');
      el.className = cls;
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:absolute;left:-10000px;top:-10000px;width:300px;height:250px;';
      el.innerHTML = '&nbsp;';
      document.body.appendChild(el);
      var cs = getComputedStyle(el);
      if (el.offsetHeight === 0 || el.clientHeight === 0 || cs.display === 'none' || cs.visibility === 'hidden') {
        hidden = true;
      }
      el.remove();
    });
    return hidden;
  }

  /* Network probe: an ad host that a blocker drops rejects at the network layer. */
  function netProbe() {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve('unknown');
      }, PROBE_TIMEOUT);

      fetch('https://bauval.org/22/b1add1a27bf83c211614ecf3e77f43af?probe=' + Date.now(), {
        mode: 'no-cors',
        cache: 'no-store'
      }).then(function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve('allowed');
      }).catch(function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve('blocked');
      });
    });
  }

  function check() {
    if (navigator.onLine === false) {
      return Promise.resolve({ blocked: false, reason: 'offline' });
    }
    var bait = baitsHidden();
    return netProbe().then(function (net) {
      return { blocked: bait || net === 'blocked', bait: bait, network: net };
    });
  }

  /* Only enforce while there is actually an ad to lose. */
  function adsEnabled() {
    return fetch('data/ads.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (!cfg || cfg.enabled === false) return false;
        var live = function (group) {
          return Object.keys(group || {}).some(function (k) {
            var v = group[k];
            return v && v.enabled && (String(v.html || '').trim() || String(v.htmlFile || '').trim());
          });
        };
        return live(cfg.slots) || live(cfg.site);
      })
      .catch(function () { return false; });
  }

  function show() {
    ensureStyle();
    document.documentElement.classList.add('specter-adblock');
    if (document.getElementById(OVERLAY_ID)) return;

    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = [
      '<div class="sab-card">',
      '  <h2>Ad blocker detected</h2>',
      '  <p>Aether is free because the ads pay for it. An ad blocker is running, so the site is paused until it is switched off.</p>',
      '  <ol>',
      '    <li>Turn off your ad blocker for <strong>immcrab.github.io</strong>.</li>',
      '    <li>Or whitelist this site in your blocker\u2019s settings.</li>',
      '    <li>Reload, or press the button below.</li>',
      '  </ol>',
      '  <button type="button" id="sab-retry">I turned it off \u2014 check again</button>',
      '  <p class="sab-status" id="sab-status">Watching for ads\u2026</p>',
      '</div>'
    ].join('');

    document.body.appendChild(overlay);

    var btn = overlay.querySelector('#sab-retry');
    var status = overlay.querySelector('#sab-status');
    btn.addEventListener('click', function () {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      status.textContent = 'Checking\u2026';
      evaluate().then(function (res) {
        busy = false;
        btn.disabled = false;
        if (res.blocked) status.textContent = 'Still blocked \u2014 the ads are not loading yet.';
        else status.textContent = 'Ads are loading \u2014 welcome back.';
      });
    });
  }

  function hide() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();
    document.documentElement.classList.remove('specter-adblock');
    stopPolling();
  }

  function startPolling() {
    if (pollId !== null) return;
    pollId = setInterval(function () { evaluate(); }, POLL_MS);
  }

  function stopPolling() {
    if (pollId === null) return;
    clearInterval(pollId);
    pollId = null;
  }

  function evaluate() {
    return check().then(function (res) {
      if (res.blocked) {
        show();
        startPolling();
      } else {
        hide();
      }
      return res;
    });
  }

  function boot() {
    adsEnabled().then(function (on) {
      if (!on) return;
      evaluate();
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && document.getElementById(OVERLAY_ID)) evaluate();
  });

  // Test hook: window.specterAdBlock.enforce() re-runs detection.
  window.specterAdBlock = { check: check, enforce: evaluate, enabled: adsEnabled };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
