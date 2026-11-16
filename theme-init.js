(function () {
  'use strict';
  var root = document.documentElement;
  var choices = ['site', 'light', 'dark', 'yotsuba-b', 'miku'];
  var choice = 'THEME_PREFERENCE';
  var saved;
  try { saved = localStorage.getItem('chikochan-theme'); } catch (_) {}
  if (choices.includes(saved)) choice = saved;
  else {
    var cookie = document.cookie.match(/(?:^|; )chiko_theme=(site|light|dark|yotsuba-b|miku)(?:;|$)/);
    if (cookie) choice = cookie[1];
  }
  if (!choices.includes(choice) || root.hasAttribute('data-theme-preview')) choice = 'site';
  var theme = choice === 'site' ? root.getAttribute('data-default-theme') || 'light' : choice;
  root.setAttribute('data-theme-choice', choice);
  if (theme === 'dark' || theme === 'yotsuba-b' || theme === 'miku') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}());
