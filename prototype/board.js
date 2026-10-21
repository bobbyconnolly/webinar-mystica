/* board.js — the notice board overlay. Lists a board item's notes newest first and lets you pin
 * one. Draws whatever state it was last given; pinning goes out through `send` as {op:'note', text}
 * and the new state comes back as an item message.
 */
var BOARD = (function () {
  'use strict';
  var el, listEl, textEl, itemId = null, st = null, isOpen = false, send = null, onClose = null, ro = false;
  function init(opts) {
    send = opts.send; onClose = opts.onClose;
    el = document.getElementById('board'); listEl = el.querySelector('.notes'); textEl = el.querySelector('textarea');
    el.querySelector('[data-op=pin]').addEventListener('click', pin);
    el.querySelector('[data-op=close]').addEventListener('click', hide);
    textEl.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Escape') hide(); if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); pin(); } });
  }
  function pin() {
    var text = textEl.value.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return;
    send({ op: 'note', text: text });
    textEl.value = '';
  }
  function show(id, state) { itemId = id; st = state; isOpen = true; el.hidden = false; render(); textEl.focus(); }
  function update(id, state) { if (!isOpen || id !== itemId) return; st = state; render(); }
  function hide() { if (!isOpen) return; isOpen = false; el.hidden = true; textEl.blur(); if (onClose) onClose(itemId); }
  function when(at) {
    var d = Date.now() - at, m = Math.round(d / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }
  function readOnly(on) { ro = !!on; if (!el) return; textEl.hidden = ro; el.querySelector('[data-op=pin]').hidden = ro; } // the event: boards can be read, not written
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function render() {
    if (!st) return;
    listEl.innerHTML = st.notes.length
      ? st.notes.map(function (n) { return '<div class="note"><div class="note-text">' + esc(n.text) + '</div><div class="note-by">' + esc(n.name || 'someone') + ' · ' + when(n.at) + '</div></div>'; }).join('')
      : '<div class="note empty">Nothing pinned here yet.</div>';
    if (ro) listEl.innerHTML += '<div class="note empty">The boards are read-only today.</div>';
  }
  return { init: init, show: show, update: update, hide: hide, readOnly: readOnly, isOpen: function () { return isOpen; }, itemId: function () { return itemId; } };
})();
