// ==UserScript==
// @name         MapGenie - Icon Size Slider
// @namespace    https://github.com/Reacien/Userscripts
// @version      2.0.0
// @description  Add a slider to dynamically adjust the size of icons on mapgenie.io maps for better visibility and customization. Now with dynamic text color matching the map theme/logo!
// @author       Reacien
// @match        https://mapgenie.io/*/maps/*
// @icon         https://cdn.mapgenie.io/favicons/mapgenie/favicon.ico
// @license      GPL-3.0-or-later
// @grant        unsafeWindow
// @run-at       document-Idle
// @downloadURL  https://update.greasyfork.org/scripts/551149/MapGenie%20-%20Icon%20Size%20Slider.user.js
// @updateURL    https://update.greasyfork.org/scripts/551149/MapGenie%20-%20Icon%20Size%20Slider.meta.js
// ==/UserScript==

(function () {
  "use strict";

  // unsafeWindow gives access to MapGenie's own `map` object without injecting a <script> tag.
  const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  const LS_KEY = "mapgenie_icon_slider_value";
  const MIN_SIZE = 0.1;
  const MAX_SIZE = 2;
  const STEP = 0.02;
  const DEFAULT_SIZE = 1;
  const FALLBACK_ACCENT = "#f7b500";
  const GIVE_UP_AFTER_MS = 20000;

  // First part of the URL path is the game, e.g. "the-legend-of-zelda-ocarina-of-time".
  // The storage key is unchanged from older versions, so saved sizes are kept.
  const gameSlug = location.pathname.split("/")[1] || "default";
  const storageKey = `${LS_KEY}_${gameSlug}`;

  // Each icon layer's own size before we touch it, so the slider scales it instead of replacing it.
  const originalSizes = {};

  /* ---------- Saved value ---------- */

  // Turns user input into a valid size, or null if it isn't one. Accepts "1,5" as well as "1.5".
  function parseSize(value) {
    const number = parseFloat(String(value).replace(",", "."));
    if (isNaN(number) || number < MIN_SIZE || number > MAX_SIZE) return null;
    return Math.round(number * 100) / 100;
  }

  function getSavedValue() {
    return parseSize(localStorage.getItem(storageKey)) ?? DEFAULT_SIZE;
  }

  function saveValue(size) {
    localStorage.setItem(storageKey, size);
  }

  /* ---------- Map ---------- */

  function getIconLayerIds(map) {
    return map
      .getStyle()
      .layers.filter((layer) => layer.type === "symbol" && layer.layout && layer.layout["icon-image"])
      .map((layer) => layer.id);
  }

  function setIconSize(size) {
    const map = pageWindow.map;
    if (!map || typeof map.setLayoutProperty !== "function") return;

    for (const layerId of getIconLayerIds(map)) {
      if (!(layerId in originalSizes)) {
        const current = map.getLayoutProperty(layerId, "icon-size");
        // Only plain numbers can be scaled; anything else (e.g. zoom-based sizes) is treated as 1.
        originalSizes[layerId] = typeof current === "number" ? current : 1;
      }
      try {
        map.setLayoutProperty(layerId, "icon-size", originalSizes[layerId] * size);
      } catch (error) {
        console.warn("[Icon Size Slider] Could not resize layer", layerId, error);
      }
    }
  }

  /* ---------- Theme colors ---------- */

  function getBarBackground() {
    const socialButton = document.querySelector(".social-item");
    return socialButton ? getComputedStyle(socialButton).backgroundColor : "#171e26";
  }

  function getTextColor() {
    const rootStyle = getComputedStyle(document.documentElement);
    const color =
      rootStyle.getPropertyValue("--social-icon-fill-color").trim() ||
      rootStyle.getPropertyValue("--text-color").trim();
    return color || "#fff";
  }

  function getAccentColor() {
    const progressBar = document.querySelector(".progress-bar-container .progress-bar");
    if (!progressBar) return FALLBACK_ACCENT;
    const color = getComputedStyle(progressBar).backgroundColor;
    if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") return FALLBACK_ACCENT;
    return color;
  }

  function getFontSize() {
    const categoryTitle = document.querySelector(".category-item .title");
    return categoryTitle ? getComputedStyle(categoryTitle).fontSize : "14px";
  }

  /* ---------- Slider UI ---------- */

  function formatSize(size) {
    return Number(size).toFixed(2);
  }

  function injectSlider() {
    const social = document.querySelector(".social");
    if (!social || social.querySelector("#icon-size-slider-wrap")) return;

    const textColor = getTextColor();
    const fontSize = getFontSize();
    const savedValue = getSavedValue();

    const wrap = document.createElement("div");
    wrap.id = "icon-size-slider-wrap";
    Object.assign(wrap.style, {
      display: "inline-flex",
      alignItems: "center",
      height: "28px",
      padding: "0 8px",
      borderRadius: "3px",
      backgroundColor: getBarBackground(),
      opacity: "0.9",
    });

    const label = document.createElement("span");
    label.textContent = "ICON SIZE:";
    label.title = "Double-click to reset to 1.00";
    Object.assign(label.style, {
      color: textColor,
      fontSize: fontSize,
      marginRight: "6px",
      whiteSpace: "nowrap",
      cursor: "pointer",
      userSelect: "none",
    });

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = MIN_SIZE;
    slider.max = MAX_SIZE;
    slider.step = STEP;
    slider.value = savedValue;
    Object.assign(slider.style, {
      width: "70px",
      cursor: "pointer",
      accentColor: getAccentColor(),
    });

    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.value = formatSize(savedValue);
    valueInput.setAttribute("inputmode", "decimal");
    valueInput.title = `Type a size between ${MIN_SIZE} and ${MAX_SIZE}, then press Enter`;
    Object.assign(valueInput.style, {
      border: "none",
      background: "none",
      outline: "none",
      padding: "1px",
      marginLeft: "2px",
      textAlign: "center",
      color: textColor,
      fontSize: fontSize,
      width: "34px",
    });

    // One place that applies a size, so the slider, text box and reset all behave the same.
    function applySize(size) {
      slider.value = size;
      valueInput.value = formatSize(size);
      setIconSize(size);
      saveValue(size);
    }

    slider.addEventListener("input", function () {
      applySize(Number(slider.value));
    });

    // "change" fires when the text box loses focus; Enter just blurs it to trigger that.
    valueInput.addEventListener("change", function () {
      const size = parseSize(valueInput.value);
      if (size === null) {
        valueInput.value = formatSize(slider.value); // invalid input: put the old value back
      } else {
        applySize(size);
      }
    });

    valueInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") valueInput.blur();
    });

    label.addEventListener("dblclick", function () {
      applySize(DEFAULT_SIZE);
    });

    wrap.append(label, slider, valueInput);
    social.appendChild(wrap);

    setIconSize(savedValue);
  }

  /* ---------- Start ---------- */

  // Ready once MapGenie's map exists and its icon layers have been added.
  function isMapReady() {
    const map = pageWindow.map;
    if (!map || typeof map.getStyle !== "function") return false;
    try {
      return getIconLayerIds(map).length > 0;
    } catch (error) {
      return false; // style not loaded yet
    }
  }

  const startTime = Date.now();
  const timer = setInterval(function () {
    if (document.querySelector(".social") && isMapReady()) {
      clearInterval(timer);
      injectSlider();
    } else if (Date.now() - startTime > GIVE_UP_AFTER_MS) {
      clearInterval(timer);
    }
  }, 300);
})();