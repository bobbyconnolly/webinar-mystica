/* chess.js — the 2D board that opens when a player uses the chessboard item.
 *
 * Draws whatever state it was last given; it never predicts. Moves go out through `send` as
 * {op:'move', from, to} / {op:'turn'} / {op:'back'} / {op:'reset'} / {op:'stand'} / {op:'sit'} and the
 * new state comes back. Turns are a courtesy: the board says who is to move and what moved, and
 * either seated player may pass the turn or take one back; it never stops a move.
 * Cell index = rank * 8 + file (0 = a1). White sits at the bottom unless I hold the black seat.
 */
var CHESS = (function () {
  'use strict';
  var GLYPH = { wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
                bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟' };
  var el, cellsEl, cellBtns = [], itemId = null, st = null, me = null, selected = null, isOpen = false;
  var send = null, onClose = null, nameOf = null;

  function init(opts) {
    send = opts.send; onClose = opts.onClose; nameOf = opts.nameOf;
    el = document.getElementById('chess');
    cellsEl = el.querySelector('.cells');
    for (var i = 0; i < 64; i++) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'cell';
      b.addEventListener('click', onCell); cellBtns.push(b);
    }
    el.querySelector('[data-op=sit]').addEventListener('click', function () { send({ op: 'sit' }); });
    el.querySelector('[data-op=stand]').addEventListener('click', function () { send({ op: 'stand' }); });
    el.querySelector('[data-op=reset]').addEventListener('click', function () { send({ op: 'reset' }); });
    el.querySelector('[data-op=turn]').addEventListener('click', function () { send({ op: 'turn' }); });
    el.querySelector('[data-op=back]').addEventListener('click', function () { send({ op: 'back' }); });
    el.querySelector('[data-op=redo]').addEventListener('click', function () { send({ op: 'redo' }); });
    el.querySelector('[data-op=close]').addEventListener('click', hide);
  }
  function show(id, state, myId) { itemId = id; st = state; me = myId; selected = null; isOpen = true; el.hidden = false; render(); }
  function update(id, state) { if (!isOpen || id !== itemId) return; st = state; if (selected !== null && !st.cells[selected]) selected = null; render(); }
  function hide() { if (!isOpen) return; isOpen = false; el.hidden = true; selected = null; if (onClose) onClose(itemId); }
  function seat() { return st ? (st.seats.w === me ? 'w' : st.seats.b === me ? 'b' : null) : null; }
  function onCell(ev) {
    var i = +ev.currentTarget.dataset.i;
    if (!seat()) return;
    if (selected === null) { if (st.cells[i]) selected = i; }
    else { if (i !== selected) send({ op: 'move', from: selected, to: i }); selected = null; }
    render();
  }
  function label(pid) { if (pid === null || pid === undefined) return 'empty seat'; var n = nameOf ? nameOf(pid) : ''; return n || ('player ' + pid); }
  function sq(i) { return 'abcdefgh'[i % 8] + (Math.floor(i / 8) + 1); }
  function side(s) { return s === 'w' ? 'White' : 'Black'; }
  function moveList(ms) { return ms.map(function (m) { return sq(m.from) + '\u2013' + sq(m.to); }).join(', '); }
  // the moves worth showing: this turn's, or, before anyone has moved, the previous turn's
  function shownMoves() {
    if (st.turnMoves && st.turnMoves.length) return { moves: st.turnMoves, turn: st.turn, current: true };
    var h = st.history && st.history.length ? st.history[st.history.length - 1] : null;
    if (h) return { moves: h.moves, turn: h.turn, current: false };
    if (st.lastMove) return { moves: [st.lastMove], turn: st.turn === 'w' ? 'b' : 'w', current: false }; // a game from before turns: the other side moved last
    return { moves: [], turn: st.turn, current: true };
  }
  function render() {
    if (!st) return;
    var mine = seat(), flip = mine === 'b', shown = shownMoves(), fromSet = {}, toSet = {};
    shown.moves.forEach(function (m) { fromSet[m.from] = true; toSet[m.to] = true; });
    // the grid is filled top row first; rank 8 at the top for white, rank 1 for black
    cellsEl.textContent = '';
    for (var row = 0; row < 8; row++) for (var col = 0; col < 8; col++) {
      var rank = flip ? row : 7 - row, file = flip ? 7 - col : col, i = rank * 8 + file, b = cellBtns[i];
      b.dataset.i = i;
      b.className = 'cell ' + ((rank + file) % 2 ? 'light' : 'dark') +
        (selected === i ? ' sel' : '') + (toSet[i] ? ' last' : fromSet[i] ? ' from' : '');
      var p = st.cells[i];
      b.textContent = p ? GLYPH[p] : '';
      b.classList.toggle('white', !!p && p[0] === 'w');
      b.classList.toggle('black', !!p && p[0] === 'b');
      b.disabled = !mine;
      cellsEl.appendChild(b);
    }
    el.querySelector('.seat-w').textContent = 'White: ' + label(st.seats.w);
    el.querySelector('.seat-b').textContent = 'Black: ' + label(st.seats.b);
    el.querySelector('.tray-w').textContent = st.trays.w.map(function (p) { return GLYPH[p]; }).join(' ');
    el.querySelector('.tray-b').textContent = st.trays.b.map(function (p) { return GLYPH[p]; }).join(' ');
    var free = st.seats.w === null || st.seats.b === null;
    el.querySelector('[data-op=sit]').hidden = !!mine || !free;
    el.querySelector('[data-op=stand]').hidden = !mine;
    var reset = el.querySelector('[data-op=reset]');
    reset.hidden = !mine;
    if (mine) {
      var other = mine === 'w' ? 'b' : 'w';
      reset.textContent = st.resetVote[mine] ? 'Waiting for the other player' : st.resetVote[other] ? 'Confirm reset' : 'Reset';
      reset.disabled = !!st.resetVote[mine];
    }
    var turnEl = el.querySelector('.turn'), toMove = st.turn || 'w';
    turnEl.textContent = side(toMove) + ' to move' + (mine === toMove ? ' (that is you)' : '');
    turnEl.classList.toggle('mine', mine === toMove);
    var movedEl = el.querySelector('.moved');
    movedEl.textContent = !shown.moves.length ? (st.history && st.history.length ? 'Nothing moved yet this turn.' : 'No moves yet.')
      : (shown.current ? 'This turn, ' + side(shown.turn) + ': ' : 'Last turn, ' + side(shown.turn) + ': ') + moveList(shown.moves);
    var turnBtn = el.querySelector('[data-op=turn]'), backBtn = el.querySelector('[data-op=back]'), redoBtn = el.querySelector('[data-op=redo]');
    turnBtn.hidden = !mine; backBtn.hidden = !mine; redoBtn.hidden = !mine;
    if (mine) {
      turnBtn.textContent = 'Done: ' + side(toMove === 'w' ? 'b' : 'w') + "'s turn";
      var canUndo = st.turnMoves && st.turnMoves.length, canBack = st.history && st.history.length;
      backBtn.textContent = canUndo ? 'Undo this turn' : 'Back a turn';
      backBtn.disabled = !canUndo && !canBack;
      redoBtn.disabled = !(st.redo && st.redo.length);
    }
    el.querySelector('.status').textContent = mine ? 'You play ' + (mine === 'w' ? 'white' : 'black') + '. Honour rules.'
      : free ? 'Take a seat to play.' : 'Watching.';
  }
  return { init: init, show: show, update: update, hide: hide, isOpen: function () { return isOpen; }, itemId: function () { return itemId; } };
})();
