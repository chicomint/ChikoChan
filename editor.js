(function () {
  'use strict';
  var root = document.getElementById('homepage-editor');
  if (!root) return;
  var state = JSON.parse(document.getElementById('editor-initial-state').value);
  var layout = structuredClone(state.draft);
  layout.pageBackground ||= {};
  layout.defaultTheme ||= 'light';
  var defaults = JSON.parse(document.getElementById('editor-default-layout').value);
  var selected = layout.sections[0].id;
  var undo = [], redo = [], viewport = 'desktop', timer, pending = 0, dirty = false, busy = false, uploadsPending = 0;
  var frame = document.getElementById('editor-canvas');
  var inspector = document.getElementById('editor-inspector');
  var status = document.getElementById('editor-status');
  var titles = { banner: 'Banner', welcome: 'Welcome', news: 'News', activeThreads: 'Active Threads', boards: 'Boards', latestImages: 'Latest Images', latestPosts: 'Latest Posts', statistics: 'Statistics', footer: 'Footer', image: 'Image', text: 'Text', html: 'HTML' };

  function notify(message, error) { status.textContent = message; status.classList.toggle('admin-error', Boolean(error)); }
  function target(id) {
    if (id === 'navigation') return { style: layout.navigation };
    if (id === 'page-background') return { style: layout.pageBackground };
    return layout.sections.find(function (section) { return section.id === id; });
  }
  function current() { return target(selected); }
  function remember() { undo.push(JSON.stringify(layout)); if (undo.length > 60) undo.shift(); redo = []; dirty = true; }
  function update() { pending++; drawOutline(); clearTimeout(timer); timer = setTimeout(renderPreview, 350); }
  async function api(path, data) {
    var response = await fetch(path, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(Object.assign({ csrf: root.dataset.csrf }, data)) });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(result.error || 'The request failed. Reload if your staff session expired.');
    return result;
  }

  function drawOutline() {
    document.getElementById('editor-default-theme').value = layout.defaultTheme;
    var list = document.getElementById('editor-outline');
    list.replaceChildren();
    layout.sections.forEach(function (section) {
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button'; button.className = 'editor-section-select'; button.textContent = '⠿ ' + (section.title || titles[section.type]) + (section.hidden ? ' (hidden)' : '');
      button.setAttribute('aria-pressed', String(selected === section.id));
      button.addEventListener('click', function () { select(section.id); });
      item.draggable = true;
      item.addEventListener('dragstart', function (event) { event.dataTransfer.setData('text/plain', section.id); });
      item.addEventListener('dragover', function (event) { event.preventDefault(); });
      item.addEventListener('drop', function (event) { event.preventDefault(); move(event.dataTransfer.getData('text/plain'), section.id); });
      var remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'editor-section-remove'; remove.textContent = '×';
      remove.setAttribute('aria-label', 'Remove ' + (section.title || titles[section.type]));
      remove.title = 'Remove section'; remove.disabled = layout.sections.length <= 1;
      remove.addEventListener('click', function () { removeSection(section.id); });
      item.append(button, remove); list.appendChild(item);
    });
    root.querySelector('[data-editor-action="undo"]').disabled = !undo.length;
    root.querySelector('[data-editor-action="redo"]').disabled = !redo.length;
  }

  function select(id) {
    selected = id;
    var section = current();
    inspector.hidden = !section;
    var global = id === 'navigation' || id === 'page-background';
    document.getElementById('editor-selected-title').textContent = id === 'page-background' ? 'Page background' : id === 'navigation' ? 'Navigation bar' : section ? (section.title || titles[section.type]) : 'Select a section';
    document.getElementById('editor-reset-background').hidden = id !== 'page-background';
    if (!section) return;
    var appearance = inspector.querySelector('details');
    appearance.querySelector('summary').textContent = id === 'page-background' ? 'Background picture & colors' : 'Section appearance';
    if (id === 'page-background') appearance.open = true;
    document.getElementById('editor-content-label').textContent = section.type === 'image' ? 'Alternative text' : 'Content / Markdown / safe HTML';
    var imagePreview = document.getElementById('editor-image-preview');
    imagePreview.hidden = !section.image;
    if (section.image) imagePreview.src = section.image; else imagePreview.removeAttribute('src');
    inspector.querySelectorAll('[data-setting]').forEach(function (input) {
      var parts = input.dataset.setting.split('.');
      var value = parts.length === 2 ? section[parts[0]]?.[parts[1]] : section[parts[0]];
      var wrapper = input.closest('label');
      var backgroundKeys = ['background', 'gradientEnd', 'image', 'size', 'position', 'repeat', 'overlay', 'overlayColor'];
      wrapper.hidden = global && (parts[0] !== 'style' || id === 'page-background' && !backgroundKeys.includes(parts[1]));
      if (input.type === 'checkbox') input.checked = value === true;
      else input.value = value === undefined ? '' : value;
    });
    inspector.querySelectorAll('fieldset,details,.editor-section-actions,.editor-upload').forEach(function (element) {
      element.hidden = global && (element.classList.contains('editor-upload') ? element.querySelector('[data-upload-target]')?.dataset.uploadTarget !== 'style.image' : !element.matches('details') || Boolean(element.querySelector('[data-setting^="header."]')));
    });
    drawOutline(); highlight();
  }

  function highlight() {
    if (!frame.contentDocument) return;
    frame.contentDocument.querySelectorAll('[data-section]').forEach(function (section) { section.classList.toggle('editor-selected', section.dataset.section === selected); });
  }

  function move(id, target) {
    var from = layout.sections.findIndex(function (section) { return section.id === id; });
    var to = layout.sections.findIndex(function (section) { return section.id === target; });
    if (from < 0 || to < 0 || from === to) return;
    remember(); clearPositions(); var section = layout.sections.splice(from, 1)[0]; layout.sections.splice(to, 0, section); selected = id; update();
  }

  function resizeCanvas() {
    if (!frame.contentDocument?.body) return;
    var width = viewport === 'desktop' ? 1280 : viewport === 'tablet' ? 768 : 390;
    var available = root.querySelector('.editor-center').clientWidth - 36;
    var scale = Math.min(1, Math.max(0.2, available / width));
    frame.style.width = width + 'px';
    frame.style.transform = 'scale(' + scale + ')';
    var height = Math.max(900, frame.contentDocument.body.scrollHeight + 50);
    frame.style.height = height + 'px';
    var wrap = root.querySelector('.editor-canvas-wrap');
    wrap.style.width = width * scale + 'px'; wrap.style.height = height * scale + 'px';
  }

  function removeSection(id) {
    var index = layout.sections.findIndex(function (section) { return section.id === id; });
    if (index < 0 || layout.sections.length <= 1) return;
    remember(); var removed = layout.sections.splice(index, 1)[0];
    layout.sections.forEach(function (section) { Object.values(section.positions || {}).forEach(function (position) { if (position.anchor === id) { delete position.anchor; delete position.offset; } }); });
    if (selected === id) selected = layout.sections[Math.min(index, layout.sections.length - 1)].id;
    select(selected); update(); notify((removed.title || titles[removed.type]) + ' removed. Undo restores it.');
  }

  function clearPositions() {
    layout.sections.forEach(function (section) { if (section.positions) delete section.positions[viewport]; });
  }

  function applyGeometry() {
    var host = frame.contentDocument?.querySelector('.home-layout');
    if (!host || !frame.contentWindow.ChikoHomeLayout) return [];
    host.dataset.homeLayout = JSON.stringify({ gap: layout.gap, sections: layout.sections.map(function (section) { return { id: section.id, desktop: section.desktop, tablet: section.tablet, mobile: section.mobile, positions: section.positions || {} }; }) });
    var bounds = frame.contentWindow.ChikoHomeLayout.refresh(host, { force: true });
    resizeCanvas(); return bounds;
  }

  function captureGeometry(bounds) {
    var boxes = bounds || applyGeometry();
    boxes.forEach(function (box) {
      var section = layout.sections.find(function (item) { return item.id === box.id; });
      if (!section) return;
      var anchor = boxes.filter(function (other) {
        return other.id !== box.id && other.y + other.height <= box.y + 0.5
          && other.x < box.x + box.span - 0.01 && other.x + other.span > box.x + 0.01;
      }).sort(function (a, b) { return b.y + b.height - a.y - a.height; })[0];
      section.positions ||= {};
      section.positions[viewport] = { x: Math.round(box.x * 100) / 100, y: Math.round(box.y) };
      if (anchor) {
        section.positions[viewport].anchor = anchor.id;
        section.positions[viewport].offset = Math.max(0, Math.round(box.y - anchor.y - anchor.height));
      }
    });
  }

  function alignToDefault() {
    remember(); captureGeometry();
    var standard = new Map(defaults.sections.map(function (section, index) { return [section.type, { section: section, index: index }]; }));
    var ordered = layout.sections.filter(function (section) { return standard.has(section.type); }).sort(function (a, b) { return standard.get(a.type).index - standard.get(b.type).index; });
    ordered.forEach(function (section) { section[viewport] = standard.get(section.type).section[viewport]; delete section.positions[viewport]; });
    layout.sections = layout.sections.map(function (section) { return standard.has(section.type) ? ordered.shift() : section; });
    select(selected); update(); notify('Original widths and row alignment restored for ' + viewport + '. Pictures and content are kept.');
  }

  function snapPosition(host, bounds, start, x, y, span) {
    if (!document.getElementById('editor-snap').checked) return { x: x, y: y };
    var unit = (host.clientWidth + layout.gap) / 12, width = span * unit - layout.gap, left = x * unit;
    var horizontal = [0, (12 - span) * unit], vertical = [0, start.y];
    for (var column = 0; column <= 12; column++) if (column <= 12 - span) horizontal.push(column * unit);
    bounds.forEach(function (box) {
      if (box.id === start.id) return;
      var otherLeft = box.x * unit;
      horizontal.push(otherLeft, otherLeft + box.width - width, otherLeft + box.width + layout.gap, otherLeft - width - layout.gap);
      vertical.push(box.y, box.y + box.height + layout.gap, box.y + box.height - start.height);
    });
    function nearest(value, candidates) { return candidates.filter(function (candidate) { return candidate >= 0 && Math.abs(candidate - value) <= 10; }).sort(function (a, b) { return Math.abs(a - value) - Math.abs(b - value); })[0]; }
    var snapX = nearest(left, horizontal), snapY = nearest(y, vertical);
    host.querySelectorAll('.editor-snap-guide').forEach(function (guide) { guide.remove(); });
    [['vertical', snapX], ['horizontal', snapY]].forEach(function (item) {
      if (item[1] === undefined) return;
      var guide = host.ownerDocument.createElement('div'); guide.className = 'editor-snap-guide snap-' + item[0];
      guide.style[item[0] === 'vertical' ? 'left' : 'top'] = item[1] + 'px'; host.appendChild(guide);
    });
    return { x: Math.max(0, Math.min(12 - span, snapX === undefined ? x : snapX / unit)), y: snapY === undefined ? y : snapY };
  }

  function startPointerEdit(event, node, resizing) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    clearTimeout(timer); pending++;
    select(node.dataset.section);
    var section = current(), bounds = applyGeometry();
    var start = bounds.find(function (box) { return box.id === section.id; });
    if (!start) return;
    var control = event.currentTarget, host = node.parentElement;
    var unit = (host.clientWidth + layout.gap) / 12;
    var startX = event.clientX, startY = event.clientY, changed = false;
    host.dataset.layoutDragging = '1';
    control.setPointerCapture(event.pointerId);
    function onMove(move) {
      var dx = move.clientX - startX, dy = move.clientY - startY;
      if (!changed && Math.abs(dx) + Math.abs(dy) < 3) return;
      if (!changed) { remember(); captureGeometry(bounds); changed = true; node.classList.add('editor-dragging'); }
      if (resizing) {
        var span = Math.max(1, Math.min(12 - start.x, start.span + dx / unit));
        if (document.getElementById('editor-snap').checked && Math.abs(span - Math.round(span)) * unit < 8) span = Math.round(span);
        section[viewport] = Math.round(span * 100) / 100;
        section.style.height = Math.max(0, Math.min(1600, Math.round(start.height + dy)));
        node.style.width = Math.max(1, section[viewport] * unit - layout.gap) + 'px';
        node.style.minHeight = section.style.height + 'px';
        if (section.type === 'image' && node.querySelector('img')) node.querySelector('img').style.height = section.style.height + 'px';
      } else {
        var point = snapPosition(host, bounds, start, Math.max(0, Math.min(12 - section[viewport], start.x + dx / unit)), Math.max(0, Math.min(100000, start.y + dy)), section[viewport]);
        section.positions[viewport] = { x: Math.round(point.x * 100) / 100, y: Math.round(point.y) };
        node.style.left = section.positions[viewport].x * unit + 'px'; node.style.top = section.positions[viewport].y + 'px';
      }
    }
    function finish() {
      control.removeEventListener('pointermove', onMove); control.removeEventListener('pointerup', finish); control.removeEventListener('pointercancel', finish);
      node.classList.remove('editor-dragging'); delete host.dataset.layoutDragging;
      host.querySelectorAll('.editor-snap-guide').forEach(function (guide) { guide.remove(); });
      if (!changed) return;
      captureGeometry(); select(selected); update();
    }
    control.addEventListener('pointermove', onMove); control.addEventListener('pointerup', finish); control.addEventListener('pointercancel', finish);
  }

  function previewTheme(doc) {
    doc.documentElement.setAttribute('data-default-theme', layout.defaultTheme);
    doc.documentElement.setAttribute('data-theme-choice', 'site');
    if (layout.defaultTheme === 'light') doc.documentElement.removeAttribute('data-theme');
    else doc.documentElement.setAttribute('data-theme', layout.defaultTheme);
    doc.querySelectorAll('.theme-selector').forEach(function (select) { select.value = 'site'; });
  }

  function attachCanvas() {
    var doc = frame.contentDocument;
    doc.body.classList.add('editor-preview');
    previewTheme(doc);
    doc.querySelectorAll('.home-section').forEach(function (section) {
      section.querySelector('.section-edit-controls')?.remove(); section.querySelector('.section-resize')?.remove();
      var controls = doc.createElement('div'); controls.className = 'section-edit-controls';
      var handle = doc.createElement('button'); handle.type = 'button'; handle.className = 'section-move'; handle.textContent = '⠿ Move'; handle.setAttribute('aria-label', 'Move ' + section.dataset.sectionType);
      handle.addEventListener('pointerdown', function (event) { startPointerEdit(event, section, false); });
      handle.addEventListener('keydown', function (event) {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); select(section.dataset.section); remember(); captureGeometry();
        var item = current(), position = item.positions[viewport], step = event.shiftKey ? 40 : 10;
        delete position.anchor; delete position.offset;
        var unit = (section.parentElement.clientWidth + layout.gap) / 12;
        position.x = Math.max(0, Math.min(12 - item[viewport], position.x + (event.key === 'ArrowLeft' ? -step / unit : event.key === 'ArrowRight' ? step / unit : 0)));
        position.y = Math.max(0, Math.min(100000, position.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0)));
        captureGeometry(); update();
      });
      var remove = doc.createElement('button'); remove.type = 'button'; remove.className = 'section-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove ' + section.dataset.sectionType);
      remove.disabled = layout.sections.length <= 1;
      remove.addEventListener('click', function (event) { event.stopPropagation(); removeSection(section.dataset.section); });
      controls.append(handle, remove); section.prepend(controls);
      section.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); select(section.dataset.section); });
      var resize = doc.createElement('button'); resize.type = 'button'; resize.className = 'section-resize'; resize.textContent = '◢'; resize.setAttribute('aria-label', 'Resize section (or use width and height settings)');
      resize.addEventListener('pointerdown', function (event) { startPointerEdit(event, section, true); });
      section.appendChild(resize);
    });
    if (!doc.body.dataset.editorAttached) {
      doc.body.dataset.editorAttached = '1';
      doc.addEventListener('click', function (event) { if (event.target.closest('a,form')) event.preventDefault(); }, true);
      doc.addEventListener('submit', function (event) { event.preventDefault(); }, true);
      doc.addEventListener('chiko:layout', resizeCanvas);
    }
    highlight(); applyGeometry();
    doc.querySelectorAll('img').forEach(function (img) { img.addEventListener('load', function () { applyGeometry(); }, { once: true }); });
  }

  async function renderPreview() {
    var serial = ++pending;
    try {
      var result = await api('/admin/customization/preview', { layout: layout });
      if (serial !== pending) return;
      var doc = frame.contentDocument;
      if (!doc || !doc.body) return;
      doc.querySelector('.home-layout')?.remove();
      doc.body.insertAdjacentHTML('beforeend', result.html);
      var oldNav = doc.querySelector('.utility-nav');
      if (oldNav) { oldNav.insertAdjacentHTML('beforebegin', result.navigation); oldNav.remove(); }
      var sheet = doc.getElementById('editor-layout-style').sheet;
      while (sheet.cssRules.length) sheet.deleteRule(0);
      result.css.split('\n').filter(Boolean).forEach(function (rule) { sheet.insertRule(rule, sheet.cssRules.length); });
      attachCanvas();
    } catch (error) { notify(error.message, true); }
  }

  function setSetting(path, value, sectionId) {
    sectionId ||= selected;
    var section = target(sectionId);
    if (!section) return false;
    var parts = path.split('.');
    var old = parts.length === 2 ? section[parts[0]]?.[parts[1]] : section[parts[0]];
    if (old === value || (parts.length === 2 && old === undefined && value === '')) return;
    remember();
    if (parts.length === 2) {
      if (value === '') delete section[parts[0]][parts[1]];
      else section[parts[0]][parts[1]] = value;
    } else section[parts[0]] = value;
    if ((path === 'image' || path.endsWith('.image')) && selected === sectionId) select(selected);
    update(); return true;
  }

  inspector.addEventListener('change', function (event) {
    var input = event.target;
    if (!input.dataset.setting) return;
    setSetting(input.dataset.setting, input.type === 'checkbox' ? input.checked : input.type === 'number' && input.value !== '' ? Number(input.value) : input.value);
  });
  root.querySelectorAll('input[type="file"]').forEach(function (input) {
    input.addEventListener('change', async function () {
      if (!input.files[0]) return;
      var selectedAtStart = selected;
      notify('Validating and screening the image…'); input.disabled = true; uploadsPending++;
      try {
        var body = new FormData(); body.append('upfile', input.files[0]);
        var response = await fetch('/admin/assets', { method: 'POST', headers: { 'X-CSRF-Token': root.dataset.csrf, Accept: 'application/json' }, body: body, redirect: 'error' });
        var result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Upload failed.');
        if (setSetting(input.dataset.uploadTarget, result.path, selectedAtStart) === false) notify('The image uploaded, but its section was removed. Image path: ' + result.path);
        else notify('Image uploaded. Save or publish the layout to keep this change.');
      } catch (error) { notify(error.message, true); }
      finally { input.disabled = false; input.value = ''; uploadsPending--; }
    });
  });

  function versions() {
    var list = document.getElementById('editor-versions'); list.replaceChildren();
    state.savedLayouts.concat(state.history.slice().reverse()).forEach(function (item) { var option = document.createElement('option'); option.value = item.id; option.textContent = item.label + ' · ' + new Date(item.at).toLocaleString(); list.appendChild(option); });
  }

  root.addEventListener('click', async function (event) {
    var add = event.target.closest('[data-add-section]');
    if (add) {
      if (layout.sections.length >= 30) { notify('A homepage can have at most 30 sections.', true); return; }
      var anchor = current();
      if (!anchor || !anchor.id) anchor = layout.sections.find(function (item) { return item.type === 'boards'; }) || layout.sections[layout.sections.length - 1];
      var bounds = applyGeometry(), box = bounds.find(function (item) { return item.id === anchor.id; });
      remember(); captureGeometry(bounds);
      var section = { id: 'image-' + crypto.randomUUID().slice(0, 8), type: 'image', title: 'Picture', hidden: false, content: '', image: '', link: '', desktop: 5, tablet: 6, mobile: 12, positions: {}, style: {}, header: {} };
      section[viewport] = box ? box.span : 5;
      if (box) section.positions[viewport] = { x: Math.round(box.x * 100) / 100, y: Math.round(box.y + box.height + layout.gap), anchor: box.id, offset: layout.gap };
      var index = layout.sections.indexOf(anchor); layout.sections.splice(index + 1, 0, section);
      select(section.id); update(); notify('Picture added below ' + (anchor.title || titles[anchor.type]) + '. Upload an image, then drag it into place.'); return;
    }
    if (event.target.closest('[data-select-page-background]')) { select('page-background'); return; }
    if (event.target.closest('[data-select-navigation]')) { select('navigation'); return; }
    var device = event.target.closest('[data-viewport]');
    if (device && device.tagName === 'BUTTON') {
      viewport = device.dataset.viewport;
      root.querySelector('.editor-canvas-wrap').dataset.viewport = viewport;
      root.querySelectorAll('button[data-viewport]').forEach(function (button) { button.setAttribute('aria-pressed', String(button === device)); });
      setTimeout(resizeCanvas, 50); return;
    }
    var button = event.target.closest('[data-editor-action]'); if (!button || busy) return;
    var action = button.dataset.editorAction;
    if (['save', 'publish', 'snapshot', 'reset-background'].includes(action) && uploadsPending) { notify('Wait for image uploads to finish first.', true); return; }
    if (action === 'reset-background') { remember(); layout.pageBackground = {}; select('page-background'); update(); notify('Page background reset to the current theme. Save or publish to keep it.'); return; }
    if (action === 'arrange') { alignToDefault(); return; }
    if (action === 'undo' || action === 'redo') {
      var from = action === 'undo' ? undo : redo, to = action === 'undo' ? redo : undo;
      if (!from.length) return; to.push(JSON.stringify(layout)); layout = JSON.parse(from.pop()); dirty = true; select(selected); update(); return;
    }
    if (action === 'preview') {
      var previewWindow = window.open('/admin/customization/preview', '_blank');
      if (!previewWindow) { notify('Allow the preview window to open, then try again.', true); return; }
      try {
        var result = await api('/admin/customization/preview', { layout: layout });
        function showPreview() {
          var doc = previewWindow.document;
          doc.querySelector('.home-layout')?.remove(); doc.body.insertAdjacentHTML('beforeend', result.html);
          var nav = doc.querySelector('.utility-nav'); if (nav) { nav.insertAdjacentHTML('beforebegin', result.navigation); nav.remove(); }
          var sheet = doc.getElementById('editor-layout-style').sheet;
          while (sheet.cssRules.length) sheet.deleteRule(0);
          result.css.split('\n').filter(Boolean).forEach(function (rule) { sheet.insertRule(rule, sheet.cssRules.length); });
          previewTheme(doc);
          previewWindow.ChikoHomeLayout?.refresh(doc.querySelector('.home-layout'));
          previewWindow.opener = null;
        }
        if (previewWindow.document.readyState === 'complete' && previewWindow.location.pathname === '/admin/customization/preview') showPreview();
        else previewWindow.addEventListener('load', showPreview, { once: true });
      } catch (error) { previewWindow.close(); notify(error.message, true); }
      return;
    }
    if (['up', 'down', 'remove'].includes(action)) {
      var index = layout.sections.findIndex(function (item) { return item.id === selected; }); if (index < 0) return;
      if (action === 'remove') removeSection(selected);
      else { var target = layout.sections[index + (action === 'up' ? -1 : 1)]; if (target) move(selected, target.id); } return;
    }
    if (action === 'reset' && !window.confirm('Reset the draft to the default homepage? The published page stays as it is until you publish.')) return;
    busy = true; button.disabled = true;
    try {
      var submitted = JSON.stringify(layout);
      var result = await api('/admin/customization/layout', { action: action, layout: layout, revision: state.revision, label: document.getElementById('editor-layout-name').value, id: document.getElementById('editor-versions').value });
      if (action === 'reset' || action === 'restore') remember();
      var changedWhileSaving = !['reset', 'restore'].includes(action) && JSON.stringify(layout) !== submitted;
      state = result.homepage;
      if (!changedWhileSaving) layout = structuredClone(state.draft);
      dirty = changedWhileSaving;
      document.getElementById('editor-gap').value = layout.gap; document.getElementById('editor-width').value = layout.maxWidth;
      versions(); select(selected); update();
      notify(changedWhileSaving ? 'Saved. Newer edits are still unsaved in this window.' : action === 'publish' ? 'Published. Your homepage is live.' : 'Draft saved. The public homepage uses the published version.');
    } catch (error) { notify(error.message, true); }
    finally { busy = false; button.disabled = false; }
  });
  document.getElementById('editor-default-theme').addEventListener('change', function (event) { remember(); layout.defaultTheme = event.target.value; update(); notify('Default theme changed in the draft. Publish to apply it site-wide.'); });
  ['editor-gap', 'editor-width'].forEach(function (id) { document.getElementById(id).addEventListener('change', function (event) { remember(); layout[id === 'editor-gap' ? 'gap' : 'maxWidth'] = Number(event.target.value); update(); }); });
  frame.addEventListener('load', function () { attachCanvas(); });
  window.addEventListener('beforeunload', function (event) { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('change', function (event) { if (event.target.matches('.theme-selector')) setTimeout(renderPreview, 0); });
  window.addEventListener('resize', resizeCanvas);
  versions(); select(selected);
}());
