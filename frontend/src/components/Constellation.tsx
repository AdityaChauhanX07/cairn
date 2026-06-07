import { useEffect, useRef } from 'react';
import * as THREE from 'three';

// The living "dependency constellation" — a three.js point cloud with a denser
// central spine that reads as a cairn. Isolated in its own module so it can be
// React.lazy()-loaded: three.js lands in a separate chunk and the hero text
// paints immediately while this streams in behind it. Everything the effect
// creates (renderer, geometries, materials, textures, listeners, RAF) is torn
// down on unmount, so re-mounts (incl. StrictMode's double-invoke) stay clean.
export default function Constellation() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0a0911, 0.018);

    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(0, 0, 42);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    // Soft round sprite for each node.
    function makeSprite(): THREE.CanvasTexture {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.3, 'rgba(255,222,186,0.85)');
      r.addColorStop(1, 'rgba(255,180,120,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    }

    const group = new THREE.Group();
    scene.add(group);

    // Generate nodes — a flattened cloud with a denser central vertical "spine".
    const N = 170;
    const pts: THREE.Vector3[] = [];
    const cols: number[] = [];
    const palette = [
      [0.92, 0.62, 0.36],
      [0.87, 0.78, 0.64],
      [0.62, 0.72, 0.86],
      [1.0, 0.92, 0.82],
    ];
    for (let i = 0; i < N; i++) {
      const central = i < 46;
      let x: number;
      let y: number;
      let z: number;
      if (central) {
        const t = i / 46;
        y = (t - 0.5) * 30 + (Math.random() - 0.5) * 4;
        const rad = 2.5 + Math.random() * 5 * (1 - Math.abs(t - 0.5) * 0.8);
        const a = Math.random() * Math.PI * 2;
        x = Math.cos(a) * rad;
        z = Math.sin(a) * rad;
      } else {
        x = (Math.random() - 0.5) * 70;
        y = (Math.random() - 0.5) * 44;
        z = (Math.random() - 0.5) * 46;
      }
      pts.push(new THREE.Vector3(x, y, z));
      const c = palette[central ? (Math.random() < 0.7 ? 0 : 3) : (Math.random() * palette.length) | 0];
      cols.push(c[0], c[1], c[2]);
    }

    // Points.
    const sprite = makeSprite();
    const pg = new THREE.BufferGeometry();
    const parr = new Float32Array(N * 3);
    pts.forEach((p, i) => {
      parr[i * 3] = p.x;
      parr[i * 3 + 1] = p.y;
      parr[i * 3 + 2] = p.z;
    });
    pg.setAttribute('position', new THREE.BufferAttribute(parr, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols), 3));
    const pmat = new THREE.PointsMaterial({
      size: 1.5,
      map: sprite,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.95,
      sizeAttenuation: true,
    });
    group.add(new THREE.Points(pg, pmat));

    // Edges (nearest neighbours, capped).
    const lp: number[] = [];
    const lc: number[] = [];
    const TH = 15;
    const MAXE = 3;
    for (let i = 0; i < N; i++) {
      let made = 0;
      const d: [number, number][] = [];
      for (let j = i + 1; j < N; j++) {
        const dist = pts[i].distanceTo(pts[j]);
        if (dist < TH) d.push([dist, j]);
      }
      d.sort((a, b) => a[0] - b[0]);
      for (const [dist, j] of d) {
        if (made >= MAXE) break;
        made++;
        const f = 1 - dist / TH;
        lp.push(pts[i].x, pts[i].y, pts[i].z, pts[j].x, pts[j].y, pts[j].z);
        const r = 0.87 * f + 0.2;
        const g = 0.54 * f + 0.12;
        const b = 0.32 * f + 0.1;
        lc.push(r, g, b, r, g, b);
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lp), 3));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lc), 3));
    const lmat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    group.add(new THREE.LineSegments(lg, lmat));

    // Interaction — parallax toward the cursor.
    let mx = 0;
    let my = 0;
    let tx = 0;
    let ty = 0;
    const onMouse = (e: MouseEvent) => {
      tx = e.clientX / window.innerWidth - 0.5;
      ty = e.clientY / window.innerHeight - 0.5;
    };
    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('mousemove', onMouse, { passive: true });
    window.addEventListener('resize', onResize);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      const t = clock.getElapsedTime();
      mx += (tx - mx) * 0.04;
      my += (ty - my) * 0.04;
      if (!reduce) {
        group.rotation.y = t * 0.04 + mx * 0.5;
        group.rotation.x = Math.sin(t * 0.12) * 0.06 - my * 0.35;
      }
      camera.position.x = mx * 8;
      camera.position.y = -my * 6;
      camera.position.z = 42;
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMouse);
      window.removeEventListener('resize', onResize);
      pg.dispose();
      pmat.dispose();
      lg.dispose();
      lmat.dispose();
      sprite.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={hostRef} className="landing-canvas" />;
}
