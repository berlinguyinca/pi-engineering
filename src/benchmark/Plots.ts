/**
 * SVG plot generator — produces the 12 required benchmark plots as dependency-free
 * SVG files (SVG chosen over PNG to avoid a native canvas dependency; it renders
 * in browsers and markdown). Each plot is a standalone `<svg>` string.
 */

import type { Condition, ConditionSummary, RunMetrics } from "./Metrics.ts";

const W = 560;
const H = 320;
const PADL = 56;
const PADR = 16;
const PADT = 24;
const PADB = 40;
const PLOT_W = W - PADL - PADR;
const PLOT_H = H - PADT - PADB;

const NATIVE = "#d94f4f";
const BLACKHOLE = "#2f7fd1";

function svgHeader(title: string, xlabel: string, ylabel: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<text x="${W / 2}" y="16" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="bold">${title}</text>`,
    `<text x="${W / 2}" y="${H - 8}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#555">${xlabel}</text>`,
    `<text x="14" y="${H / 2}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#555" transform="rotate(-90 14 ${H / 2})">${ylabel}</text>`,
    `<line x1="${PADL}" y1="${H - PADB}" x2="${W - PADR}" y2="${H - PADB}" stroke="#999"/>`,
    `<line x1="${PADL}" y1="${PADT}" x2="${PADL}" y2="${H - PADB}" stroke="#999"/>`,
  ].join("\n");
}

function svgFooter(): string {
  return `</svg>`;
}

function legend(): string {
  return [
    `<rect x="${W - PADR - 150}" y="${PADT}" width="150" height="34" fill="#fff" stroke="#ccc"/>`,
    `<circle cx="${W - PADR - 138}" cy="${PADT + 12}" r="5" fill="${NATIVE}"/>`,
    `<text x="${W - PADR - 128}" y="${PADT + 16}" font-family="sans-serif" font-size="11">native</text>`,
    `<circle cx="${W - PADR - 138}" cy="${PADT + 27}" r="5" fill="${BLACKHOLE}"/>`,
    `<text x="${W - PADR - 128}" y="${PADT + 31}" font-family="sans-serif" font-size="11">blackhole</text>`,
  ].join("\n");
}

function x(i: number, n: number): number {
  if (n <= 1) return PADL + PLOT_W / 2;
  return PADL + (i / (n - 1)) * PLOT_W;
}
function y(v: number, max: number): number {
  const m = max > 0 ? max : 1;
  return PADT + PLOT_H - (v / m) * PLOT_H;
}

function lineSeries(points: Array<[number, number]>, color: string): string {
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`;
}

function dotSeries(points: Array<[number, number]>, color: string): string {
  return points
    .map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" fill="${color}"/>`)
    .join("\n");
}

function yTicks(max: number): string {
  const ticks = 4;
  return Array.from({ length: ticks + 1 }, (_, i) => {
    const v = (max / ticks) * i;
    const ty = y(v, max);
    return `<text x="${PADL - 6}" y="${ty + 3}" text-anchor="end" font-family="sans-serif" font-size="9" fill="#777">${v.toFixed(0)}</text>`;
  }).join("\n");
}

/** Extract per-run series for a condition across runs (in submission order). */
function series(runs: RunMetrics[], condition: Condition, fn: (m: RunMetrics) => number): number[] {
  return runs.filter((r) => r.condition === condition).map(fn);
}

/**
 * Plot 1: context efficiency over repeated runs (context tokens per run).
 */
export function plotContextTokens(runs: RunMetrics[]): string {
  const nat = series(runs, "native", (m) => m.contextTokens);
  const bh = series(runs, "blackhole", (m) => m.contextTokens);
  const all = [...nat, ...bh];
  const max = Math.max(...all, 1);
  const n = Math.max(nat.length, bh.length);
  const pts = (arr: number[]) => arr.map((v, i) => [x(i, Math.max(arr.length, 2)), y(v, max)] as [number, number]);
  return [
    svgHeader("Context tokens per run (repeated task)", "run", "context tokens"),
    yTicks(max),
    lineSeries(pts(nat), NATIVE),
    dotSeries(pts(nat), NATIVE),
    lineSeries(pts(bh), BLACKHOLE),
    dotSeries(pts(bh), BLACKHOLE),
    legend(),
    svgFooter(),
  ].join("\n");
}

