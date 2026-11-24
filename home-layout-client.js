(function () {
  'use strict';
  var observed = new WeakMap();
  var latest = new WeakMap();

  function device() { return innerWidth <= 600 ? 'mobile' : innerWidth <= 960 ? 'tablet' : 'desktop'; }
  function read(host) {
    try { return JSON.parse(host.dataset.homeLayout); } catch { return null; }
  }
  function overlaps(a, b, gap) {
    return a.left < b.left + b.width - 0.5 && a.left + a.width - 0.5 > b.left
      && a.top < b.top + b.height + gap - 0.5 && a.top + a.height + gap - 0.5 > b.top;
  }

  function refresh(host, options) {
    if (!host) return [];
    if (host.dataset.layoutDragging === '1' && !options?.force) return latest.get(host) || [];
    var config = read(host);
    if (!config) return [];
    var view = device(), gap = Number(config.gap) || 0;
    var children = Array.from(host.children).filter(function (node) { return node.matches('.home-section'); });
    var sections = new Map(config.sections.map(function (section) { return [section.id, section]; }));
    var free = Boolean(options?.force || document.body.classList.contains('editor-preview') || config.sections.some(function (section) { return section.positions?.[view]; }));
    if (!free) {
      host.classList.remove('home-layout-free'); host.style.removeProperty('height');
      children.forEach(function (node) { ['left', 'top', 'width'].forEach(function (property) { node.style.removeProperty(property); }); });
      var rect = host.getBoundingClientRect();
      var unit = (host.clientWidth + gap) / 12;
      return children.map(function (node) {
        var box = node.getBoundingClientRect();
        return { id: node.dataset.section, x: (box.left - rect.left) / unit, y: box.top - rect.top, width: box.width, height: box.height, span: Number(sections.get(node.dataset.section)?.[view] || 12) };
      });
    }

    host.classList.add('home-layout-free');
    var unit = (host.clientWidth + gap) / 12;
    if (unit <= 0) return [];
    var column = 0, top = 0, rowHeight = 0;
    var items = children.map(function (node, index) {
      var section = sections.get(node.dataset.section);
      var span = Math.max(1, Math.min(12, Number(section?.[view]) || 12));
      var width = Math.max(1, span * unit - gap);
      node.style.width = width + 'px';
      var height = node.offsetHeight;
      var position = section?.positions?.[view];
      if (!position && column + span > 12.01) { column = 0; top += rowHeight + gap; rowHeight = 0; }
      var item = { position: position, node: node, id: node.dataset.section, index: index, span: span, width: width, height: height,
        left: Math.max(0, Math.min(12 - span, position ? Number(position.x) : column)) * unit,
        top: position ? Number(position.y) : top };
      if (!position) { column += span; rowHeight = Math.max(rowHeight, height); }
      return item;
    });
    // Resolve collisions using measured content, so growing threads or loaded
    // images cannot overlap a picture placed in another section's empty space.
    items.sort(function (a, b) { return a.top - b.top || a.left - b.left || a.index - b.index; });
    var placed = [], byId = new Map(items.map(function (item) { return [item.id, item]; }));
    function place(item, visiting) {
      if (placed.includes(item) || visiting.has(item.id)) return;
      visiting.add(item.id);
      var anchor = byId.get(item.position?.anchor);
      if (anchor && !visiting.has(anchor.id)) {
        place(anchor, visiting);
        item.top = anchor.top + anchor.height + (Number(item.position.offset) || 0);
      }
      for (var attempt = 0; attempt <= placed.length; attempt++) {
        var collisions = placed.filter(function (other) { return overlaps(item, other, gap); });
        if (!collisions.length) break;
        item.top = Math.max.apply(null, collisions.map(function (other) { return other.top + other.height + gap; }));
      }
      item.node.style.left = item.left + 'px'; item.node.style.top = item.top + 'px';
      placed.push(item); visiting.delete(item.id);
    }
    items.forEach(function (item) { place(item, new Set()); });
    host.style.height = Math.max(0, ...placed.map(function (item) { return item.top + item.height; })) + 'px';
    var bounds = placed.map(function (item) { return { id: item.id, x: item.left / unit, y: item.top, width: item.width, height: item.height, span: item.span }; });
    latest.set(host, bounds);
    observe(host, children);
    host.dispatchEvent(new CustomEvent('chiko:layout'));
    return bounds;
  }

  function observe(host, children) {
    var entry = observed.get(host);
    if (!entry) {
      entry = { scheduled: false };
      entry.observer = new ResizeObserver(function () {
        if (entry.scheduled) return;
        entry.scheduled = true;
        requestAnimationFrame(function () { entry.scheduled = false; if (host.isConnected) refresh(host); });
      });
      observed.set(host, entry);
      entry.observer.observe(host);
    }
    children.forEach(function (node) { entry.observer.observe(node); });
  }

  function initialize() { document.querySelectorAll('[data-home-layout]').forEach(function (host) { refresh(host); }); }
  document.addEventListener('click', function (event) {
    var button = event.target.closest('.home-activeThreads [data-thread-sort]');
    if (!button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (button.getAttribute('aria-current') === 'true') return;
    if (!document.documentElement.hasAttribute('data-theme-preview')) history.replaceState(null, '', button.href);
    var section = button.closest('.home-activeThreads');
    var sort = button.dataset.threadSort;
    section.querySelectorAll('[data-thread-sort]').forEach(function (control) {
      control.setAttribute('aria-current', String(control === button));
    });
    section.querySelectorAll('[data-thread-list]').forEach(function (list) {
      list.hidden = list.dataset.threadList !== sort;
    });
  }, true);
  document.documentElement.classList.add('home-layout-ready');
  window.ChikoHomeLayout = { refresh: refresh, bounds: function (host) { return latest.get(host) || refresh(host); }, device: device };
  window.addEventListener('resize', initialize);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
}());
