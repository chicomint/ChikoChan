(function () {
  'use strict';
  var root = document.getElementById('news-editor'); if (!root) return;
  var articles = JSON.parse(document.getElementById('news-initial-state').value);
  var form = document.getElementById('news-form'), article, busy = false;
  var status = document.getElementById('news-status');
  function notify(message) { status.textContent = message; }
  async function api(path, data) {
    var response = await fetch(path, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(Object.assign({ csrf: root.dataset.csrf }, data)) });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(result.error || 'Request failed.'); return result;
  }
  function drawList() {
    var list = document.getElementById('news-list'); list.replaceChildren();
    articles.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; }).forEach(function (item) {
      var li = document.createElement('li'), button = document.createElement('button'); button.type = 'button'; button.textContent = item.title + ' (' + item.status + ')'; button.addEventListener('click', function () { load(item); }); li.appendChild(button); list.appendChild(li);
    });
  }
  function drawImages() {
    var container = document.getElementById('news-images'); container.replaceChildren();
    article.images.forEach(function (image, index) {
      var fieldset = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = 'Image ' + (index + 1); fieldset.appendChild(legend);
      ['src', 'caption', 'alt', 'link'].forEach(function (key) {
        var label = document.createElement('label'), input = document.createElement('input'); label.textContent = { src: 'Image path', caption: 'Caption (Markdown)', alt: 'Alternative text', link: 'Optional link' }[key]; input.type = 'text'; input.value = image[key] || ''; input.addEventListener('change', function () { image[key] = input.value; }); label.appendChild(input); fieldset.appendChild(label);
      });
      var remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove image'; remove.addEventListener('click', function () { article.images.splice(index, 1); drawImages(); }); fieldset.appendChild(remove); container.appendChild(fieldset);
    });
  }
  function load(item) {
    article = structuredClone(item || { title: '', author: 'ChikoChan', content: '', status: 'draft', publishedAt: Date.now(), images: [] });
    ['title', 'author', 'content', 'status'].forEach(function (key) { form.elements[key].value = article[key]; });
    var date = new Date(article.publishedAt || Date.now()); form.elements.publishedAt.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('news-delete').disabled = !article.id;
    document.getElementById('news-preview').hidden = true; drawImages(); notify('');
  }
  function read() {
    ['title', 'author', 'content', 'status'].forEach(function (key) { article[key] = form.elements[key].value; });
    article.publishedAt = new Date(form.elements.publishedAt.value).getTime(); return article;
  }
  form.addEventListener('submit', async function (event) {
    event.preventDefault(); if (busy) return; busy = true;
    try { var result = await api('/admin/news/save', { article: read() }); var index = articles.findIndex(function (item) { return item.id === result.article.id; }); if (index < 0) articles.push(result.article); else articles[index] = result.article; load(result.article); drawList(); notify(result.article.status === 'draft' ? 'Draft saved.' : result.article.publishedAt > Date.now() ? 'Article saved for the selected publication date.' : 'Article published.'); }
    catch (error) { notify(error.message); } finally { busy = false; }
  });
  document.getElementById('news-new').addEventListener('click', function () { load(); });
  document.getElementById('news-add-image').addEventListener('click', function () { if (article.images.length < 12) { article.images.push({ src: '', caption: '', alt: '', link: '' }); drawImages(); } });
  document.getElementById('news-preview-button').addEventListener('click', async function () {
    try { var result = await api('/admin/news/preview', { article: read() }); var preview = document.getElementById('news-preview'); preview.innerHTML = result.html; preview.hidden = false; preview.scrollIntoView({ block: 'start' }); } catch (error) { notify(error.message); }
  });
  document.getElementById('news-delete').addEventListener('click', async function () {
    if (!article.id || busy || !window.confirm('Delete this news article?')) return;
    busy = true;
    try { await api('/admin/news/delete', { id: article.id }); articles = articles.filter(function (item) { return item.id !== article.id; }); drawList(); load(); notify('Article deleted.'); } catch (error) { notify(error.message); } finally { busy = false; }
  });
  document.getElementById('news-upload').addEventListener('change', async function (event) {
    var input = event.target; if (!input.files[0] || article.images.length >= 12) return;
    input.disabled = true; notify('Validating and screening image…');
    try {
      var body = new FormData(); body.append('upfile', input.files[0]);
      var response = await fetch('/admin/assets', { method: 'POST', headers: { 'X-CSRF-Token': root.dataset.csrf, Accept: 'application/json' }, body: body, redirect: 'error' }); var result = await response.json(); if (!response.ok) throw new Error(result.error || 'Upload failed.'); article.images.push({ src: result.path, caption: '', alt: '', link: '' }); drawImages(); notify('Image uploaded. Save the article to include it.');
    } catch (error) { notify(error.message); } finally { input.disabled = false; input.value = ''; }
  });
  drawList(); load();
}());
