function noop() {}

function gradient() {
  return { addColorStop: noop };
}

export function installGridTestStubs() {
  const proto = globalThis.HTMLCanvasElement?.prototype;
  if (proto && !proto.__tenwhyGridStub) {
    proto.__tenwhyGridStub = true;
    proto.getContext = function getContext() {
      return {
        canvas: this,
        save: noop,
        restore: noop,
        beginPath: noop,
        closePath: noop,
        moveTo: noop,
        lineTo: noop,
        rect: noop,
        arc: noop,
        fill: noop,
        stroke: noop,
        clip: noop,
        fillRect: noop,
        strokeRect: noop,
        clearRect: noop,
        fillText: noop,
        strokeText: noop,
        translate: noop,
        scale: noop,
        rotate: noop,
        transform: noop,
        setTransform: noop,
        resetTransform: noop,
        drawImage: noop,
        quadraticCurveTo: noop,
        bezierCurveTo: noop,
        createLinearGradient: gradient,
        createRadialGradient: gradient,
        createPattern: () => ({}),
        getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
        putImageData: noop,
        measureText: (text) => ({
          width: String(text || "").length * 8,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
        setLineDash: noop,
        getLineDash: () => [],
        fillStyle: "#000",
        strokeStyle: "#000",
        globalAlpha: 1,
        lineWidth: 1,
        font: "13px sans-serif",
        textBaseline: "alphabetic",
        textAlign: "left",
        imageSmoothingEnabled: true,
      };
    };
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (globalThis.window && typeof globalThis.window.ResizeObserver !== "function") {
    globalThis.window.ResizeObserver = globalThis.ResizeObserver;
  }
  if (typeof Image !== "undefined" && !Image.prototype.decode) {
    Image.prototype.decode = () => Promise.resolve();
  }
  if (typeof globalThis.getComputedStyle !== "function" && globalThis.window) {
    globalThis.getComputedStyle = globalThis.window.getComputedStyle.bind(globalThis.window);
  }
  if (typeof globalThis.requestAnimationFrame !== "function") {
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  }
  if (typeof globalThis.matchMedia !== "function") {
    globalThis.matchMedia = () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false; },
    });
  }
}