/** Plot 2: recall rate per run. */
export function plotRecall(runs: RunMetrics[]): string {
  const bh = runs.filter((r) => r.condition === "blackhole");
  const rate = bh.map((m) =>
    m.recallHits + m.recallMisses === 0 ? 0 : m.recallHits / (m.recallHits + m.recallMisses),
  );
  const max = 1;
  const pts = rate.map((v, i) => [x(i, Math.max(rate.length, 2)), y(v, max)] as [number, number]);
  return [
    svgHeader("Session recall rate per run (blackhole)", "run", "recall rate"),
    yTicks(max),
    lineSeries(pts, BLACKHOLE),
    dotSeries(pts, BLACKHOLE),
    svgFooter(),
  ].join("\n");
}

/** Plot 3: input tokens per run (A/B). */
export function plotInputTokens(runs: RunMetrics[]): string {
  const nat = series(runs, "native", (m) => m.inputTokens);
  const bh = series(runs, "blackhole", (m) => m.inputTokens);
  const max = Math.max(...nat, ...bh, 1);
  const n = Math.max(nat.length, bh.length);
  const pts = (arr: number[]) => arr.map((v, i) => [x(i, Math.max(arr.length, 2)), y(v, max)] as [number, number]);
  return [
    svgHeader("Input tokens per run", "run", "input tokens"),
    yTicks(max),
    lineSeries(pts(nat), NATIVE),
    dotSeries(pts(nat), NATIVE),
    lineSeries(pts(bh), BLACKHOLE),
    dotSeries(pts(bh), BLACKHOLE),
    legend(),
    svgFooter(),
  ].join("\n");
}

/** Plot 4: duration per run. */
export function plotDuration(runs: RunMetrics[]): string {
  const nat = series(runs, "native", (m) => m.durationMs);
  const bh = series(runs, "blackhole", (m) => m.durationMs);
  const max = Math.max(...nat, ...bh, 1);
  const n = Math.max(nat.length, bh.length);
  const pts = (arr: number[]) => arr.map((v, i) => [x(i, Math.max(arr.length, 2)), y(v, max)] as [number, number]);
  return [
    svgHeader("Duration per run (ms)", "run", "ms"),
    yTicks(max),
    lineSeries(pts(nat), NATIVE),
    dotSeries(pts(nat), NATIVE),
    lineSeries(pts(bh), BLACKHOLE),
    dotSeries(pts(bh), BLACKHOLE),
    legend(),
    svgFooter(),
  ].join("\n");
}

/** Plot 5: quality score per run. */
export function plotQuality(runs: RunMetrics[]): string {
  const nat = series(runs, "native", (m) => m.quality);
  const bh = series(runs, "blackhole", (m) => m.quality);
  const max = 1;
  const pts = (arr: number[]) => arr.map((v, i) => [x(i, Math.max(arr.length, 2)), y(v, max)] as [number, number]);
  return [
    svgHeader("Quality score per run", "run", "quality 0..1"),
    yTicks(max),
    lineSeries(pts(nat), NATIVE),
    dotSeries(pts(nat), NATIVE),
    lineSeries(pts(bh), BLACKHOLE),
    dotSeries(pts(bh), BLACKHOLE),
    legend(),
    svgFooter(),
  ].join("\n");
}

/** Plot 6: autonomy (tool calls) per run. */
export function plotToolCalls(runs: RunMetrics[]): string {
  const nat = series(runs, "native", (m) => m.toolCalls);
  const bh = series(runs, "blackhole", (m) => m.toolCalls);
  const max = Math.max(...nat, ...bh, 1);
  const pts = (arr: number[]) => arr.map((v, i) => [x(i, Math.max(arr.length, 2)), y(v, max)] as [number, number]);
  return [
    svgHeader("Autonomy (tool calls) per run", "run", "tool calls"),
    yTicks(max),
    lineSeries(pts(nat), NATIVE),
    dotSeries(pts(nat), NATIVE),
    lineSeries(pts(bh), BLACKHOLE),
    dotSeries(pts(bh), BLACKHOLE),
    legend(),
    svgFooter(),
  ].join("\n");
}

