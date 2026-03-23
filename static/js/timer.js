function parseDuration(s) {
  var total = 0;
  var parts = s.match(/(\d+)\s*(h|m|s)/gi);
  if (!parts) return 0;
  parts.forEach(function (p) {
    var match = p.match(/(\d+)\s*(h|m|s)/i);
    if (!match) return;
    var val = parseInt(match[1], 10);
    var unit = match[2].toLowerCase();
    if (unit === 'h') total += val * 3600;
    else if (unit === 'm') total += val * 60;
    else total += val;
  });
  return total;
}

function formatTime(secs) {
  var h = Math.floor(secs / 3600);
  var m = Math.floor((secs % 3600) / 60);
  var s = secs % 60;
  if (h > 0) {
    return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  return m + ':' + String(s).padStart(2, '0');
}

function timerKey(widget) {
  var dur = widget.getAttribute('data-duration');
  var label = widget.getAttribute('data-label');
  return 'timer-' + location.pathname + '-' + dur + '-' + label;
}

function saveTimer(widget, endTime) {
  localStorage.setItem(timerKey(widget), String(endTime));
}

function clearTimerStorage(widget) {
  localStorage.removeItem(timerKey(widget));
}

function runTimer(widget, endTime) {
  var btn = widget.querySelector('.timer-add');
  var display = document.createElement('span');
  display.className = 'timer-running';

  var closeBtn = document.createElement('button');
  closeBtn.className = 'timer-close';
  closeBtn.textContent = '\u2715';

  var timeSpan = document.createElement('span');
  timeSpan.className = 'timer-time';

  display.appendChild(closeBtn);
  display.appendChild(timeSpan);

  btn.replaceWith(display);

  function tick() {
    var remaining = Math.round((endTime - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(interval);
      timeSpan.textContent = '0:00';
      display.classList.add('timer-done');
      clearTimerStorage(widget);
      try {
        if ('vibrate' in navigator) navigator.vibrate([200, 100, 200, 100, 200]);
      } catch (e) {}
      return;
    }
    timeSpan.textContent = formatTime(remaining);
  }

  tick();
  var interval = setInterval(tick, 1000);

  closeBtn.addEventListener('click', function () {
    clearInterval(interval);
    clearTimerStorage(widget);
    var newBtn = document.createElement('button');
    newBtn.className = 'timer-add';
    newBtn.textContent = '+ ' + widget.getAttribute('data-duration') + ' ' + widget.getAttribute('data-label') + ' timer';
    newBtn.onclick = function () { startTimer(newBtn); };
    display.replaceWith(newBtn);
  });
}

function startTimer(btn) {
  var widget = btn.parentElement;
  var duration = parseDuration(widget.getAttribute('data-duration'));
  if (duration <= 0) return;

  var endTime = Date.now() + duration * 1000;
  saveTimer(widget, endTime);
  runTimer(widget, endTime);
}

// Restore active timers on page load
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.timer-widget').forEach(function (widget) {
    var stored = localStorage.getItem(timerKey(widget));
    if (stored) {
      var endTime = parseInt(stored, 10);
      if (endTime > Date.now()) {
        runTimer(widget, endTime);
      } else {
        localStorage.removeItem(timerKey(widget));
      }
    }
  });
});
