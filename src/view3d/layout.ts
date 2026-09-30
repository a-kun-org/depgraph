export interface LayoutItem {
  id: string;
  layer: string;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 層ごとに 3D の塊へ置く。
 * 層の order は使わない。塊の中心は同じ高さの円周上で、上下や帯には並べない。
 * 塊の中のノードは球面上に散らす。
 */
export function layoutPositions(items: LayoutItem[]): Map<string, Vec3> {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const layer = item.layer || "未分類";
    const list = groups.get(layer) ?? [];
    list.push(item.id);
    groups.set(layer, list);
  }

  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b, "ja"));
  const radii = names.map((name) => clusterRadius(groups.get(name)!.length));
  const maxR = radii.reduce((m, r) => Math.max(m, r), 0);
  const ring = names.length <= 1 ? 0 : Math.max(8, maxR * 2.8 + 2);

  const out = new Map<string, Vec3>();
  names.forEach((name, i) => {
    const angle = (i / names.length) * Math.PI * 2;
    const cx = Math.cos(angle) * ring;
    const cz = Math.sin(angle) * ring;
    const members = [...(groups.get(name) ?? [])].sort((a, b) => a.localeCompare(b));
    const radius = radii[i] ?? 1;
    const pts = members.map((_, index) => spherePoint(index, members.length, radius));
    separate(pts, 1.15);
    members.forEach((id, index) => {
      const p = pts[index]!;
      out.set(id, { x: cx + p.x, y: p.y, z: cz + p.z });
    });
  });
  return out;
}

function clusterRadius(count: number): number {
  if (count <= 1) return 0;
  return 1.15 * Math.sqrt(count);
}

function spherePoint(index: number, count: number, radius: number): Vec3 {
  if (count <= 1 || radius === 0) return { x: 0, y: 0, z: 0 };
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (index / (count - 1)) * 2;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = golden * index;
  return {
    x: Math.cos(theta) * ring * radius,
    y: y * radius,
    z: Math.sin(theta) * ring * radius,
  };
}

function separate(pts: Vec3[], minDist: number) {
  for (let iter = 0; iter < 8; iter++) {
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i]!;
        const b = pts[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dz = b.z - a.z;
        let d = Math.hypot(dx, dy, dz);
        if (d < 1e-6) {
          b.x += 0.01;
          dx += 0.01;
          d = Math.hypot(dx, dy, dz);
        }
        if (d >= minDist) continue;
        const push = (minDist - d) / 2;
        const ux = (dx / d) * push;
        const uy = (dy / d) * push;
        const uz = (dz / d) * push;
        a.x -= ux;
        a.y -= uy;
        a.z -= uz;
        b.x += ux;
        b.y += uy;
        b.z += uz;
      }
    }
  }
}
