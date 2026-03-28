---
title: "About CookedBook"
---

No ads. No life stories. Just recipes.

CookedBook is a recipe site for people who are actually cooking.

Recipes are stored as markdown files in a [GitHub repo](https://github.com/robertkarl/cookedbook). The site is static HTML served from GitHub Pages. There is no tracking, no analytics, no cookies, and no account to create. (We do use some javascript for timers and search).

## Settings

<div id="chef-setting" style="margin-top: 1rem;">
  <label style="display: flex; align-items: center; gap: 0.8rem; cursor: pointer; font-size: 1rem;">
    <input type="checkbox" id="chef-toggle" style="width: 1.4rem; height: 1.4rem; accent-color: var(--accent);">
    <span>Enable AI bullshit</span>
  </label>
  <p style="color: var(--meta); font-size: 0.8rem; margin-top: 0.3rem;">
    Adds a voice assistant to recipe pages. Say "Jason" or tap the mic to ask questions hands-free. Requires a local server — won't work on the public internet.
  </p>
</div>

<script>
(function() {
  var cb = document.getElementById("chef-toggle");
  cb.checked = localStorage.getItem("chef-enabled") === "1";
  cb.addEventListener("change", function() {
    if (cb.checked) {
      localStorage.setItem("chef-enabled", "1");
    } else {
      localStorage.removeItem("chef-enabled");
    }
  });
})();
</script>
