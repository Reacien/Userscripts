// ==UserScript==
// @name         MapGenie - Icon Size Slider
// @namespace    https://github.com/Reacien/Userscripts
// @version      1.0.0
// @description  Slider that allows you to dynamically change the size of the icons; adapts to all MapGenie maps; Saves default value
// @author       Reacien
// @match        https://mapgenie.io/*
// @icon         https://cdn.mapgenie.io/favicons/mapgenie/favicon.ico
// @downloadURL  *
// @updateURL    *
// ==/UserScript==
// *
// *

(function() {
  const LS_KEY = "mapgenie_icon_slider_value";
  const script = document.createElement("script");
  script.textContent = `
  (function() {
    function getColors() {
      let categoryTitle = document.querySelector('#categories .category-item .title');
      let textColor = categoryTitle ? window.getComputedStyle(categoryTitle).color : "fff";
      let btn = document.querySelector('.social-item');
      let barBg = btn ? window.getComputedStyle(btn).backgroundColor : "#171e26";
      return { barBg, textColor };
    }

    function getSliderInfo() {
      const progressBar = document.querySelector('.progress-bar-container .progress-bar');
      if(progressBar) {
        const bgColor = window.getComputedStyle(progressBar).backgroundColor;
        return { color: bgColor };
      }
      return { color: '#f7b500', height: '6px' };
    }

    function getSavedValue() {
      let v = localStorage.getItem("${LS_KEY}");
      v = v !== null ? Number(v) : 1.00;
      return (v >= 0.1 && v <= 2) ? v : 1.00;
    }

    function saveValue(val) {
      localStorage.setItem("${LS_KEY}", val);
    }

    function setIconSize(size) {
      if (!window.map || typeof window.map.setLayoutProperty !== "function") return;
      let layers = window.map.getStyle().layers.filter(l=>l.type==="symbol").map(l=>l.id);
      for(const layer of layers) {
        try {
          window.map.setLayoutProperty(layer, "icon-size", Number(size));
        } catch(e){}
      }
    }

    function getCategoryTitleFontSize() {
      const categoryTitle = document.querySelector('.category-item .title');
      if (categoryTitle) {
        return window.getComputedStyle(categoryTitle).fontSize;
      }
      return '14px';
    }

    function injectSlider() {
      const {barBg, textColor} = getColors();

      const social = document.querySelector('.social');
      if(!social || social.querySelector("#icon-size-slider-wrap")) return;

      const wrap = document.createElement("div");
      wrap.id = "icon-size-slider-wrap";
      wrap.style.display = "inline-flex";
      wrap.style.alignItems = "center";
      wrap.style.height = "28px";
      wrap.style.padding = "0 8px";
      wrap.style.borderRadius = "3px";
      wrap.style.backgroundColor = barBg;

      const label = document.createElement("span");
      label.textContent = "ICON SIZE:";
      label.style.color = textColor;
      label.style.fontSize = getCategoryTitleFontSize();
      label.style.marginRight = "6px";
      label.style.whiteSpace = "nowrap";

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0.1";
      slider.max = "2";
      slider.step = "0.02";
      slider.value = getSavedValue();
      slider.style.width = "70px";
      slider.style.cursor = "pointer";

      const sliderInfo = getSliderInfo();
      slider.style.accentColor = sliderInfo.color;

      const valInput = document.createElement("input");
      valInput.type = "text";
      valInput.value = slider.value;
      valInput.style.border = "none";
      valInput.style.background = "none";
      valInput.style.outline = "none";
      valInput.style.padding = "1px";
      valInput.style.marginLeft = "2px";
      valInput.style.textAlign = "center";
      valInput.style.color = textColor;
      valInput.style.fontSize = getCategoryTitleFontSize();
      valInput.style.width = "28px";
      valInput.setAttribute("inputmode", "decimal");

      slider.addEventListener("input", function(){
        valInput.value = slider.value;
        setIconSize(slider.value);
        saveValue(slider.value);
      });

      valInput.addEventListener("change", function() {
        slider.value = valInput.value;
        setIconSize(valInput.value);
        saveValue(valInput.value);
      });

      valInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
          let v = parseFloat(valInput.value.replace(",", "."));
          if (v >= 0.1 && v <= 2) {
            slider.value = v;
            setIconSize(v);
            saveValue(v);
            valInput.value = v;
            valInput.blur();
          } else {
            valInput.value = slider.value;
          }
        }
      });

      wrap.appendChild(label);
      wrap.appendChild(slider);
      wrap.appendChild(valInput);
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
