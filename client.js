(function () {
  'use strict';

  var PASSWORD_KEY = 'chikochan-post-password';
  var HIDDEN_KEY = 'chikochan-hidden-posts';
  var preview = null;

  function storageGet(key, fallback) {
    try {
      var value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      // Private browsing modes can disable storage; posting still works.
    }
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
    if (preview) preview.remove();
    preview = null;
  }

  function showPreview(link, event) {
    var postId = link.dataset.postId;
    var source = document.getElementById('p' + postId);
    if (!source || link.closest('#p' + postId)) return;
    removePreview();
    preview = source.cloneNode(true);
    preview.removeAttribute('id');
    preview.querySelectorAll('[id]').forEach(function (node) { node.removeAttribute('id'); });
    preview.querySelectorAll('form, .report-control, .delete, .post-hide-button').forEach(function (node) { node.remove(); });
    preview.classList.add('quote-preview');
    document.body.appendChild(preview);
    var left = Math.min(event.clientX + 14, window.innerWidth - preview.offsetWidth - 8);
    var top = Math.min(event.clientY + 14, window.innerHeight - preview.offsetHeight - 8);
    preview.style.left = Math.max(4, left) + 'px';
    preview.style.top = Math.max(4, top) + 'px';
  }

  function hiddenIds() {
    try {
      var parsed = JSON.parse(storageGet(HIDDEN_KEY, '[]'));
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch (error) {
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

  function initializeCatalogFilter() {
    var input = document.getElementById('catalog-filter');
    if (!input) return;
    input.addEventListener('input', function () {
      var query = input.value.trim().toLowerCase();
      document.querySelectorAll('.catalog-card').forEach(function (card) {
        card.hidden = Boolean(query) && !card.dataset.catalogText.includes(query);
      });
    });
  }

  document.addEventListener('click', function (event) {
    var quoteLink = event.target.closest('[data-quote-id][data-thread-id]');
    if (quoteLink && quotePost(quoteLink.dataset.quoteId, quoteLink.dataset.threadId) === false) {
      event.preventDefault();
      return;
    }

    var imageLink = event.target.closest('.fileThumb');
    if (imageLink) {
      var box = imageLink.closest('.image-box');
      if (box && box.classList.contains('spoiler-image') && !box.classList.contains('spoiler-revealed')) {
        event.preventDefault();
        box.classList.add('spoiler-revealed');
        return;
      }
      event.preventDefault();
      imageLink.classList.toggle('expanded-image');
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
    if (button) {
      button.disabled = true;
      button.dataset.originalValue = button.value || button.textContent;
      if ('value' in button) button.value = 'Posting…';
      else button.textContent = 'Working…';
    }
  });

  document.addEventListener('DOMContentLoaded', function () {
    initializePasswords();
    initializeHiddenPosts();
    initializeCatalogFilter();
    highlightHash();
    var params = new URLSearchParams(window.location.search);
    var quoteId = params.get('quote') || params.get('q');
    var threadId = document.body.dataset.threadId;
    if (quoteId && threadId) quotePost(quoteId, threadId);
    document.dispatchEvent(new CustomEvent('chikochan:ready'));
  });

  window.addEventListener('hashchange', highlightHash);
}());
