(function () {
  'use strict';

  document.documentElement.classList.add('js-enabled');

  var PASSWORD_KEY = 'chikochan-post-password';
  var HIDDEN_KEY = 'chikochan-hidden-posts';
  var THEME_KEY = 'chikochan-theme';
  var chikoPreview = null;

  function normalizeTheme(theme) {
    return ['site', 'light', 'dark', 'yotsuba-b', 'miku'].includes(theme) ? theme : 'site';
  }

  function applyTheme(theme, remember) {
    var root = document.documentElement;
    theme = normalizeTheme(theme);
    if (remember) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
      document.cookie = 'chiko_theme=' + theme + '; Path=/; SameSite=Lax; Max-Age=31536000';
    }
    root.setAttribute('data-theme-choice', theme);
    var active = theme === 'site' ? root.getAttribute('data-default-theme') || 'light' : theme;
    if (active !== 'light') root.setAttribute('data-theme', active);
    else root.removeAttribute('data-theme');
    document.querySelectorAll('.theme-selector').forEach(function (select) {
      select.value = theme;
    });
  }

  document.addEventListener('change', function (event) {
    if (!event.target.matches('.theme-selector')) return;
    var theme = normalizeTheme(event.target.value);
    if (document.documentElement.hasAttribute('data-theme-preview')) { applyTheme(theme, false); return; }
    storageSet(THEME_KEY, theme);
    applyTheme(theme, true);
  });

  document.addEventListener('error', function (event) {
    if (event.target.matches && event.target.matches('.global-banner img')) event.target.closest('.global-banner').hidden = true;
  }, true);

  function initializeTheme() {
    var root = document.documentElement;
    var saved = root.getAttribute('data-theme-choice') || storageGet(THEME_KEY, 'site');
    if (root.hasAttribute('data-theme-preview')) saved = 'site';
    applyTheme(saved, false);
    document.querySelectorAll('.global-banner img').forEach(function (img) {
      if (img.complete && !img.naturalWidth) img.closest('.global-banner').hidden = true;
    });
  }

  var tinyPrefs = {};
  var preferenceSave = Promise.resolve();
  var preferencesLoaded = false;

  function storageGet(key, fallback) {
    return tinyPrefs[key] === undefined ? fallback : tinyPrefs[key];
  }

  function storageSet(key, value) {
    tinyPrefs[key] = value;
    if (!preferencesLoaded) return;
    var snapshot = JSON.stringify(tinyPrefs);
    preferenceSave = preferenceSave.then(function () {
      return fetch('/preferences', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: snapshot
      }).then(function (response) {
        if (!response.ok) throw new Error('Preferences could not be saved.');
        return true;
      });
    }).catch(function () { return false; });
  }

  async function loadPreferences() {
    try {
      var response = await fetch('/preferences', { cache: 'no-store' });
      if (!response.ok) return;
      var saved = await response.json();
      var editedWhileLoading = Object.keys(tinyPrefs).length > 0;
      tinyPrefs = Object.assign({}, saved.values, tinyPrefs);
      tinyPrefs[THEME_KEY] = normalizeTheme(document.documentElement.getAttribute('data-theme-choice') || tinyPrefs[THEME_KEY] || 'site');
      if (saved.fresh) {
        // Import this browser's old preferences once, then remove the local copy.
        for (var key of [PASSWORD_KEY, HIDDEN_KEY]) {
          try {
            var old = window.localStorage.getItem(key);
            if (old !== null && tinyPrefs[key] === undefined) tinyPrefs[key] = old;
          } catch (_) {}
        }
      }
      preferencesLoaded = true;
      if (saved.fresh || editedWhileLoading) {
        storageSet(THEME_KEY, normalizeTheme(storageGet(THEME_KEY, 'site')));
        if (!await preferenceSave) return;
      }
      for (var key of [PASSWORD_KEY, HIDDEN_KEY]) window.localStorage.removeItem(key);
    } catch { /* Storage is optional; use this page's in-memory defaults. */ }
  }

  function initializeNames() {
    try {
      var cookie = document.cookie.match(/(?:^|; )chiko_posted_name=([^;]*)/);
      if (cookie) {
        localStorage.setItem('chikochan-poster-name', decodeURIComponent(cookie[1]));
        document.cookie = 'chiko_posted_name=; Path=/; SameSite=Strict; Max-Age=0';
      }
      var name = localStorage.getItem('chikochan-poster-name') || '';
      document.querySelectorAll('form input[name="name"]').forEach(function (input) {
        if (!input.value) input.value = name;
      });
    } catch (_) {}
  }

  function randomPassword() {
    if (window.crypto && window.crypto.getRandomValues) {
      var bytes = new Uint8Array(12);
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, function (byte) { return byte.toString(36).padStart(2, '0'); }).join('').slice(0, 18);
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function initializePasswords() {
    var password = storageGet(PASSWORD_KEY, '');
    if (!password) {
      password = randomPassword();
      storageSet(PASSWORD_KEY, password);
    }
    document.querySelectorAll('.post-password').forEach(function (input) {
      if (!input.value) input.value = password;
      input.addEventListener('change', function () {
        if (input.value) {
          password = input.value;
          storageSet(PASSWORD_KEY, password);
          document.querySelectorAll('.post-password').forEach(function (other) {
            if (other !== input) other.value = password;
          });
        }
      });
    });
  }

  function selectedQuote() {
    var selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
    var node = selection.anchorNode && selection.anchorNode.parentElement;
    if (!node || !node.closest('.postMessage')) return '';
    return selection.toString().trim().split(/\r?\n/).map(function (line) { return '>' + line; }).join('\n');
  }

  function quotePost(postId, threadId) {
    var details = document.getElementById('reply-form-' + threadId);
    if (details && details.tagName.toLowerCase() === 'details') details.open = true;
    var textarea = document.getElementById('reply-comment-' + threadId);
    if (!textarea) return true;

    var addition = '>>' + postId + '\n';
    var quote = selectedQuote();
    if (quote) addition += quote + '\n';
    if (textarea.value && !textarea.value.endsWith('\n')) textarea.value += '\n';
    textarea.value += addition;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    history.replaceState(null, '', '#reply-form-' + threadId);
    return false;
  }

  function postContainer(postId) {
    var container = document.getElementById('pc' + postId) || document.getElementById('p' + postId);
    if (container && container.classList.contains('opContainer')) return container.closest('.thread') || container;
    return container;
  }

  function highlightHash() {
    document.querySelectorAll('.post-highlighted').forEach(function (post) {
      post.classList.remove('post-highlighted');
    });
    var match = window.location.hash.match(/^#p(\d+)$/);
    if (!match) return;
    var target = document.getElementById('p' + match[1]);
    if (target) target.classList.add('post-highlighted');
  }

  function removePreview() {
    if (chikoPreview) chikoPreview.remove();
    chikoPreview = null;
  }

  function showPreview(link, event) {
    var postId = link.dataset.postId;
    var source = document.getElementById('p' + postId);
    if (!source || link.closest('#p' + postId)) return;
    removePreview();
    chikoPreview = source.cloneNode(true);
    chikoPreview.removeAttribute('id');
    chikoPreview.querySelectorAll('[id]').forEach(function (node) { node.removeAttribute('id'); });
    chikoPreview.querySelectorAll('form, .post-menu, .delete, .post-hide-button').forEach(function (node) { node.remove(); });
    chikoPreview.querySelectorAll('.video-box').forEach(function (box) { collapseVideo(box); });
    chikoPreview.classList.add('quote-preview');
    document.body.appendChild(chikoPreview);
    var left = Math.min(event.clientX + 14, window.innerWidth - chikoPreview.offsetWidth - 8);
    var top = Math.min(event.clientY + 14, window.innerHeight - chikoPreview.offsetHeight - 8);
    chikoPreview.style.left = Math.max(4, left) + 'px';
    chikoPreview.style.top = Math.max(4, top) + 'px';
  }

  function hiddenIds() {
    try {
      var parsed = JSON.parse(storageGet(HIDDEN_KEY, '[]'));
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  function setPostHidden(postId, hidden, remember) {
    var container = postContainer(postId);
    if (!container) return;
    var oldPlaceholder = document.querySelector('[data-show-post="' + postId + '"]');
    if (oldPlaceholder) oldPlaceholder.remove();
    container.classList.toggle('post-hidden', hidden);
    if (hidden) {
      var placeholder = document.createElement('button');
      placeholder.type = 'button';
      placeholder.className = 'show-hidden-post';
      placeholder.dataset.showPost = postId;
      placeholder.textContent = '[Show hidden post No.' + postId + ']';
      container.insertAdjacentElement('afterend', placeholder);
    }
    if (remember) {
      var ids = hiddenIds().filter(function (id) { return id !== String(postId); });
      if (hidden) ids.push(String(postId));
      storageSet(HIDDEN_KEY, JSON.stringify(ids.slice(-300)));
    }
  }

  function initializeHiddenPosts() {
    hiddenIds().forEach(function (postId) { setPostHidden(postId, true, false); });
  }

  function updateExpandedMedia(attachments) {
    if (!attachments) return;
    var expanded = Boolean(attachments.querySelector('.expanded-image, .post-video'));
    attachments.classList.toggle('post-attachments-expanded', expanded);
    var post = attachments.closest('.post');
    if (post) post.classList.toggle('post-media-expanded', expanded);
  }

  function collapseVideo(box) {
    var video = box.querySelector('.post-video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.querySelectorAll('source').forEach(function (source) { source.remove(); });
      video.load();
      video.remove();
    }
    var attachment = box.closest('.post-attachment');
    var collapse = attachment && attachment.querySelector('[data-collapse-video]');
    if (collapse) collapse.remove();
    var link = box.querySelector('.video-preview');
    if (link) {
      link.hidden = false;
      link.setAttribute('aria-expanded', 'false');
    }
    box.classList.remove('video-revealed');
    if (attachment) attachment.classList.remove('post-attachment-expanded');
    updateExpandedMedia(box.closest('.post-attachments'));
  }

  document.addEventListener('click', function (event) {
    var quoteLink = event.target.closest('[data-quote-id][data-thread-id]');
    if (quoteLink && quotePost(quoteLink.dataset.quoteId, quoteLink.dataset.threadId) === false) {
      event.preventDefault();
      return;
    }

    var collapse = event.target.closest('[data-collapse-video]');
    if (collapse) {
      event.preventDefault();
      var videoBox = collapse.closest('.post-attachment').querySelector('.video-box');
      collapseVideo(videoBox);
      videoBox.querySelector('.video-preview').focus();
      return;
    }

    var videoLink = event.target.closest('.video-preview');
    if (videoLink) {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      var videoBox = videoLink.closest('.video-box');
      if (videoBox.classList.contains('spoiler-image') && !videoBox.classList.contains('spoiler-revealed')) {
        videoBox.classList.add('spoiler-revealed');
        var spoiler = videoBox.querySelector('[data-reveal-spoiler]');
        if (spoiler) spoiler.remove();
        return;
      }
      if (videoBox.querySelector('.post-video')) return;
      var video = document.createElement('video');
      video.className = 'post-video';
      video.controls = true;
      video.preload = 'none';
      video.playsInline = true;
      var poster = videoLink.querySelector('img');
      if (poster) video.poster = poster.src;
      var source = document.createElement('source');
      source.src = videoLink.dataset.videoSrc;
      source.type = videoLink.dataset.videoType;
      video.appendChild(source);
      var fallback = document.createElement('a');
      fallback.href = videoLink.href;
      fallback.textContent = 'Download video';
      video.appendChild(fallback);
      var fileInfo = videoBox.closest('.post-attachment').querySelector('.file-info');
      var closeLink = document.createElement('a');
      closeLink.href = '#' + fileInfo.id;
      closeLink.dataset.collapseVideo = '';
      closeLink.textContent = '[Close]';
      closeLink.setAttribute('aria-label', 'Close video');
      videoLink.hidden = true;
      videoLink.setAttribute('aria-expanded', 'true');
      videoBox.appendChild(video);
      fileInfo.appendChild(closeLink);
      videoBox.classList.add('video-revealed');
      videoBox.closest('.post-attachment').classList.add('post-attachment-expanded');
      updateExpandedMedia(videoBox.closest('.post-attachments'));
      closeLink.focus();
      return;
    }

    var imageLink = event.target.closest('.fileThumb');
    if (imageLink) {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      var box = imageLink.closest('.image-box');
      if (box && box.classList.contains('spoiler-image') && !box.classList.contains('spoiler-revealed')) {
        event.preventDefault();
        box.classList.add('spoiler-revealed');
        return;
      }
      event.preventDefault();
      var expanded = imageLink.classList.toggle('expanded-image');
      if (box) box.classList.toggle('image-expanded', expanded);
      var attachment = imageLink.closest('.post-attachment');
      if (attachment) attachment.classList.toggle('post-attachment-expanded', expanded);
      var attachments = imageLink.closest('.post-attachments');
      updateExpandedMedia(attachments);
      var image = imageLink.querySelector('[data-expand-image]');
      if (image) image.src = expanded ? image.dataset.fullSrc : image.dataset.thumbnailSrc;
      return;
    }

    var spoilerButton = event.target.closest('[data-reveal-spoiler]');
    if (spoilerButton) {
      var spoilerBox = spoilerButton.closest('.spoiler-image');
      if (spoilerBox) spoilerBox.classList.add('spoiler-revealed');
      spoilerButton.remove();
      return;
    }

    var hideButton = event.target.closest('[data-hide-post]');
    if (hideButton) {
      setPostHidden(hideButton.dataset.hidePost, true, true);
      return;
    }

    var showButton = event.target.closest('[data-show-post]');
    if (showButton) setPostHidden(showButton.dataset.showPost, false, true);
  });

  document.addEventListener('mouseover', function (event) {
    var link = event.target.closest('.quotelink, .backlink');
    if (link && !link.contains(event.relatedTarget)) showPreview(link, event);
  });

  document.addEventListener('mouseout', function (event) {
    var link = event.target.closest('.quotelink, .backlink');
    if (link && !link.contains(event.relatedTarget)) removePreview();
  });

  document.addEventListener('submit', function (event) {
    if (event.defaultPrevented) return;
    var confirmation = event.target.dataset.confirm;
    if (confirmation && !window.confirm(confirmation)) {
      event.preventDefault();
      return;
    }
    if (event.target.id === 'delete-form') {
      var selectedPost = Array.from(event.target.elements).some(function (control) {
        return control.name === 'postIds' && control.checked;
      });
      if (!selectedPost) {
        event.preventDefault();
        window.alert('Select at least one post first.');
        return;
      }
    }
    var button = event.target.querySelector('[type="submit"]');
    if (button && !button.name) {
      button.disabled = true;
      button.dataset.originalValue = button.value || button.textContent;
      if ('value' in button) button.value = 'Posting…';
      else button.textContent = 'Working…';
    }
  });


  function initializeNavSearch() {
    var forms = document.querySelectorAll('.nav-search');
    if (!forms.length) return;
    var dialog = document.createElement('dialog'); dialog.className = 'nav-search-dialog';
    dialog.setAttribute('aria-labelledby', 'search-dialog-title');
    dialog.innerHTML = '<div class="search-dialog-header"><h2 id="search-dialog-title">Search posts &amp; threads</h2><button type="button" aria-label="Close search">Close ×</button></div><div class="nav-search-results" aria-live="polite"></div>';
    document.body.appendChild(dialog);
    dialog.querySelector('button').addEventListener('click', function () { dialog.close(); });
    var serial = 0;
    forms.forEach(function (form) { form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var query = new URLSearchParams(new FormData(form)); query.set('format', 'json');
      if (!dialog.open) dialog.showModal();
      var results = dialog.querySelector('.nav-search-results'); results.textContent = 'Searching…';
      var request = ++serial;
      try {
        var response = await fetch('/search?' + query, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        var data = await response.json(); if (!response.ok) throw new Error(data.error || 'Search failed.');
        if (serial === request) results.innerHTML = data.html;
      } catch (error) { if (serial === request) results.textContent = error.message; }
    }); });
  }

  document.addEventListener('DOMContentLoaded', async function () {
    initializeNavSearch();
    initializeNames();
    initializeTheme();
    if (document.documentElement.hasAttribute('data-theme-preview')) { document.dispatchEvent(new CustomEvent('chikochan:ready')); return; }
    await loadPreferences();
    initializeTheme();
    initializePasswords();
    initializeHiddenPosts();
    highlightHash();
    var params = new URLSearchParams(window.location.search);
    var quoteId = params.get('quote') || params.get('q');
    var threadId = document.body.dataset.threadId;
    if (quoteId && threadId) quotePost(quoteId, threadId);
    document.dispatchEvent(new CustomEvent('chikochan:ready'));
  });

  window.addEventListener('hashchange', highlightHash);
}());
