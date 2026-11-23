"use client";

import React, { useEffect, useRef } from "react";

interface LatticeNode {
  ox: number;
  oy: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function ReactiveAtlasCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let nodes: LatticeNode[] = [];
    let rafId = 0;
    let angleOffset = 0;

    const pointer = {
      x: -9999,
      y: -9999,
      active: false,
    };

    const buildLattice = () => {
      nodes = [];
      const spacing = 54;
      const cols = Math.ceil(width / spacing) + 1;
      const rows = Math.ceil(height / spacing) + 1;
      const startX = (width - (cols - 1) * spacing) * 0.5;
      const startY = (height - (rows - 1) * spacing) * 0.5;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const ox = startX + c * spacing;
          const oy = startY + r * spacing;
          nodes.push({ ox, oy, x: ox, y: oy, vx: 0, vy: 0 });
        }
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildLattice();
    };

    const handleMouseMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x >= -40 && x <= rect.width + 40 && y >= -40 && y <= rect.height + 40) {
        pointer.x = x;
        pointer.y = y;
        pointer.active = true;
      } else {
        pointer.active = false;
      }
    };

    const handleMouseLeave = () => {
      pointer.active = false;
    };

    const renderFrame = () => {
      ctx.clearRect(0, 0, width, height);

      // 1. Subtle millimeter background lines
      ctx.strokeStyle = "rgba(168, 150, 122, 0.22)";
      ctx.lineWidth = 0.75;
      const step = 54;
      const cols = Math.ceil(width / step) + 1;
      const rows = Math.ceil(height / step) + 1;
      const startX = (width - (cols - 1) * step) * 0.5;
      const startY = (height - (rows - 1) * step) * 0.5;

      ctx.beginPath();
      for (let c = 0; c < cols; c++) {
        const x = startX + c * step;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let r = 0; r < rows; r++) {
        const y = startY + r * step;
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();

      // 2. Concentric astrolabe / compass rings centered behind the atlas title
      const cx = width * 0.5;
      const cy = height * 0.44;
      const pointerAngle = pointer.active
        ? Math.atan2(pointer.y - cy, pointer.x - cx)
        : angleOffset;
      const distToCenter = pointer.active
        ? Math.hypot(pointer.x - cx, pointer.y - cy)
        : 999;
      const ringGlow = Math.max(0, 1 - distToCenter / 360);

      const radii = [
        Math.min(width, height) * 0.22,
        Math.min(width, height) * 0.33,
        Math.min(width, height) * 0.44,
      ];

      radii.forEach((radius, idx) => {
        if (radius <= 20) return;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(
          (idx % 2 === 0 ? 1 : -1) *
            (angleOffset * (0.18 + idx * 0.08) + pointerAngle * 0.04)
        );
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.strokeStyle =
          idx === 1
            ? `rgba(181, 137, 46, ${0.22 + ringGlow * 0.32})`
            : `rgba(89, 74, 60, ${0.14 + ringGlow * 0.14})`;
        ctx.lineWidth = idx === 1 ? 1.15 : 0.85;
        if (idx === 2) {
          ctx.setLineDash([4, 6]);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Degree ticks along outer astrolabe ring
        const tickCount = idx === 1 ? 36 : 24;
        for (let t = 0; t < tickCount; t++) {
          const theta = (t / tickCount) * Math.PI * 2;
          const inner = radius - (t % 3 === 0 ? 7 : 3.5);
          ctx.beginPath();
          ctx.moveTo(Math.cos(theta) * inner, Math.sin(theta) * inner);
          ctx.lineTo(Math.cos(theta) * radius, Math.sin(theta) * radius);
          ctx.strokeStyle =
            t % 3 === 0
              ? `rgba(181, 137, 46, ${0.32 + ringGlow * 0.35})`
              : "rgba(89, 74, 60, 0.18)";
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
        ctx.restore();
      });

      // 3. Benner-style geometric cycle triangles along the lower horizon
      const baseHorizonY = height * 0.86;
      const cycleAmp = Math.min(height * 0.14, 96);
      const vertexCount = 9;
      const cycleVertices: Array<{ x: number; y: number }> = [];
      for (let v = 0; v < vertexCount; v++) {
        const x = (v / (vertexCount - 1)) * width;
        const y =
          v % 2 === 0
            ? baseHorizonY
            : baseHorizonY - cycleAmp * (0.65 + 0.35 * Math.sin(v + angleOffset * 0.4));
        cycleVertices.push({ x, y });
      }

      ctx.beginPath();
      cycleVertices.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.strokeStyle = "rgba(158, 42, 43, 0.2)";
      ctx.lineWidth = 1;
      ctx.stroke();

      for (let v = 0; v < cycleVertices.length - 2; v += 2) {
        const a = cycleVertices[v];
        const b = cycleVertices[v + 2];
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = "rgba(89, 74, 60, 0.16)";
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }

      for (const pt of cycleVertices) {
        const dist = pointer.active
          ? Math.hypot(pointer.x - pt.x, pointer.y - pt.y)
          : 999;
        const prox = Math.max(0, 1 - dist / 180);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2.2 + prox * 2.5, 0, Math.PI * 2);
        ctx.fillStyle =
          prox > 0.15
            ? `rgba(181, 137, 46, ${0.4 + prox * 0.55})`
            : "rgba(158, 42, 43, 0.28)";
        ctx.fill();
      }

      // 4. Spring-physics millimeter lattice intersections + cursor hairlines
      const influenceRadius = 155;
      const stiffness = 0.09;
      const damping = 0.78;

      for (const node of nodes) {
        let prox = 0;
        if (pointer.active && !prefersReducedMotion) {
          const dx = pointer.x - node.ox;
          const dy = pointer.y - node.oy;
          const dist = Math.hypot(dx, dy);
          if (dist < influenceRadius && dist > 0.001) {
            prox = 1 - dist / influenceRadius;
            const push = prox * 11;
            const tx = node.ox - (dx / dist) * push;
            const ty = node.oy - (dy / dist) * push;
            node.vx = (node.vx + (tx - node.x) * stiffness) * damping;
            node.vy = (node.vy + (ty - node.y) * stiffness) * damping;
          } else {
            node.vx = (node.vx + (node.ox - node.x) * stiffness) * damping;
            node.vy = (node.vy + (node.oy - node.y) * stiffness) * damping;
          }
          node.x += node.vx;
          node.y += node.vy;
        } else {
          node.x = node.ox;
          node.y = node.oy;
        }

        if (prox > 0.05) {
          // Hairline connection toward cursor
          ctx.beginPath();
          ctx.moveTo(node.x, node.y);
          ctx.lineTo(pointer.x, pointer.y);
          ctx.strokeStyle = `rgba(181, 137, 46, ${prox * 0.34})`;
          ctx.lineWidth = 0.75;
          ctx.stroke();

          // Burnished gold intersection diamond
          ctx.fillStyle = `rgba(181, 137, 46, ${0.35 + prox * 0.6})`;
          ctx.beginPath();
          ctx.arc(node.x, node.y, 1.4 + prox * 1.8, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = "rgba(89, 74, 60, 0.22)";
          ctx.fillRect(node.x - 0.75, node.y - 0.75, 1.5, 1.5);
        }
      }

      if (!prefersReducedMotion) {
        angleOffset += 0.0022;
        rafId = window.requestAnimationFrame(renderFrame);
      }
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    document.addEventListener("mouseleave", handleMouseLeave);

    renderFrame();

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      window.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
