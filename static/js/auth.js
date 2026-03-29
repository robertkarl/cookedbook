/**
 * CookedBook auth check — replaces the localStorage("chef-enabled") gate.
 *
 * On page load, hits /api/me. If authenticated, sets window.chefAuthenticated = true
 * and fires a "chef-auth-ready" event so chef.js and chat.js can initialize.
 */

(function () {
  "use strict";

  window.chefAuthenticated = false;
  window.chefUsername = null;

  // Only check auth on recipe pages (where AI features live)
  if (!document.querySelector(".recipe-content")) return;

  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) {
      if (!r.ok) return null;
      return r.json();
    })
    .then(function (data) {
      if (data && data.authenticated) {
        window.chefAuthenticated = true;
        window.chefUsername = data.username;
        document.dispatchEvent(new Event("chef-auth-ready"));
      }
    })
    .catch(function () {
      // Not authenticated or server unreachable — AI features stay hidden
    });
})();
