(function () {
  'use strict';
  var theme;
  try { theme = localStorage.getItem('chikochan-theme'); } catch (_) {}
  if (!theme) {
    var cookie = document.cookie.match(/(?:^|; )chiko_theme=(light|dark|yotsuba-b)(?:;|$)/);
    theme = cookie ? cookie[1] : 'THEME_DEFAULT';
  }
  if (theme === 'dark' || theme === 'yotsuba-b') document.documentElement.setAttribute('data-theme', theme);
}());
