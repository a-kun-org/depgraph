(() => {
  const DATA = JSON.parse(document.getElementById("depgraph-data").textContent);
  const KIND_LABEL = { using: "using", reference: "型参照", import: "import", asmdef: "asmdef" };

  const viewEl = document.getElementById("view");
  const labelsEl = document.getElementById("labels");
  const tooltipEl = document.getElementById("tooltip");
  const subtitleEl = document.getElementById("subtitle");
  const searchEl = document.getElementById("search");
  const searchCountEl = document.getElementById("search-count");
  const layersEl = document.getElementById("layers");
  const modeEl = document.getElementById("mode");

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x12151c, 1);
  viewEl.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  scene.add(new THREE.AmbientLight(0xffffff, 0.74));
  const key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(6, 10, 8);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.28);
  fill.position.set(-8, -3, -6);
  scene.add(fill);

  const view = { theta: 0.62, phi: 1.05, radius: 24, target: new THREE.Vector3() };
  const hiddenLayers = new Set();
  const meshById = new Map();
  const labelById = new Map();
  const clusterLabels = [];
  let edgeObjs = [];
  let mode = "file";
  let hoverId = null;
  let drag = null;

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const tmp = new THREE.Vector3();
  const camDir = new THREE.Vector3();

  function currentGraph() {
    return mode === "assembly" ? DATA.assembly : DATA.file;
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  function updateCamera() {
    const s = Math.sin(view.phi);
    camera.position.set(
      view.target.x + view.radius * s * Math.sin(view.theta),
      view.target.y + view.radius * Math.cos(view.phi),
      view.target.z + view.radius * s * Math.cos(view.theta),
    );
    camera.lookAt(view.target);
  }

  function query() {
    return searchEl.value.trim().toLowerCase();
  }

  function nodeMatches(node) {
    const q = query();
    if (!q) return true;
    return node.label.toLowerCase().includes(q) || (node.path || "").toLowerCase().includes(q);
  }

  function fitRadius() {
    let max = 4;
    for (const mesh of meshById.values()) {
      if (!mesh.visible) continue;
      max = Math.max(max, mesh.position.length() + mesh.userData.radius + 1.5);
    }
    view.radius = max * 1.65;
    view.target.set(0, 0, 0);
  }

  function clearGraph() {
    for (const mesh of meshById.values()) scene.remove(mesh);
    for (const edge of edgeObjs) {
      scene.remove(edge.line);
      scene.remove(edge.head);
    }
    meshById.clear();
    labelById.clear();
    clusterLabels.length = 0;
    edgeObjs = [];
    labelsEl.textContent = "";
    hoverId = null;
  }

  function makeLabel(className, text, color) {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    if (color) el.style.color = color;
    labelsEl.appendChild(el);
    return el;
  }

  function buildScene() {
    clearGraph();
    const graph = currentGraph();
    const degree = new Map();
    for (const edge of graph.edges) {
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
    }

    for (const node of graph.nodes) {
      const base = node.language === "asmdef" || node.files > 1 ? 0.46 : 0.34;
      const radius = base + Math.min(0.28, Math.sqrt(degree.get(node.id) || 0) * 0.05);
      const geom = new THREE.SphereGeometry(radius, 22, 16);
      const mat = new THREE.MeshStandardMaterial({
        color: node.color,
        roughness: 0.42,
        metalness: 0.06,
        emissive: 0x000000,
        transparent: true,
        opacity: 1,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(node.x, node.y, node.z);
      mesh.userData = {
        id: node.id,
        node,
        radius,
        home: new THREE.Vector3(node.x, node.y, node.z),
      };
      scene.add(mesh);
      meshById.set(node.id, mesh);
      labelById.set(node.id, makeLabel("node-label", node.label, "#f2f5fa"));
    }

    const byLayer = new Map();
    for (const node of graph.nodes) {
      const list = byLayer.get(node.layer) || [];
      list.push(node.id);
      byLayer.set(node.layer, list);
    }
    for (const layer of DATA.layers) {
      const ids = byLayer.get(layer.key);
      if (!ids || ids.length === 0) continue;
      clusterLabels.push({
        layer: layer.key,
        color: layer.color,
        ids,
        el: makeLabel("cluster-label", layer.key, layer.color),
      });
    }

    for (const edge of graph.edges) {
      const source = meshById.get(edge.source);
      const target = meshById.get(edge.target);
      if (!source || !target) continue;
      const color = new THREE.Color(target.userData.node.color);
      const lineGeom = new THREE.BufferGeometry();
      lineGeom.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
      const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 });
      const line = new THREE.Line(lineGeom, lineMat);
      const headMat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.4,
        metalness: 0.05,
        transparent: true,
        opacity: 0.9,
        emissive: color,
        emissiveIntensity: 0.15,
      });
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.4, 8), headMat);
      scene.add(line);
      scene.add(head);
      edgeObjs.push({ edge, line, head, source, target });
    }

    syncEdges();
    renderLayerToggles();
    applyVisibility();
    fitRadius();
    const g = currentGraph();
    subtitleEl.textContent = `${g.nodes.length} ノード · ${g.edges.length} エッジ`;
  }

  function syncEdges() {
    const up = new THREE.Vector3(0, 1, 0);
    for (const obj of edgeObjs) {
      const a = obj.source.position;
      const b = obj.target.position;
      const dir = tmp.copy(b).sub(a);
      const len = dir.length();
      const ra = obj.source.userData.radius;
      const rb = obj.target.userData.radius;
      const headLen = 0.4;
      if (len < ra + rb + headLen + 0.05) {
        obj.line.visible = false;
        obj.head.visible = false;
        continue;
      }
      dir.multiplyScalar(1 / len);
      const start = a.clone().addScaledVector(dir, ra + 0.04);
      const tip = b.clone().addScaledVector(dir, -(rb + 0.02));
      const lineEnd = tip.clone().addScaledVector(dir, -headLen);
      const pos = obj.line.geometry.attributes.position;
      pos.setXYZ(0, start.x, start.y, start.z);
      pos.setXYZ(1, lineEnd.x, lineEnd.y, lineEnd.z);
      pos.needsUpdate = true;
      obj.head.position.copy(tip).addScaledVector(dir, -headLen * 0.5);
      obj.head.quaternion.setFromUnitVectors(up, dir);
      const show = obj.source.visible && obj.target.visible;
      obj.line.visible = show;
      obj.head.visible = show;
    }
  }

  function renderLayerToggles() {
    layersEl.textContent = "";
    const counts = new Map();
    for (const node of currentGraph().nodes) counts.set(node.layer, (counts.get(node.layer) || 0) + 1);
    for (const layer of DATA.layers) {
      const count = counts.get(layer.key);
      if (!count) continue;
      const label = document.createElement("label");
      label.className = "check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !hiddenLayers.has(layer.key);
      input.addEventListener("change", () => {
        if (input.checked) hiddenLayers.delete(layer.key);
        else hiddenLayers.add(layer.key);
        applyVisibility();
      });
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = layer.color;
      label.append(input, swatch, document.createTextNode(`${layer.key} (${count})`));
      layersEl.appendChild(label);
    }
  }

  function applyVisibility() {
    const q = query();
    let shown = 0;
    for (const node of currentGraph().nodes) {
      const mesh = meshById.get(node.id);
      const label = labelById.get(node.id);
      if (!mesh) continue;
      const layerOn = !hiddenLayers.has(node.layer);
      const match = nodeMatches(node);
      mesh.visible = layerOn;
      if (label) label.style.display = layerOn && (match || !q) ? "" : "none";
      mesh.material.opacity = !q || match ? 1 : 0.14;
      if (layerOn && match) shown += 1;
    }
    syncEdges();
    refreshAppearance();
    searchCountEl.textContent = q ? `一致 ${shown} 件` : "";
  }

  function neighbors(id) {
    const out = [];
    const inn = [];
    for (const obj of edgeObjs) {
      if (obj.edge.source === id) out.push(obj);
      else if (obj.edge.target === id) inn.push(obj);
    }
    return { out, inn };
  }

  function refreshAppearance() {
    const hot = hoverId ? neighbors(hoverId) : null;
    const linked = new Set();
    if (hot) {
      linked.add(hoverId);
      for (const obj of hot.out) linked.add(obj.edge.target);
      for (const obj of hot.inn) linked.add(obj.edge.source);
    }
    for (const mesh of meshById.values()) {
      const id = mesh.userData.id;
      const on = hoverId && linked.has(id);
      mesh.material.emissive.set(on ? mesh.userData.node.color : 0x000000);
      mesh.material.emissiveIntensity = id === hoverId ? 0.7 : on ? 0.28 : 0;
      const label = labelById.get(id);
      if (label) label.classList.toggle("hot", id === hoverId);
    }
    for (const obj of edgeObjs) {
      const on = hoverId && (obj.edge.source === hoverId || obj.edge.target === hoverId);
      const dim = hoverId && !on;
      obj.line.material.opacity = on ? 1 : dim ? 0.045 : 0.55;
      obj.head.material.opacity = on ? 1 : dim ? 0.05 : 0.9;
    }
  }

  function showTooltip(node, clientX, clientY) {
    const { out, inn } = neighbors(node.id);
    const lines = [node.label, `${node.layer} · ${node.cluster} · ${node.language}`];
    if (node.path) lines.push(node.path);
    if (node.files > 1 || node.language === "asmdef") lines.push(`ファイル ${node.files}`);
    const fmt = (obj, arrow) => {
      const otherId = arrow === "→" ? obj.edge.target : obj.edge.source;
      const other = meshById.get(otherId)?.userData.node;
      const kinds = obj.edge.kinds.map((k) => KIND_LABEL[k] || k).join(", ");
      return `${arrow} ${other ? other.label : otherId}（${kinds}）`;
    };
    if (out.length) {
      lines.push("依存先:");
      for (const obj of out.slice(0, 8)) lines.push(fmt(obj, "→"));
      if (out.length > 8) lines.push(`  他 ${out.length - 8} 件`);
    }
    if (inn.length) {
      lines.push("依存元:");
      for (const obj of inn.slice(0, 8)) lines.push(fmt(obj, "←"));
      if (inn.length > 8) lines.push(`  他 ${inn.length - 8} 件`);
    }
    tooltipEl.textContent = lines.join("\n");
    tooltipEl.style.display = "block";
    const pad = 14;
    const w = tooltipEl.offsetWidth;
    const h = tooltipEl.offsetHeight;
    let x = clientX + 16;
    let y = clientY + 16;
    if (x + w > window.innerWidth - pad) x = clientX - w - 12;
    if (y + h > window.innerHeight - pad) y = clientY - h - 12;
    tooltipEl.style.left = `${Math.max(pad, x)}px`;
    tooltipEl.style.top = `${Math.max(pad, y)}px`;
  }

  function hideTooltip() {
    tooltipEl.style.display = "none";
  }

  function pick(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...meshById.values()].filter((m) => m.visible), false);
    return hits[0] || null;
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    const hit = pick(event);
    if (hit) {
      const mesh = hit.object;
      camera.getWorldDirection(camDir);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, mesh.position);
      drag = { kind: "node", mesh, plane, pointerId: event.pointerId };
      hoverId = mesh.userData.id;
      refreshAppearance();
      showTooltip(mesh.userData.node, event.clientX, event.clientY);
    } else {
      drag = {
        kind: "orbit",
        x: event.clientX,
        y: event.clientY,
        theta: view.theta,
        phi: view.phi,
        pointerId: event.pointerId,
      };
    }
    renderer.domElement.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (drag && drag.kind === "orbit") {
      view.theta = drag.theta - (event.clientX - drag.x) * 0.005;
      view.phi = Math.min(Math.PI - 0.08, Math.max(0.08, drag.phi - (event.clientY - drag.y) * 0.005));
      return;
    }
    if (drag && drag.kind === "node") {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(drag.plane, hit)) {
        drag.mesh.position.copy(hit);
        syncEdges();
      }
      showTooltip(drag.mesh.userData.node, event.clientX, event.clientY);
      return;
    }
    const hit = pick(event);
    const id = hit ? hit.object.userData.id : null;
    if (id !== hoverId) {
      hoverId = id;
      refreshAppearance();
    }
    if (hit) showTooltip(hit.object.userData.node, event.clientX, event.clientY);
    else hideTooltip();
  }

  function onPointerUp(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId);
    }
  }

  function project(vec) {
    camera.getWorldDirection(camDir);
    if (vec.clone().sub(camera.position).dot(camDir) <= 0) return null;
    const p = vec.clone().project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + (p.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-p.y * 0.5 + 0.5) * rect.height,
    };
  }

  function syncLabels() {
    for (const [id, el] of labelById) {
      const mesh = meshById.get(id);
      if (!mesh || !mesh.visible || el.style.display === "none") {
        el.style.visibility = "hidden";
        continue;
      }
      const pos = project(mesh.position);
      if (!pos) {
        el.style.visibility = "hidden";
        continue;
      }
      el.style.visibility = "visible";
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
    }
    for (const cluster of clusterLabels) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let n = 0;
      let maxY = -Infinity;
      for (const id of cluster.ids) {
        const mesh = meshById.get(id);
        if (!mesh || !mesh.visible) continue;
        sx += mesh.position.x;
        sy += mesh.position.y;
        sz += mesh.position.z;
        maxY = Math.max(maxY, mesh.position.y + mesh.userData.radius);
        n += 1;
      }
      if (!n) {
        cluster.el.style.visibility = "hidden";
        continue;
      }
      const anchor = new THREE.Vector3(sx / n, maxY + 0.85, sz / n);
      const pos = project(anchor);
      if (!pos) {
        cluster.el.style.visibility = "hidden";
        continue;
      }
      cluster.el.style.visibility = "visible";
      cluster.el.style.left = `${pos.x}px`;
      cluster.el.style.top = `${pos.y}px`;
    }
  }

  function screenOf(text) {
    const q = String(text).toLowerCase();
    const node = currentGraph().nodes.find(
      (n) => n.label.toLowerCase().includes(q) || (n.path || "").toLowerCase().includes(q),
    );
    if (!node) return null;
    const mesh = meshById.get(node.id);
    if (!mesh) return null;
    const pos = project(mesh.position);
    if (!pos) return null;
    return { x: pos.x, y: pos.y, id: node.id, label: node.label };
  }

  modeEl.addEventListener("change", () => {
    mode = modeEl.value === "assembly" ? "assembly" : "file";
    buildScene();
    hideTooltip();
  });
  searchEl.addEventListener("input", applyVisibility);
  searchEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const node = currentGraph().nodes.find((n) => nodeMatches(n) && !hiddenLayers.has(n.layer));
    if (!node) return;
    const mesh = meshById.get(node.id);
    if (!mesh) return;
    view.target.copy(mesh.position);
    view.radius = 9;
  });
  document.getElementById("reset").addEventListener("click", () => {
    for (const mesh of meshById.values()) mesh.position.copy(mesh.userData.home);
    view.theta = 0.62;
    view.phi = 1.05;
    syncEdges();
    fitRadius();
  });

  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("pointerleave", (event) => {
    if (!drag) {
      hoverId = null;
      refreshAppearance();
      hideTooltip();
    }
    onPointerUp(event);
  });
  renderer.domElement.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : 1;
      view.radius = Math.min(220, Math.max(2.2, view.radius * Math.exp(event.deltaY * scale * 0.0011)));
    },
    { passive: false },
  );
  renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());
  window.addEventListener("resize", resize);

  window.__depgraph3d = {
    ready: false,
    get mode() {
      return mode;
    },
    nodeCount: () => currentGraph().nodes.length,
    edgeCount: () => currentGraph().edges.length,
    screenOf,
  };

  resize();
  buildScene();
  let frames = 0;
  function animate() {
    requestAnimationFrame(animate);
    updateCamera();
    renderer.render(scene, camera);
    syncLabels();
    frames += 1;
    if (frames === 2) window.__depgraph3d.ready = true;
  }
  animate();
})();
