function initCheckboxes(recipeId) {
  const stored = JSON.parse(localStorage.getItem('cb-' + recipeId) || '{}');
  const content = document.querySelector('.recipe-content');
  if (!content) return;

  const items = content.querySelectorAll('li');
  items.forEach(function (li, i) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!stored[i];
    if (cb.checked) li.classList.add('checked');

    cb.addEventListener('change', function () {
      const state = JSON.parse(localStorage.getItem('cb-' + recipeId) || '{}');
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