/** Plot 7: session memory size per run. */
export function plotEntries(runs: RunMetrics[]): string {
  const bh = series(runs, "blackhole", (m) => m.entries);
  const max = Math.max(...bh, 1);
  const pts = bh.map((v, i) => [x(i, Math.max(bh.length, 2)), y(v, max)] as [number, number]);
  return [
    svgHeader("Session memory entries per run", "run", "entries"),
    yTicks(max),
    lineSeries(pts, BLACKHOLE),
    dotSeries(pts, BLACKHOLE),
    svgFooter(),
  ].join("\n");
}

/** Plot 8: compactions per run. */
export function plotCompactions(runs: RunMetrics[]): string {
  const bh = series(runs, "blackhole", (m) => m.compactions);
  const max = Math.max(...bh, 1);
  const pts = bh.map((v, i) => [x(i, Math.max(bh.length, 2)), y(v, max)] as [number, number]);
  return [
    svgHeader("Compactions per run", "run", "compactions"),
    yTicks(max),
    lineSeries(pts, BLACKHOLE),
    dotSeries(pts, BLACKHOLE),
    svgFooter(),
  ].join("\n");
}

/** Plot 9: context efficiency (quality per token) by condition (bar). */
export function plotEfficiency(native: ConditionSummary, blackhole: ConditionSummary): string {
  const vals = [native.contextEfficiency, blackhole.contextEfficiency];
  const max = Math.max(...vals, 1);
  const bw = 60;
  const cx: [number, number] = [PADL + PLOT_W / 2 - bw - 12, PADL + PLOT_W / 2 + 12];
  const bars = cx.flatMap((cx0, i) => {
    const bh = ((vals[i] ?? 0) / max) * PLOT_H;
    return [
      `<rect x="${cx0}" y="${H - PADB - bh}" width="${bw}" height="${bh}" fill="${i === 0 ? NATIVE : BLACKHOLE}"/>`,
      `<text x="${cx0 + bw / 2}" y="${H - PADB - bh - 6}" text-anchor="middle" font-family="sans-serif" font-size="11">${(vals[i] ?? 0).toFixed(2)}</text>`,
    ];
  });
  return [
    svgHeader("Context efficiency (quality / 1k context tokens)", "condition", "efficiency"),
    `<text x="${cx[0]! + bw / 2}" y="${H - 14}" text-anchor="middle" font-family="sans-serif" font-size="11">native</text>`,
    `<text x="${cx[1]! + bw / 2}" y="${H - 14}" text-anchor="middle" font-family="sans-serif" font-size="11">blackhole</text>`,
    ...bars,
    svgFooter(),
  ].join("\n");
}

/** Plot 10: recall rate by condition (bar). */
export function plotRecallBar(native: ConditionSummary, blackhole: ConditionSummary): string {
  const vals = [native.recallRate, blackhole.recallRate];
  const max = 1;
  const bw = 60;
  const cx: [number, number] = [PADL + PLOT_W / 2 - bw - 12, PADL + PLOT_W / 2 + 12];
  const bars = cx.flatMap((cx0, i) => {
    const bh = ((vals[i] ?? 0) / max) * PLOT_H;
    return [
      `<rect x="${cx0}" y="${H - PADB - bh}" width="${bw}" height="${bh}" fill="${i === 0 ? NATIVE : BLACKHOLE}"/>`,
      `<text x="${cx0 + bw / 2}" y="${H - PADB - bh - 6}" text-anchor="middle" font-family="sans-serif" font-size="11">${((vals[i] ?? 0) * 100).toFixed(0)}%</text>`,
    ];
  });
  return [
    svgHeader("Recall rate by condition", "condition", "recall rate"),
    `<text x="${cx[0]! + bw / 2}" y="${H - 14}" text-anchor="middle" font-family="sans-serif" font-size="11">native</text>`,
    `<text x="${cx[1]! + bw / 2}" y="${H - 14}" text-anchor="middle" font-family="sans-serif" font-size="11">blackhole</text>`,
    ...bars,
    svgFooter(),
  ].join("\n");
}

