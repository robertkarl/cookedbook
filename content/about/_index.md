---
title: "About CookedBook"
---

No ads. No life stories. Just recipes.

CookedBook is a recipe site for people who are actually cooking.

Recipes are stored as markdown files in a [GitHub repo](https://github.com/robertkarl/cookedbook). The site is static HTML served from GitHub Pages. There is no tracking, no analytics, and no account to create. (We do use some javascript for timers and search).

## AI Features

CookedBook has an optional AI voice assistant and text chat for recipe help. These features require a login and only work when served from the Chef server.

<div id="auth-status" style="margin-top: 1rem;">
  <noscript>JavaScript required for AI features.</noscript>
</div>

<script>
(function() {
  var el = document.getElementById("auth-status");
  fetch("/api/me", { credentials: "same-origin" })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (data && data.authenticated) {
        var safe = document.createElement("span");
        safe.textContent = data.username;
        el.innerHTML = '<p style="color: #2a7d2e;">Signed in as <strong>' +
          safe.innerHTML + '</strong>. AI features are active on recipe pages.</p>' +
          '<p><a href="/logout">Sign out</a></p>';
      } else {
        el.innerHTML = '<p><a href="/login">Sign in</a> to enable AI features (voice assistant, text chat, smart shopping lists).</p>';
      }
    })
    .catch(function() {
      el.innerHTML = '<p style="color: #888;">AI features are not available on the public site. They require the Chef server.</p>';
    });
})();
</script>
