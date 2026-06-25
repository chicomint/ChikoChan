(function () {
  function quotePost(postId, threadId) {
    const details = document.getElementById('reply-form-' + threadId);
    if (details && details.tagName.toLowerCase() === 'details') {
      details.open = true;
    }

    const textarea = document.getElementById('reply-comment-' + threadId);
    if (!textarea) return true;

    const quoteText = '>>' + postId + '\n';
    if (textarea.value && !textarea.value.endsWith('\n')) {
      textarea.value += '\n';
    }
    textarea.value += quoteText;
    textarea.focus();
    location.hash = 'reply-form-' + threadId;
    return false;
  }

  document.addEventListener('click', function (event) {
    const link = event.target.closest('[data-quote-id][data-thread-id]');
    if (!link) return;
    if (quotePost(link.dataset.quoteId, link.dataset.threadId) === false) {
      event.preventDefault();
    }
  });

  document.addEventListener('DOMContentLoaded', function () {
    const params = new URLSearchParams(window.location.search);
    const quoteId = params.get('quote');
    const threadId = document.body.dataset.threadId;
    if (quoteId && threadId) {
      quotePost(quoteId, threadId);
    }
  });
}());
