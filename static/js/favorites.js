var FAVORITES_KEY = 'favorites';
var DEFAULT_FAVORITES = [
  '/recipes/basic-pizza-dough/',
  '/recipes/alan-thrall-oven-chicken/',
  '/recipes/pan-seared-ny-strip/'
];

function getFavorites() {
  var raw = localStorage.getItem(FAVORITES_KEY);
  if (raw === null) return DEFAULT_FAVORITES.slice();
  try { return JSON.parse(raw); } catch (e) { return DEFAULT_FAVORITES.slice(); }
}

function saveFavorites(favs) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
}

function isFavorite(permalink) {
  return getFavorites().indexOf(permalink) !== -1;
}

function toggleFavorite(permalink) {
  var favs = getFavorites();
  var idx = favs.indexOf(permalink);
  if (idx === -1) { favs.push(permalink); } else { favs.splice(idx, 1); }
  saveFavorites(favs);
  return idx === -1; // returns true if now favorited
}

function createFavButton(permalink) {
  var btn = document.createElement('button');
  btn.className = 'fav-btn';
  btn.setAttribute('aria-label', 'Toggle favorite');
  btn.textContent = isFavorite(permalink) ? '\u2605' : '\u2606';
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var nowFav = toggleFavorite(permalink);
    btn.textContent = nowFav ? '\u2605' : '\u2606';
  });
  return btn;
}

function initHomeFavorites() {
  var list = document.querySelector('.recipe-list');
  if (!list) return;
  var cards = list.querySelectorAll('.recipe-card');
  var favs = getFavorites();
  var visibleCount = 0;

  cards.forEach(function (card) {
    var href = card.getAttribute('href');
    if (favs.indexOf(href) !== -1) {
      card.style.position = 'relative';
      card.appendChild(createFavButton(href));
      visibleCount++;
    } else {
      card.style.display = 'none';
    }
  });

  if (visibleCount === 0 && favs.length === 0) {
    var msg = document.createElement('p');
    msg.className = 'no-favorites';
    msg.innerHTML = 'No favorites yet. <a href="/recipes/">Browse all recipes</a> and tap the star to add some.';
    list.appendChild(msg);
  }

  list.style.visibility = 'visible';
}

function initDetailFavorite() {
  var h1 = document.querySelector('.recipe h1');
  if (!h1) return;
  var permalink = window.location.pathname;
  var row = document.createElement('div');
  row.className = 'recipe-title-row';
  h1.parentNode.insertBefore(row, h1);
  row.appendChild(h1);
  row.appendChild(createFavButton(permalink));
}

function initSearchFavorites() {
  var results = document.getElementById('search-results');
  if (!results) return;
  function addStars() {
    var cards = results.querySelectorAll('.recipe-card:not([data-fav-done])');
    cards.forEach(function (card) {
      card.setAttribute('data-fav-done', '1');
      card.style.position = 'relative';
      card.appendChild(createFavButton(card.getAttribute('href')));
    });
  }
  var observer = new MutationObserver(addStars);
  observer.observe(results, { childList: true });
}
