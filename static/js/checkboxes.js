function initCheckboxes(recipeId) {
  var stored = JSON.parse(localStorage.getItem('cb-' + recipeId) || '{}');
  var content = document.querySelector('.recipe-content');
  if (!content) return;

  // Find all h2s that indicate "no checkboxes from here down"
  var skipIds = ['notes'];
  var skipEls = new Set();
  content.querySelectorAll('h2').forEach(function (h) {
    var text = h.textContent.toLowerCase();
    if (text.indexOf('note') !== -1) {
      // Walk all siblings after this h2 until the next h2
      var el = h.nextElementSibling;
      while (el && el.tagName !== 'H2') {
        var lis = el.querySelectorAll ? el.querySelectorAll('li') : [];
        lis.forEach(function (li) { skipEls.add(li); });
        el = el.nextElementSibling;
      }
    }
  });

  var items = content.querySelectorAll('li');
  items.forEach(function (li, i) {
    if (skipEls.has(li)) return;

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!stored[i];
    if (cb.checked) li.classList.add('checked');

    cb.addEventListener('change', function () {
      var state = JSON.parse(localStorage.getItem('cb-' + recipeId) || '{}');
      if (cb.checked) {
        state[i] = true;
        li.classList.add('checked');
      } else {
        delete state[i];
        li.classList.remove('checked');
      }
      localStorage.setItem('cb-' + recipeId, JSON.stringify(state));
    });

    li.insertBefore(cb, li.firstChild);
  });
}

function clearChecks(recipeId) {
  localStorage.removeItem('cb-' + recipeId);
  document.querySelectorAll('.recipe-content li').forEach(function (li) {
    li.classList.remove('checked');
    var cb = li.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = false;
  });
}