/** Plot 11: throughput (runs per unit time) by condition. */
export function plotThroughput(native: ConditionSummary, blackhole: ConditionSummary): string {
  const thr = (s: ConditionSummary) => (s.avgDurationMs > 0 ? 1 / (s.avgDurationMs / 1000) : 0);
  const vals = [thr(native), thr(blackhole)];
  const max = Math.max(...vals, 0.01);
  const bw = 60;
  const cx: [number, number] = [PADL + PLOT_W / 2 - bw - 12, PADL + PLOT_W / 2 + 12];
  const bars = cx.flatMap((cx0, i) => {
    const bh = ((vals[i] ?? 0) / max) * PLOT_H;
    return [
      `<rect x="${cx0}" y="${H - PADB - bh}" width="${bw}" height="${bh}" fill="${i === 0 ? NATIVE : BLACKHOLE}"/>`,
      `<text x="${cx0 + bw / 2}" y="${H - PADB - bh - 6}" text-anchor="middle" font-family="sans-serif" font-size="11">${(vals[i] ?? 0).toFixed(2)}</text>`,
    ];
  });
  return [
    svgHeader("Throughput (runs / sec)", "condition", "runs/sec"),
    `<text x="${cx[0]! + bw / 2}" y="${H - 14}" text-anchor="middle" font-family="sans-serif" font-size="11">native</text>`,
    `<text x="${cx[1]! + bw / 2}" y="${H - 14}" text-anchor="middle" font-family="sans-serif" font-size="11">blackhole</text>`,
    ...bars,
    svgFooter(),
  ].join("\n");
}

/** Plot 12: quality by condition (bar). */
export function plotQualityBar(native: ConditionSummary, blackhole: ConditionSummary): string {
  const vals = [native.avgQuality, blackhole.avgQuality];
  const max = 1;
  const bw = 60;
  const cx: [number, number] = [PADL + PLOT_W / 2 - bw - 12, PADL + PLOT_W / 2 + 12];
  const bars = cx.flatMap((cx0, i) => {
    const bh = ((vals[i] ?? 0) / max) * PLOT_H;
    return [
      `<rect x="${cx0}" y="${H - PADB - bh}" width="${bw}" height="${bh}" fill="${i === 0 ? NATIVE : BLACKHOLE}"/>`,
      `<text x="${cx0 + bw / 2}" y="${H - PADB - bh - 6}" text-anchor="middle" font-family="sans-serif" font-size="11">${(vals[i] ?? 0).toFixed(2)}</text>`,
    ];
  });
  return [
    svgHeader("Quality by condition", "condition", "quality 0..1"),
    `<text x="${cx[0]! + bw / 2}" y="${H - 14}" text-anchor="middle" font-family="sans-serif" font-size="11">native</text>`,
    `<text x="${cx[1]! + bw / 2}" y="${H - 14}" text-anchor="middle" font-family="sans-serif" font-size="11">blackhole</text>`,
    ...bars,
    svgFooter(),
  ].join("\n");
}

export interface PlotSpec {
  name: string;
  title: string;
  svg: string;
}

/** Generate all 12 required plots. */
export function generatePlots(runs: RunMetrics[], native: ConditionSummary, blackhole: ConditionSummary): PlotSpec[] {
  return [
    { name: "01-context-tokens", title: "Context tokens per run", svg: plotContextTokens(runs) },
    { name: "02-recall-rate", title: "Recall rate per run", svg: plotRecall(runs) },
    { name: "03-input-tokens", title: "Input tokens per run", svg: plotInputTokens(runs) },
    { name: "04-duration", title: "Duration per run", svg: plotDuration(runs) },
    { name: "05-quality", title: "Quality per run", svg: plotQuality(runs) },
    { name: "06-autonomy", title: "Autonomy per run", svg: plotToolCalls(runs) },
    { name: "07-session-entries", title: "Session entries per run", svg: plotEntries(runs) },
    { name: "08-compactions", title: "Compactions per run", svg: plotCompactions(runs) },
    { name: "09-context-efficiency", title: "Context efficiency", svg: plotEfficiency(native, blackhole) },
    { name: "10-recall-bar", title: "Recall rate by condition", svg: plotRecallBar(native, blackhole) },
    { name: "11-throughput", title: "Throughput", svg: plotThroughput(native, blackhole) },
    { name: "12-quality-bar", title: "Quality by condition", svg: plotQualityBar(native, blackhole) },
  ];
}
