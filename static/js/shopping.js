/**
 * Shopping list generator.
 *
 * Collects unchecked ingredients from the recipe, sends them to the
 * Chef server to group by store aisle, renders a printable list.
 */

function generateShoppingList() {
  var content = document.querySelector('.recipe-content');
  if (!content) return;

  var title = document.querySelector('.recipe h1');
  var recipeName = title ? title.textContent : 'Recipe';

  // Collect checked/unchecked ingredients
  var need = [];
  var have = [];
  var inIngredients = false;

  var elements = content.querySelectorAll('h2, h3, li');
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];

    if (el.tagName === 'H2') {
      var text = el.textContent.toLowerCase();
      inIngredients = text.indexOf('ingredient') !== -1;
      continue;
    }

    if (el.tagName === 'H3' && inIngredients) continue;

    if (el.tagName === 'LI' && inIngredients) {
      var cb = el.querySelector('input[type="checkbox"]');
      var itemText = '';
      for (var j = 0; j < el.childNodes.length; j++) {
        var node = el.childNodes[j];
        if (node.nodeType === 3) {
          itemText += node.textContent;
        } else if (node.nodeType === 1 && node.tagName !== 'INPUT') {
          itemText += node.textContent;
        }
      }
      itemText = itemText.trim();

      if (cb && cb.checked) {
        have.push(itemText);
      } else {
        need.push(itemText);
      }
    }
  }

  if (need.length === 0) {
    alert('Nothing to buy — all ingredients checked off!');
    return;
  }

  // Show loading state on button
  var btn = document.querySelector('[onclick="generateShoppingList()"]');
  var origText = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Grouping by aisle...'; btn.disabled = true; }

  // Hit the server to group by aisle
  fetch('/api/shopping-list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ need: need, have: have, recipe: recipeName })
  })
  .then(function (r) { return r.json(); })
  .then(function (data) {
    renderShoppingList(data, recipeName, have);
  })
  .catch(function (err) {
    console.error('[shopping] API error, falling back to ungrouped:', err);
    // Fallback: render ungrouped
    renderShoppingList(
      { grouped: [{ aisle: 'All Items', items: need }], recipe: recipeName },
      recipeName, have
    );
  })
  .finally(function () {
    if (btn) { btn.textContent = origText; btn.disabled = false; }
  });
}

function renderShoppingList(data, recipeName, have) {
  var grouped = data.grouped || [];

  var styles =
    'body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; ' +
    'padding: 1.5rem; max-width: 600px; margin: 0 auto; font-size: 18px; line-height: 1.6; }' +
    'h1 { font-size: 1.4rem; margin-bottom: 0.2rem; }' +
    'h2 { font-size: 1rem; color: #c44b2b; margin-top: 1.5rem; margin-bottom: 0.3rem; ' +
    'border-bottom: 2px solid #e0dcd4; padding-bottom: 0.2rem; }' +
    '.subtitle { color: #666; font-size: 0.85rem; margin-bottom: 1rem; }' +
    'ul { padding-left: 0; list-style: none; margin: 0; }' +
    'li { padding: 0.35rem 0; border-bottom: 1px solid #f0eeea; }' +
    'li::before { content: "\\25A1\\00a0\\00a0"; color: #bbb; }' +
    '.have { margin-top: 2rem; opacity: 0.4; }' +
    '.have h2 { color: #666; }' +
    '.have li { text-decoration: line-through; }' +
    '.have li::before { content: "\\2611\\00a0\\00a0"; }' +
    '@media print { body { font-size: 14px; padding: 0.5rem; } ' +
    'h1 { font-size: 1.2rem; } h2 { font-size: 0.9rem; } }';

  var html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>Shopping List</title>' +
    '<style>' + styles + '</style></head><body>' +
    '<h1>Shopping List</h1>' +
    '<div class="subtitle">' + esc(recipeName) + '</div>';

  var totalItems = 0;
  for (var i = 0; i < grouped.length; i++) {
    var group = grouped[i];
    var items = group.items || [];
    if (items.length === 0) continue;
    totalItems += items.length;
    html += '<h2>' + esc(group.aisle) + ' (' + items.length + ')</h2><ul>';
    for (var j = 0; j < items.length; j++) {
      html += '<li>' + esc(items[j]) + '</li>';
    }
    html += '</ul>';
  }

  if (have && have.length > 0) {
    html += '<div class="have"><h2>Already have (' + have.length + ')</h2><ul>';
    for (var k = 0; k < have.length; k++) {
      html += '<li>' + esc(have[k]) + '</li>';
    }
    html += '</ul></div>';
  }

  html += '</body></html>';

  var win = window.open('', '_blank');
  if (!win) {
    alert('Pop-up blocked — allow pop-ups for this site.');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(function () { win.print(); }, 400);
}

function esc(s) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(s));
  return div.innerHTML;
}
