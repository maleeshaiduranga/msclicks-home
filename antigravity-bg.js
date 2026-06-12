/* ============================================
 *  AntigravityBG  —  Drop-in Background Effect
 *  
 *  USAGE (pick one):
 *
 *  ① Zero-config (just paste before </body>):
 *     <script src="antigravity-bg.js"></script>
 *
 *  ② With options:
 *     <script src="antigravity-bg.js"></script>
 *     <script>
 *       AntigravityBG.init({
 *         dotSpacing: 28,
 *         influenceRadius: 200,
 *         colors: [
 *           { r: 255, g: 100, b: 50 },
 *           { r: 0,   g: 200, b: 150 }
 *         ]
 *       });
 *     </script>
 *
 *  ③ Attach to a specific container:
 *     <script>
 *       AntigravityBG.init({ container: '#my-section' });
 *     </script>
 *
 *  API:
 *    AntigravityBG.init(options)   — start / restart with new options
 *    AntigravityBG.destroy()       — remove completely
 *    AntigravityBG.pause()         — pause animation
 *    AntigravityBG.resume()        — resume animation
 * ============================================ */

const AntigravityBG = (() => {
  'use strict';

  // ---- Default Configuration ----
  const DEFAULTS = {
    container: null,           // CSS selector or element — null = document.body
    dotSpacing: 32,            // px between dots
    dotBaseRadius: 1.2,        // default dot radius
    dotMaxRadius: 4.5,         // max radius near cursor
    dotBaseAlpha: 0.18,        // default opacity
    dotMaxAlpha: 0.9,          // max opacity near cursor
    influenceRadius: 180,      // px — mouse affect range
    colorInfluenceRadius: 220, // px — color halo range
    mouseSmoothing: 0.08,      // lerp factor
    pushStrength: 14,          // displacement strength (px)
    connectionDistance: 90,    // px — line draw threshold
    connectionAlpha: 0.08,     // connection line opacity
    trailLength: 6,            // trail ghost count
    trailDecay: 0.7,           // opacity decay per trail step
    bgColor: null,             // background color — null = transparent
    // Heartbeat pulse settings
    pulseEnabled: true,        // enable heartbeat when mouse is idle
    pulseIdleDelay: 400,       // ms before pulse starts after mouse stops
    pulseBPM: 60,              // beats per minute
    pulseRadiusScale: 0.35,    // how much radius expands (0-1)
    pulseAlphaScale: 0.3,      // how much alpha intensifies (0-1)
    pulseInfluenceScale: 0.25, // how much influence radius grows (0-1)
    pulsePushScale: 0.4,       // push strength during pulse beat
    colors: [
      { r: 66,  g: 133, b: 244 },  // Blue
      { r: 234, g: 67,  b: 53  },  // Red
      { r: 251, g: 188, b: 5   },  // Yellow
      { r: 52,  g: 168, b: 83  },  // Green
      { r: 123, g: 97,  b: 255 },  // Purple
    ]
  };

  // ---- Internal state ----
  let config = { ...DEFAULTS };
  let canvas = null;
  let ctx = null;
  let containerEl = null;
  let isBodyMode = false;  // true when container is body (fixed canvas)
  let dots = [];
  let width = 0, height = 0;
  let animId = null;
  let paused = false;
  let initialized = false;

  const mouse = { x: -9999, y: -9999, active: false };
  const smoothMouse = { x: -9999, y: -9999 };
  const trail = [];
  let lastTrailTime = 0;

  // Heartbeat / idle pulse state
  let lastMouseMoveTime = 0;    // timestamp of last mouse movement
  let mouseIsIdle = false;       // true when mouse hasn't moved for pulseIdleDelay
  let pulsePhase = 0;            // current phase in the heartbeat cycle (radians)
  let pulseIntensity = 0;        // 0→1 blend-in of pulse effect
  let prevMouseX = -9999, prevMouseY = -9999;

  // Bound handlers
  let onPointerMove, onPointerLeave, onTouchMove, onTouchEnd, onResize;
  let resizeTimer;

  // ---- Dot ----
  class Dot {
    constructor(gx, gy) {
      this.originX = gx;
      this.originY = gy;
      this.x = gx;
      this.y = gy;
      this.radius = config.dotBaseRadius;
      this.alpha = config.dotBaseAlpha;
      this.color = null;
    }

    update() {
      let totalInfluence = 0;
      let pushX = 0, pushY = 0;

      // Current effective radii — modulated by pulse when idle
      const pBeat = heartbeatValue();
      const pI = pulseIntensity;
      const effInfluence = config.influenceRadius * (1 + config.pulseInfluenceScale * pBeat * pI);
      const effColorInfluence = config.colorInfluenceRadius * (1 + config.pulseInfluenceScale * pBeat * pI);

      const pts = [{ x: smoothMouse.x, y: smoothMouse.y, w: 1 }];
      for (let i = 0; i < trail.length; i++) {
        pts.push({ x: trail[i].x, y: trail[i].y, w: Math.pow(config.trailDecay, i + 1) });
      }

      for (const pt of pts) {
        const dx = this.originX - pt.x;
        const dy = this.originY - pt.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < effColorInfluence) {
          totalInfluence = Math.max(totalInfluence, (1 - dist / effColorInfluence) * pt.w);
        }
        if (pt.w === 1 && dist < effInfluence && dist > 0) {
          const force = 1 - dist / effInfluence;
          const pulsePush = 1 + config.pulsePushScale * pBeat * pI;
          pushX += (dx / dist) * force * config.pushStrength * pulsePush;
          pushY += (dy / dist) * force * config.pushStrength * pulsePush;
        }
      }

      if (totalInfluence > 0) {
        const angle = Math.atan2(this.originY - smoothMouse.y, this.originX - smoothMouse.x);
        const idx = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * config.colors.length) % config.colors.length;
        this.color = config.colors[idx];
      } else {
        this.color = null;
      }

      // Pulse modulates target radius and alpha
      const pulseR = config.pulseRadiusScale * pBeat * pI;
      const pulseA = config.pulseAlphaScale * pBeat * pI;

      const tR = config.dotBaseRadius + (config.dotMaxRadius - config.dotBaseRadius) * totalInfluence * (1 + pulseR);
      const tA = config.dotBaseAlpha + (config.dotMaxAlpha - config.dotBaseAlpha) * totalInfluence * (1 + pulseA);
      this.radius += (tR - this.radius) * 0.12;
      this.alpha += (tA - this.alpha) * 0.12;
      this.x += (this.originX + pushX - this.x) * 0.1;
      this.y += (this.originY + pushY - this.y) * 0.1;
    }

    draw() {
      if (this.alpha < 0.01) return;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);

      if (this.color && this.alpha > config.dotBaseAlpha + 0.02) {
        const { r, g, b } = this.color;
        const gs = this.radius * 3;
        const grad = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, gs);
        grad.addColorStop(0, `rgba(${r},${g},${b},${this.alpha * 0.6})`);
        grad.addColorStop(0.4, `rgba(${r},${g},${b},${this.alpha * 0.2})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = `rgba(${r},${g},${b},${this.alpha})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(this.x, this.y, gs, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(200,200,220,${this.alpha})`;
        ctx.fill();
      }
    }
  }

  // ---- Grid build ----
  function buildGrid() {
    const dpr = window.devicePixelRatio || 1;

    if (isBodyMode) {
      // Fixed canvas covers the viewport
      width = window.innerWidth;
      height = window.innerHeight;
    } else {
      const rect = containerEl.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
    }

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    dots = [];
    const cols = Math.ceil(width / config.dotSpacing) + 2;
    const rows = Math.ceil(height / config.dotSpacing) + 2;
    const ox = (width - (cols - 1) * config.dotSpacing) / 2;
    const oy = (height - (rows - 1) * config.dotSpacing) / 2;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        dots.push(new Dot(ox + c * config.dotSpacing, oy + r * config.dotSpacing));
      }
    }
  }

  // ---- Connections ----
  function drawConnections() {
    const threshold = config.dotBaseAlpha + 0.05;
    for (let i = 0; i < dots.length; i++) {
      const a = dots[i];
      if (a.alpha <= threshold) continue;
      for (let j = i + 1; j < dots.length; j++) {
        const b = dots[j];
        if (b.alpha <= threshold) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < config.connectionDistance) {
          const la = config.connectionAlpha * (1 - dist / config.connectionDistance) * Math.min(a.alpha, b.alpha);
          if (a.color) {
            ctx.strokeStyle = `rgba(${a.color.r},${a.color.g},${a.color.b},${la})`;
          } else {
            ctx.strokeStyle = `rgba(200,200,220,${la})`;
          }
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
  }

  // ---- Convert page coords to canvas-local coords ----
  // KEY FIX: When canvas is position:fixed (body mode),
  // clientX/clientY are already relative to viewport = canvas.
  // Only offset when canvas is inside a positioned container.
  function toLocal(clientX, clientY) {
    if (isBodyMode) {
      // Canvas is fixed to viewport — clientX/Y map directly
      return { x: clientX, y: clientY };
    }
    // Container mode — offset by container's viewport position
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  // ---- Heartbeat waveform ----
  // Simulates a realistic lub-dub pattern:
  //   Beat 1 (lub)  — strong contraction
  //   Beat 2 (dub)  — softer, slightly delayed
  //   Rest           — relaxed between cycles
  function heartbeatValue() {
    if (!config.pulseEnabled || pulseIntensity < 0.01) return 0;

    // Normalize phase to 0–1 within one heartbeat cycle
    const t = (pulsePhase % (Math.PI * 2)) / (Math.PI * 2);

    // Beat 1 (lub): sharp peak at t ≈ 0.0–0.15
    const beat1 = Math.pow(Math.max(0, Math.sin(t * Math.PI / 0.12)), 3) * (t < 0.12 ? 1 : 0);

    // Beat 2 (dub): softer peak at t ≈ 0.18–0.30
    const t2 = t - 0.18;
    const beat2 = Math.pow(Math.max(0, Math.sin(t2 * Math.PI / 0.12)), 3) * (t2 > 0 && t2 < 0.12 ? 0.65 : 0);

    // Combine — value is 0–1
    return Math.min(1, beat1 + beat2);
  }

  // ---- Render loop ----
  function animate(ts) {
    if (paused) { animId = requestAnimationFrame(animate); return; }

    if (config.bgColor) {
      ctx.fillStyle = config.bgColor;
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.clearRect(0, 0, width, height);
    }

    // Detect idle: mouse hasn't moved beyond 2px for pulseIdleDelay ms
    if (mouse.active) {
      const movedDist = Math.abs(mouse.x - prevMouseX) + Math.abs(mouse.y - prevMouseY);
      if (movedDist > 2) {
        lastMouseMoveTime = ts;
        mouseIsIdle = false;
        prevMouseX = mouse.x;
        prevMouseY = mouse.y;
      } else if (!mouseIsIdle && ts - lastMouseMoveTime > config.pulseIdleDelay) {
        mouseIsIdle = true;
      }
    } else {
      mouseIsIdle = false;
    }

    // Advance heartbeat phase & blend pulse intensity
    if (mouseIsIdle && config.pulseEnabled) {
      const beatInterval = 60000 / config.pulseBPM; // ms per beat cycle
      const phaseStep = (Math.PI * 2) / (beatInterval / 16.667); // ~60fps
      pulsePhase += phaseStep;
      pulseIntensity += (1 - pulseIntensity) * 0.04; // smooth blend in
    } else {
      pulseIntensity += (0 - pulseIntensity) * 0.08; // smooth blend out
      if (pulseIntensity < 0.01) pulsePhase = 0;
    }

    if (mouse.active) {
      smoothMouse.x += (mouse.x - smoothMouse.x) * config.mouseSmoothing;
      smoothMouse.y += (mouse.y - smoothMouse.y) * config.mouseSmoothing;
      if (ts - lastTrailTime > 30) {
        trail.unshift({ x: smoothMouse.x, y: smoothMouse.y });
        if (trail.length > config.trailLength) trail.pop();
        lastTrailTime = ts;
      }
    } else {
      smoothMouse.x += (-9999 - smoothMouse.x) * 0.02;
      smoothMouse.y += (-9999 - smoothMouse.y) * 0.02;
      if (trail.length > 0 && ts - lastTrailTime > 60) { trail.pop(); lastTrailTime = ts; }
    }

    for (const d of dots) d.update();
    drawConnections();
    for (const d of dots) d.draw();

    // Cursor glow — also pulses when idle
    if (mouse.active) {
      const pBeat = heartbeatValue();
      const pI = pulseIntensity;
      const glowRadius = config.influenceRadius * 0.6 * (1 + 0.2 * pBeat * pI);
      const glowAlpha1 = 0.04 + 0.04 * pBeat * pI;
      const glowAlpha2 = 0.02 + 0.03 * pBeat * pI;

      const g = ctx.createRadialGradient(smoothMouse.x, smoothMouse.y, 0, smoothMouse.x, smoothMouse.y, glowRadius);
      g.addColorStop(0, `rgba(66,133,244,${glowAlpha1})`);
      g.addColorStop(0.5, `rgba(123,97,255,${glowAlpha2})`);
      g.addColorStop(1, 'rgba(66,133,244,0)');
      ctx.beginPath();
      ctx.arc(smoothMouse.x, smoothMouse.y, glowRadius, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }

    animId = requestAnimationFrame(animate);
  }

  // ---- Inject minimal CSS ----
  function injectStyles() {
    if (document.getElementById('antigravity-bg-styles')) return;
    const style = document.createElement('style');
    style.id = 'antigravity-bg-styles';
    style.textContent = `
      .antigravity-bg-canvas {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 0;
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }

  // ---- Public API ----
  function init(options = {}) {
    if (initialized) destroy();

    config = { ...DEFAULTS, ...options };
    if (options.colors) config.colors = options.colors;

    // Resolve container
    containerEl = null;
    if (config.container) {
      containerEl = typeof config.container === 'string'
        ? document.querySelector(config.container)
        : config.container;
    }
    if (!containerEl) containerEl = document.body;

    isBodyMode = (containerEl === document.body);

    // Container needs positioning context
    if (!isBodyMode) {
      const pos = getComputedStyle(containerEl).position;
      if (pos === 'static') containerEl.style.position = 'relative';
    }

    injectStyles();

    // Create canvas
    canvas = document.createElement('canvas');
    canvas.className = 'antigravity-bg-canvas';
    canvas.id = 'antigravityBgCanvas';

    if (isBodyMode) {
      canvas.style.position = 'fixed';
    }

    containerEl.insertBefore(canvas, containerEl.firstChild);
    ctx = canvas.getContext('2d');

    // Ensure children sit above canvas
    Array.from(containerEl.children).forEach(child => {
      if (child === canvas) return;
      const cp = getComputedStyle(child).position;
      // Only force relative on static elements — never override fixed/absolute/sticky
      if (cp === 'static') {
        child.style.position = 'relative';
      }
      if (!child.style.zIndex && cp === 'static') {
        child.style.zIndex = '1';
      }
    });

    buildGrid();

    // Bind events
    onPointerMove = (e) => {
      const local = toLocal(e.clientX, e.clientY);
      mouse.x = local.x;
      mouse.y = local.y;
      mouse.active = true;
    };
    onPointerLeave = () => { mouse.active = false; };
    onTouchMove = (e) => {
      if (e.touches.length > 0) {
        const local = toLocal(e.touches[0].clientX, e.touches[0].clientY);
        mouse.x = local.x;
        mouse.y = local.y;
        mouse.active = true;
      }
    };
    onTouchEnd = () => { mouse.active = false; };
    onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(buildGrid, 150);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('resize', onResize);

    paused = false;
    initialized = true;
    animId = requestAnimationFrame(animate);
  }

  function destroy() {
    if (animId) cancelAnimationFrame(animId);
    animId = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('resize', onResize);
    dots = [];
    trail.length = 0;
    initialized = false;
    paused = false;
  }

  function pause()  { paused = true;  }
  function resume() { paused = false; }

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { if (!initialized) init(); });
  } else {
    Promise.resolve().then(() => { if (!initialized) init(); });
  }

  return { init, destroy, pause, resume };
})();
