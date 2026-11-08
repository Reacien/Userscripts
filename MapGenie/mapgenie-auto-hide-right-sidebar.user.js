// ==UserScript==
// @name         MapGenie - Hide Top Right Sidebar
// @namespace    https://github.com/Reacien/Userscripts
// @version      2.0.0
// @description  Hides the top right sidebar on page load
// @author       Reacien
// @match        https://mapgenie.io/*/maps/*
// @icon         https://cdn.mapgenie.io/favicons/mapgenie/favicon.ico
// @license      GPL-3.0-or-later
// @grant        none
// @run-at       document-idle
// @downloadURL  https://update.greasyfork.org/scripts/551177/MapGenie%20-%20Hide%20Top%20Right%20Sidebar.user.js
// @updateURL    https://update.greasyfork.org/scripts/551177/MapGenie%20-%20Hide%20Top%20Right%20Sidebar.meta.js
// ==/UserScript==

(function () {
  "use strict";

  const CHECK_EVERY_MS = 200;
  const GIVE_UP_AFTER_MS = 15000;
  const startTime = Date.now();

  // Returns true once the sidebar is closed.
  function tryCloseSidebar() {
    const sidebar = document.querySelector("#right-sidebar");
    const closeButton = sidebar && sidebar.querySelector(".sidebar-close");

    if (!sidebar || !closeButton) return false;

    // Only click when it is open: clicking a closed sidebar would open it again.
    // If MapGenie hasn't attached its click handler yet, nothing happens and we retry.
    if (!sidebar.classList.contains("closed")) {
      closeButton.click();
    }
    return sidebar.classList.contains("closed");
  }

  const timer = setInterval(function () {
    const done = tryCloseSidebar();
    const timedOut = Date.now() - startTime > GIVE_UP_AFTER_MS;
    if (done || timedOut) clearInterval(timer);
  }, CHECK_EVERY_MS);
})();