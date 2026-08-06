// ============================================================================
// Image editor — the step between "picked a file" and "uploaded it".
//
// Rotate, flip, zoom, drag to frame, and an explicit output size. The output size is the
// point: avatars were being uploaded at whatever resolution the camera produced, so a 4 MB
// phone photo travelled to the server as a 5 MB base64 string to be displayed at 40px.
//
// Usage:  const dataUrl = await editImage(file, { shape: "square", sizes: [128,256,512], size: 256 });
//         null means the user cancelled.
//
// Loaded after app.js; uses $ and t from it.
// ============================================================================
(function () {
  let job = null;   // { img, rot, flipX, flipY, zoom, ox, oy, opts, resolve }

  function el(id) { return document.getElementById(id); }

  function ensureDom() {
    if (el("imgEditModal")) return;
    const m = document.createElement("div");
    m.id = "imgEditModal";
    m.className = "modal hidden";
    m.setAttribute("role", "dialog");
    m.innerHTML = `
      <div class="modal-card wide ie-card">
        <button id="ieClose" class="hub-close" title="${t("cancel")}">✕</button>
        <div class="modal-title" data-i18n="ie_title">Edit image</div>
        <div class="ie-stage" id="ieStage">
          <canvas id="ieCanvas"></canvas>
          <div class="ie-mask" id="ieMask"></div>
        </div>
        <div class="ie-tools">
          <button class="ie-btn" id="ieRotL" title="${t("ie_rot_l")}">⟲</button>
          <button class="ie-btn" id="ieRotR" title="${t("ie_rot_r")}">⟳</button>
          <button class="ie-btn" id="ieFlipX" title="${t("ie_flip_h")}">⇄</button>
          <button class="ie-btn" id="ieFlipY" title="${t("ie_flip_v")}">⇅</button>
          <label class="ie-zoom"><span>${t("ie_zoom")}</span><input type="range" id="ieZoom" min="100" max="400" value="100"></label>
          <button class="ie-btn" id="ieReset" title="${t("ie_reset")}">↺</button>
        </div>
        <div class="ie-sizes" id="ieSizes"></div>
        <div class="ie-note" id="ieNote"></div>
        <div class="modal-actions">
          <button id="ieCancel" class="btn-ghost" type="button">${t("cancel")}</button>
          <button id="ieApply" class="btn-primary" type="button">${t("ie_apply")}</button>
        </div>
      </div>`;
    document.body.appendChild(m);

    el("ieRotL").onclick = () => { job.rot = (job.rot + 270) % 360; draw(); };
    el("ieRotR").onclick = () => { job.rot = (job.rot + 90) % 360; draw(); };
    el("ieFlipX").onclick = () => { job.flipX = !job.flipX; draw(); };
    el("ieFlipY").onclick = () => { job.flipY = !job.flipY; draw(); };
    el("ieZoom").oninput = () => { job.zoom = Number(el("ieZoom").value) / 100; draw(); };
    el("ieReset").onclick = () => { job.rot = 0; job.flipX = job.flipY = false; job.zoom = 1; job.ox = job.oy = 0; el("ieZoom").value = 100; draw(); };
    el("ieCancel").onclick = () => finish(null);
    el("ieClose").onclick = () => finish(null);
    el("ieApply").onclick = () => finish(render(job.opts.size));
    m.addEventListener("click", (e) => { if (e.target === m) finish(null); });

    // Drag to frame — the crop window stays put and the picture moves under it.
    const stage = el("ieStage");
    let drag = null;
    const down = (e) => {
      const p = e.touches ? e.touches[0] : e;
      drag = { x: p.clientX, y: p.clientY, ox: job.ox, oy: job.oy };
      e.preventDefault();
    };
    const move = (e) => {
      if (!drag) return;
      const p = e.touches ? e.touches[0] : e;
      job.ox = drag.ox + (p.clientX - drag.x);
      job.oy = drag.oy + (p.clientY - drag.y);
      draw();
      e.preventDefault();
    };
    const up = () => { drag = null; };
    stage.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    stage.addEventListener("touchstart", down, { passive: false });
    stage.addEventListener("touchmove", move, { passive: false });
    stage.addEventListener("touchend", up);
  }

  // The preview canvas is a fixed box; the picture is drawn into it with the current
  // rotation/zoom/offset. Export re-runs the same maths at the chosen output size.
  const PREVIEW = 300;
  function draw() {
    const cv = el("ieCanvas"); if (!cv || !job) return;
    cv.width = PREVIEW; cv.height = PREVIEW;
    const cx = cv.getContext("2d");
    cx.fillStyle = "#0b0f0d"; cx.fillRect(0, 0, PREVIEW, PREVIEW);
    paint(cx, PREVIEW, 1);
    const mask = el("ieMask");
    if (mask) mask.className = "ie-mask" + (job.opts.shape === "square" ? " round" : "");
  }
  function paint(cx, size, scale) {
    const { img, rot, flipX, flipY, zoom, ox, oy } = job;
    const swap = rot === 90 || rot === 270;
    const iw = swap ? img.height : img.width;
    const ih = swap ? img.width : img.height;
    // "cover" the frame, then apply the user's zoom on top.
    const base = Math.max(size / iw, size / ih) * zoom;
    cx.save();
    cx.translate(size / 2 + ox * scale, size / 2 + oy * scale);
    cx.rotate((rot * Math.PI) / 180);
    cx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    cx.drawImage(img, (-img.width * base) / 2, (-img.height * base) / 2, img.width * base, img.height * base);
    cx.restore();
  }
  function render(size) {
    const cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    const cx = cv.getContext("2d");
    cx.fillStyle = "#0b0f0d"; cx.fillRect(0, 0, size, size);
    paint(cx, size, size / PREVIEW);   // same framing, scaled up to the export size
    // webp where it exists (much smaller for photos), jpeg as the fallback.
    const webp = cv.toDataURL("image/webp", 0.9);
    return webp.startsWith("data:image/webp") ? webp : cv.toDataURL("image/jpeg", 0.9);
  }
  function finish(result) {
    const m = el("imgEditModal"); if (m) m.classList.add("hidden");
    const r = job && job.resolve; job = null;
    if (r) r(result);
  }

  // opts: { shape: "square" | "free", sizes: [px…], size: px, label }
  window.editImage = function editImage(file, opts = {}) {
    return new Promise((resolve) => {
      if (!file) return resolve(null);
      const o = {
        shape: opts.shape || "square",
        sizes: opts.sizes || [128, 256, 512, 1024],
        size: opts.size || 256,
        label: opts.label || "",
      };
      const fr = new FileReader();
      fr.onerror = () => resolve(null);
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(null);
        img.onload = () => {
          ensureDom();
          job = { img, rot: 0, flipX: false, flipY: false, zoom: 1, ox: 0, oy: 0, opts: o, resolve };
          el("ieZoom").value = 100;
          // Output size picker — the whole reason this exists for avatars.
          const box = el("ieSizes");
          box.innerHTML = "";
          for (const s of o.sizes) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "ie-size" + (s === o.size ? " on" : "");
            b.textContent = s + "px";
            b.onclick = () => {
              o.size = s;
              box.querySelectorAll(".ie-size").forEach((x) => x.classList.toggle("on", x === b));
              updateNote();
            };
            box.appendChild(b);
          }
          updateNote();
          el("imgEditModal").classList.remove("hidden");
          draw();
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  };
  function updateNote() {
    const n = el("ieNote"); if (!n || !job) return;
    n.textContent = t("ie_note", { w: job.img.width, h: job.img.height, out: job.opts.size });
  }
})();
