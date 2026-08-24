'use strict';

(function () {
  function t(key, substitutions) {
    try {
      const s = chrome.i18n.getMessage(key, substitutions);
      return s || key;
    } catch (_) { return key; }
  }

  function uiLanguage() {
    try { return chrome.i18n.getUILanguage() || 'en'; }
    catch (_) { return 'en'; }
  }

  function apply(root) {
    const scope = root || document;
    document.documentElement.lang = /^ja(?:-|$)/i.test(uiLanguage()) ? 'ja' : 'en';
    scope.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.dataset.i18n);
    });
    scope.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.title = t(el.dataset.i18nTitle);
    });
    scope.querySelectorAll('[data-i18n-aria-label]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
    });
  }

  globalThis.MediaSniperI18n = { t: t, apply: apply, uiLanguage: uiLanguage };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { apply(document); });
  else apply(document);

  if (typeof module !== 'undefined' && module.exports) module.exports = { t: t };
})();
