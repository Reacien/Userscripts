// ==UserScript==
// @name         MapGenie - Icon Size Slider
// @namespace    *
// @version      1.0.0
// @description  Slider that allows you to dynamically change the size of the icons; adapts to all MapGenie maps; Saves default value
// @match        https://mapgenie.io/*
// @icon         https://icons.duckduckgo.com/ip2/mapgenie.io.ico
// ==/UserScript==

(function() {
  const LS_KEY = "mapgenie_icon_slider_value";
  const script = document.createElement("script");
  script.textContent = `
  (function() {
    function getColors() {
      let title = document.querySelector('.panel .title');
      let textColor = title ? window.getComputedStyle(title).color : "#fff";
      let btn = document.querySelector('.social-item');
      let barBg = btn ? window.getComputedStyle(btn).backgroundColor : "#171e26";
      return {barBg, textColor};
    }
    function getSavedValue() {
      let v = localStorage.getItem("${LS_KEY}");
      v = v !== null ? Number(v) : 1.00;
      return (v >= 0.1 && v <= 2) ? v : 1.00;
    }
    function saveValue(val) {
      localStorage.setItem("${LS_KEY}", val);
    }
    // Set icon size for all symbol layers if needed
    function setIconSize(size) {
      if (!window.map || typeof window.map.setLayoutProperty !== "function") return;
      let layers = window.map.getStyle().layers.filter(l=>l.type==="symbol").map(l=>l.id);
      for(const layer of layers) {
        try {
          window.map.setLayoutProperty(layer, "icon-size", Number(size));
        } catch(e){}
      }
    }
    function injectSlider() {
      const {barBg, textColor} = getColors();
      const social = document.querySelector('.social');
      if(!social || social.querySelector("#icon-size-slider-wrap")) return;
      const wrap = document.createElement("div");
      wrap.id = "icon-size-slider-wrap";
      wrap.style.display = "inline-flex";
      wrap.style.alignItems = "center";
      wrap.style.height = "32px";
      wrap.style.marginLeft = "2px";
      wrap.style.padding = "0 8px";
      wrap.style.borderRadius = "4px";
      wrap.style.backgroundColor = barBg;
      const label = document.createElement("span");
      label.textContent = "Icon Size:";
      label.style.color = textColor;
      label.style.fontSize = "12px";
      label.style.marginRight = "6px";
      label.style.whiteSpace = "nowrap";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0.1";
      slider.max = "2";
      slider.step = "0.01";
      slider.value = getSavedValue();
      slider.style.width = "80px";
      slider.style.cursor = "pointer";
      const valDisplay = document.createElement("span");
      valDisplay.textContent = slider.value;
      valDisplay.style.color = textColor;
      valDisplay.style.fontSize = "11px";
      valDisplay.style.marginLeft = "6px";
      valDisplay.style.minWidth = "28px";
      valDisplay.style.textAlign = "right";
      slider.addEventListener("input", function() {
        valDisplay.textContent = slider.value;
        setIconSize(slider.value);
        saveValue(slider.value);
      });
      wrap.appendChild(label);
      wrap.appendChild(slider);
      wrap.appendChild(valDisplay);
      social.appendChild(wrap);
      setIconSize(slider.value);
    }
    function waitForElements() {
      const check = setInterval(() => {
        if (document.querySelector('.social') && window.map) {
          clearInterval(check);
          setTimeout(injectSlider, 500);
        }
      }, 300);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', waitForElements);
    } else {
      waitForElements();
    }
  })();
  `;
  document.documentElement.appendChild(script);
})();
