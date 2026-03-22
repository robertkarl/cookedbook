var recipes = [];

fetch('/index.json')
  .then(function (r) { return r.json(); })
  .then(function (data) {
    recipes = data;
    buildSuggestions();
  });

function buildSuggestions() {
  var tagSet = {};
  recipes.forEach(function (r) {
    (r.tags || []).forEach(function (t) { tagSet[t] = true; });
  });
  var container = document.getElementById('search-suggestions');
  if (!container) return;
  Object.keys(tagSet).sort().forEach(function (tag) {
    var btn = document.createElement('button');
    btn.textContent = tag;
    btn.addEventListener('click', function () {
      document.getElementById('search-input').value = tag;
      doSearch(tag);
    });
    container.appendChild(btn);
  });
}

function doSearch(query) {
  var q = query.toLowerCase().trim();
  var results = document.getElementById('search-results');
  if (!q) {
    results.innerHTML = '';
    return;
  }
  var terms = q.split(/\s+/);
  var matches = recipes.filter(function (r) {
    var blob = (r.title + ' ' + r.summary + ' ' + (r.tags || []).join(' ') + ' ' + r.content).toLowerCase();
    return terms.every(function (t) { return blob.indexOf(t) !== -1; });
  });
  if (matches.length === 0) {
    results.innerHTML = '<p class="no-results">No recipes found.</p>';
    return;
  }
  results.innerHTML = matches.map(function (r) {
    return '<a href="' + r.permalink + '" class="recipe-card">' +
      '<h2>' + escapeHtml(r.title) + '</h2>' +
      (r.summary ? '<p>' + escapeHtml(r.summary) + '</p>' : '') +
      (r.tags && r.tags.length ? '<div class="card-tags">' + r.tags.map(function(t) {
        return '<span class="tag">' + escapeHtml(t) + '</span>';
      }).join('') + '</div>' : '') +
      '</a>';
  }).join('');
}

function escapeHtml(s) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(s));
  return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', function () {
  var input = document.getElementById('search-input');
  if (input) {
    input.addEventListener('input', function () { doSearch(input.value); });
  }
});
