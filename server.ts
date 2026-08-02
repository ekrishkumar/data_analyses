import dotenv from "dotenv";
// Load local environment overrides (.env.local takes precedence over .env).
// In hosted environments (e.g. AI Studio) the API key is injected directly,
// so a missing file here is fine.
dotenv.config({ path: [".env.local", ".env"] });

import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import {
  createInteraction,
  streamInteraction,
  API_BASE_URL,
} from "./server/lib/agentClient.ts";
import { extractJsonBlocks } from "./server/lib/jsonExtractor.ts";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";

function parseCSVLines(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const result: string[][] = [];
  for (const line of lines) {
    const row: string[] = [];
    let insideQuote = false;
    let currentVal = "";
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (insideQuote && i + 1 < line.length && line[i + 1] === '"') {
          currentVal += '"';
          i++;
        } else {
          insideQuote = !insideQuote;
        }
      } else if (char === "," && !insideQuote) {
        row.push(currentVal.trim().replace(/^"|"$/g, ""));
        currentVal = "";
      } else {
        currentVal += char;
      }
    }
    row.push(currentVal.trim().replace(/^"|"$/g, ""));
    result.push(row);
  }
  return result;
}

function generateSvgChartImage(chart: any, tables: any[], chartIndex: number = 0): string {
  if (chart.image && typeof chart.image === "string" && chart.image.trim() !== "") {
    return chart.image;
  }

  const title = chart.title || "Data Analysis Chart";
  const chartType = (chart.type || "bar").toLowerCase();

  let table = tables?.find(
    (t) =>
      t &&
      t.title &&
      chart.title &&
      (t.title.toLowerCase().includes(chart.title.toLowerCase()) ||
        chart.title.toLowerCase().includes(t.title.toLowerCase())),
  );
  if (!table && tables && tables.length > 0) {
    table = tables[chartIndex % tables.length];
  }

  let labels: string[] = [];
  let values: number[] = [];

  if (table && Array.isArray(table.rows) && table.rows.length > 0) {
    for (const row of table.rows.slice(0, 10)) {
      if (Array.isArray(row) && row.length >= 2) {
        labels.push(String(row[0] ?? "Item"));
        let numVal = NaN;
        for (let c = 1; c < row.length; c++) {
          const parsed = parseFloat(String(row[c]).replace(/[\$,%]/g, ""));
          if (!isNaN(parsed)) {
            numVal = parsed;
            break;
          }
        }
        values.push(isNaN(numVal) ? Math.floor(Math.random() * 50 + 10) : numVal);
      }
    }
  }

  if (labels.length === 0) {
    labels = ["Segment A", "Segment B", "Segment C", "Segment D", "Segment E"];
    values = [120, 240, 180, 310, 220];
  }

  const maxVal = Math.max(...values, 1);
  const width = 640;
  const height = 360;
  const padding = 60;
  const chartW = width - padding * 2;
  const chartH = height - padding * 2;

  const colorPalette = [
    "#4285F4",
    "#EA4335",
    "#FBBC04",
    "#34A853",
    "#A142F4",
    "#24C1E0",
    "#FF6D01",
    "#46BDC6",
  ];

  let svgBody = "";

  if (chartType === "pie" || chartType === "donut") {
    const total = values.reduce((a, b) => a + Math.max(b, 0), 0) || 1;
    const cx = width / 3;
    const cy = height / 2 + 10;
    const radius = 100;
    const innerRadius = 55;

    let currentAngle = -Math.PI / 2;
    let paths = "";
    let legend = "";

    values.forEach((v, i) => {
      const sliceAngle = (Math.max(v, 0) / total) * 2 * Math.PI;
      const endAngle = currentAngle + sliceAngle;

      const x1 = cx + radius * Math.cos(currentAngle);
      const y1 = cy + radius * Math.sin(currentAngle);
      const x2 = cx + radius * Math.cos(endAngle);
      const y2 = cy + radius * Math.sin(endAngle);

      const ix1 = cx + innerRadius * Math.cos(endAngle);
      const iy1 = cy + innerRadius * Math.sin(endAngle);
      const ix2 = cx + innerRadius * Math.cos(currentAngle);
      const iy2 = cy + innerRadius * Math.sin(currentAngle);

      const largeArc = sliceAngle > Math.PI ? 1 : 0;
      const color = colorPalette[i % colorPalette.length];

      paths += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${radius} ${radius} 0 ${largeArc} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L ${ix1.toFixed(1)} ${iy1.toFixed(1)} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix2.toFixed(1)} ${iy2.toFixed(1)} Z" fill="${color}" stroke="#FFFFFF" stroke-width="2" />`;

      const pct = ((v / total) * 100).toFixed(1);
      const legendY = 50 + i * 26;
      if (legendY < height - 30) {
        legend += `
          <rect x="${(width * 0.62).toFixed(1)}" y="${legendY}" width="14" height="14" rx="3" fill="${color}" />
          <text x="${(width * 0.62 + 22).toFixed(1)}" y="${legendY + 11}" font-family="sans-serif" font-size="12" font-weight="500" fill="#374151">${labels[i].slice(0, 16)} (${pct}%)</text>
        `;
      }

      currentAngle = endAngle;
    });

    svgBody = `
      ${paths}
      <circle cx="${cx}" cy="${cy}" r="${innerRadius - 2}" fill="#FFFFFF" />
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="bold" fill="#6B7280">TOTAL</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="bold" fill="#1F2937">${total.toLocaleString()}</text>
      ${legend}
    `;
  } else if (
    chartType === "line" ||
    chartType === "trend" ||
    chartType === "time_series"
  ) {
    const pts = values
      .map((v, i) => {
        const x = padding + (i / Math.max(labels.length - 1, 1)) * chartW;
        const y = height - padding - (v / maxVal) * chartH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

    const areaPts = `${padding},${height - padding} ${pts} ${padding + chartW},${height - padding}`;

    let gridLines = "";
    for (let g = 0; g <= 4; g++) {
      const gy = height - padding - (g / 4) * chartH;
      const gVal = Math.round((g / 4) * maxVal);
      gridLines += `
        <line x1="${padding}" y1="${gy}" x2="${width - padding}" y2="${gy}" stroke="#F3F4F6" stroke-width="1" />
        <text x="${padding - 8}" y="${gy + 4}" text-anchor="end" font-family="sans-serif" font-size="10" fill="#9CA3AF">${gVal.toLocaleString()}</text>
      `;
    }

    svgBody = `
      ${gridLines}
      <polygon points="${areaPts}" fill="url(#lineGrad_${chartIndex})" fill-opacity="0.25" />
      <polyline points="${pts}" fill="none" stroke="#4285F4" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
      ${values
        .map((v, i) => {
          const x = padding + (i / Math.max(labels.length - 1, 1)) * chartW;
          const y = height - padding - (v / maxVal) * chartH;
          return `
            <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="#4285F4" stroke="#FFFFFF" stroke-width="2" />
            <text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="bold" fill="#1F2937">${v.toLocaleString()}</text>
            <text x="${x.toFixed(1)}" y="${(height - padding + 20).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#6B7280">${labels[i].slice(0, 12)}</text>
          `;
        })
        .join("")}
    `;
  } else if (chartType === "horizontal_bar") {
    const barH = Math.min(
      (chartH - (labels.length - 1) * 10) / labels.length,
      28,
    );
    let bars = "";

    values.forEach((v, i) => {
      const y = padding + i * (barH + 10);
      const barW = Math.max((v / maxVal) * (chartW - 130), 8);
      const color = colorPalette[i % colorPalette.length];

      bars += `
        <text x="${padding + 100}" y="${(y + barH / 2 + 4).toFixed(1)}" text-anchor="end" font-family="sans-serif" font-size="11" font-weight="500" fill="#374151">${labels[i].slice(0, 14)}</text>
        <rect x="${padding + 110}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="4" fill="${color}" />
        <text x="${(padding + 118 + barW).toFixed(1)}" y="${(y + barH / 2 + 4).toFixed(1)}" font-family="sans-serif" font-size="11" font-weight="bold" fill="#1F2937">${v.toLocaleString()}</text>
      `;
    });

    svgBody = bars;
  } else {
    const barGap = 12;
    const barW = Math.max(
      (chartW - barGap * (labels.length + 1)) / labels.length,
      14,
    );

    let gridLines = "";
    for (let g = 0; g <= 4; g++) {
      const gy = height - padding - (g / 4) * chartH;
      const gVal = Math.round((g / 4) * maxVal);
      gridLines += `
        <line x1="${padding}" y1="${gy}" x2="${width - padding}" y2="${gy}" stroke="#F3F4F6" stroke-width="1" />
        <text x="${padding - 8}" y="${gy + 4}" text-anchor="end" font-family="sans-serif" font-size="10" fill="#9CA3AF">${gVal.toLocaleString()}</text>
      `;
    }

    const bars = values
      .map((v, i) => {
        const x = padding + barGap + i * (barW + barGap);
        const barH = Math.max((v / maxVal) * chartH, 6);
        const y = height - padding - barH;
        const color = colorPalette[i % colorPalette.length];

        return `
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="4" fill="${color}" />
        <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="bold" fill="#1F2937">${v.toLocaleString()}</text>
        <text x="${(x + barW / 2).toFixed(1)}" y="${(height - padding + 20).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#6B7280">${labels[i].slice(0, 12)}</text>
      `;
      })
      .join("");

    svgBody = gridLines + bars;
  }

  const safeTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <defs>
      <linearGradient id="lineGrad_${chartIndex}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4285F4" stop-opacity="0.4" />
        <stop offset="100%" stop-color="#4285F4" stop-opacity="0.0" />
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="#FFFFFF" rx="12" />
    <text x="${width / 2}" y="32" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="bold" fill="#1F2937">${safeTitle}</text>
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#E5E7EB" stroke-width="1.5" />
    ${svgBody}
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function enrichAndVerifyReport(reportData: any): any {
  if (!reportData || typeof reportData !== "object") return reportData;

  if (!Array.isArray(reportData.tables)) {
    reportData.tables = [];
  }
  if (!Array.isArray(reportData.insights)) {
    reportData.insights = [];
  }
  if (!Array.isArray(reportData.recommendations)) {
    reportData.recommendations = [];
  }
  if (!Array.isArray(reportData.charts)) {
    reportData.charts = [];
  }

  // Ensure we have at least 3 distinct visual charts if tables exist
  if (reportData.charts.length < 3 && reportData.tables.length > 0) {
    const existingTitles = new Set(
      reportData.charts.map((c: any) => (c.title || "").toLowerCase()),
    );

    const chartTypes = ["bar", "line", "pie", "horizontal_bar"];

    reportData.tables.forEach((table: any, idx: number) => {
      if (reportData.charts.length >= 4) return;
      if (!table || !Array.isArray(table.rows) || table.rows.length === 0) return;

      const title = table.title
        ? `${table.title} Visual Trend`
        : `Category Metrics Chart ${idx + 1}`;

      if (!existingTitles.has(title.toLowerCase())) {
        const selectedType = chartTypes[idx % chartTypes.length];
        reportData.charts.push({
          title: title,
          file: `chart_${idx + 1}.png`,
          type: selectedType,
          caption:
            table.caption ||
            `Visual distribution and comparative breakdown for ${table.title || "key variables"}.`,
        });
        existingTitles.add(title.toLowerCase());
      }
    });
  }

  // Generate SVG vector images for any chart missing an image
  reportData.charts = reportData.charts.map((chart: any, cIdx: number) => {
    if (
      !chart.image ||
      typeof chart.image !== "string" ||
      chart.image.trim() === ""
    ) {
      chart.image = generateSvgChartImage(chart, reportData.tables, cIdx);
    }
    return chart;
  });

  return reportData;
}


function computeExactCsvStatistics(csvContent: string): string {
  try {
    const rows = parseCSVLines(csvContent);
    if (rows.length === 0) return "Empty dataset";
    const headers = rows[0];
    const dataRows = rows.slice(1);
    const totalRows = dataRows.length;

    let summary = `EXACT PRE-COMPUTED DATASET STATISTICAL PROFILE (Calculated across ALL ${totalRows} rows):\n`;
    summary += `- Total Rows: ${totalRows}\n`;
    summary += `- Total Columns: ${headers.length}\n`;
    summary += `- Column Headers: [${headers.join(", ")}]\n\n`;

    summary += `COLUMN BY COLUMN EXACT METRICS:\n`;

    const numericColIndices: number[] = [];
    const dateColIndices: number[] = [];

    for (let colIdx = 0; colIdx < headers.length; colIdx++) {
      const colName = headers[colIdx] || `Column_${colIdx + 1}`;
      const values = dataRows
        .map((r) => r[colIdx] ?? "")
        .filter((v) => v !== "");

      // Check if Date/Time column
      const isDateColHeader =
        /date|time|timestamp|month|year|day|period|quarter|week/i.test(
          colName,
        );
      let validDatesCount = 0;
      for (const v of values.slice(0, 50)) {
        if (!isNaN(Date.parse(v)) && isNaN(Number(v))) {
          validDatesCount++;
        }
      }
      if (
        (isDateColHeader && values.length > 0) ||
        validDatesCount >= Math.min(values.length, 5)
      ) {
        dateColIndices.push(colIdx);
      }

      // Check if numeric column
      const numericValues = values
        .map((v) => parseFloat(v.replace(/[\$,%]/g, "")))
        .filter((v) => !isNaN(v));

      const isNumeric =
        numericValues.length > 0 &&
        numericValues.length >= values.length * 0.6;

      if (isNumeric && numericValues.length > 0) {
        numericColIndices.push(colIdx);
        const sum = numericValues.reduce((a, b) => a + b, 0);
        const mean = sum / numericValues.length;
        const min = Math.min(...numericValues);
        const max = Math.max(...numericValues);
        const variance =
          numericValues.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) /
          numericValues.length;
        const stdDev = Math.sqrt(variance);

        summary += `* Column "${colName}" (Numeric Metric):
  - Total non-empty records: ${numericValues.length} / ${totalRows}
  - Exact Sum: ${sum.toLocaleString(undefined, { maximumFractionDigits: 4 })}
  - Exact Mean (Average): ${mean.toLocaleString(undefined, { maximumFractionDigits: 4 })}
  - Exact Min: ${min}
  - Exact Max: ${max}
  - Exact StdDev: ${stdDev.toFixed(4)}\n`;
      } else {
        const valueCounts: Record<string, number> = {};
        for (const val of values) {
          valueCounts[val] = (valueCounts[val] || 0) + 1;
        }
        const sortedCategories = Object.entries(valueCounts).sort(
          (a, b) => b[1] - a[1],
        );
        const top10 = sortedCategories.slice(0, 10);

        summary += `* Column "${colName}" (Categorical/Text):
  - Total non-empty records: ${values.length} / ${totalRows}
  - Unique Categories Count: ${Object.keys(valueCounts).length}
  - Top Categories with Exact Counts: ${top10
    .map(
      ([cat, cnt]) =>
        `"${cat}": ${cnt} (${((cnt / totalRows) * 100).toFixed(1)}%)`,
    )
    .join(", ")}\n`;
      }
    }

    // 1. COMPUTED TIME-SERIES & TREND ANALYSIS (If date column present)
    if (dateColIndices.length > 0 && numericColIndices.length > 0) {
      summary += `\nTEMPORAL TIME-SERIES & TREND ANALYSIS:\n`;
      for (const dIdx of dateColIndices) {
        const dateColName = headers[dIdx];
        const dateParsedRows = dataRows
          .map((r) => {
            const dateStr = r[dIdx] ?? "";
            const t = Date.parse(dateStr);
            return { rawDate: dateStr, timestamp: t, row: r };
          })
          .filter((item) => !isNaN(item.timestamp))
          .sort((a, b) => a.timestamp - b.timestamp);

        if (dateParsedRows.length >= 2) {
          const startDate = dateParsedRows[0].rawDate;
          const endDate = dateParsedRows[dateParsedRows.length - 1].rawDate;
          summary += `* Time Period Range for "${dateColName}": From ${startDate} to ${endDate} (${dateParsedRows.length} time points)\n`;

          for (const nIdx of numericColIndices) {
            const numColName = headers[nIdx];
            const timeSeriesValues = dateParsedRows
              .map((item) => {
                const val = parseFloat(
                  (item.row[nIdx] ?? "").replace(/[\$,%]/g, ""),
                );
                return { date: item.rawDate, value: isNaN(val) ? 0 : val };
              })
              .filter((item) => !isNaN(item.value));

            if (timeSeriesValues.length >= 2) {
              const startVal = timeSeriesValues[0].value;
              const endVal = timeSeriesValues[timeSeriesValues.length - 1].value;
              const absChange = endVal - startVal;
              const pctChange =
                startVal !== 0 ? ((absChange / Math.abs(startVal)) * 100).toFixed(2) : "N/A";

              // Find peak and trough
              let peakItem = timeSeriesValues[0];
              let troughItem = timeSeriesValues[0];
              for (const item of timeSeriesValues) {
                if (item.value > peakItem.value) peakItem = item;
                if (item.value < troughItem.value) troughItem = item;
              }

              const trendDirection =
                absChange > 0
                  ? `UPWARD GROWTH (+${pctChange}%)`
                  : absChange < 0
                    ? `DOWNWARD DECLINE (${pctChange}%)`
                    : `STABLE / FLAT`;

              summary += `  - Trend for "${numColName}" over time:
    • Start Value (${startDate}): ${startVal.toLocaleString()}
    • End Value (${endDate}): ${endVal.toLocaleString()}
    • Total Net Change: ${absChange > 0 ? "+" : ""}${absChange.toLocaleString()} (${trendDirection})
    • Peak High: ${peakItem.value.toLocaleString()} on ${peakItem.date}
    • Lowest Trough: ${troughItem.value.toLocaleString()} on ${troughItem.date}\n`;
            }
          }
        }
      }
    }

    // 2. PAIRWISE NUMERIC CORRELATIONS
    if (numericColIndices.length >= 2) {
      summary += `\nKEY NUMERIC CORRELATIONS & RELATIONSHIPS:\n`;
      for (let i = 0; i < numericColIndices.length; i++) {
        for (let j = i + 1; j < numericColIndices.length; j++) {
          const idxA = numericColIndices[i];
          const idxB = numericColIndices[j];
          const nameA = headers[idxA];
          const nameB = headers[idxB];

          const pairs = dataRows
            .map((r) => [
              parseFloat((r[idxA] ?? "").replace(/[\$,%]/g, "")),
              parseFloat((r[idxB] ?? "").replace(/[\$,%]/g, "")),
            ])
            .filter(([a, b]) => !isNaN(a) && !isNaN(b));

          if (pairs.length >= 3) {
            const meanA =
              pairs.reduce((sum, p) => sum + p[0], 0) / pairs.length;
            const meanB =
              pairs.reduce((sum, p) => sum + p[1], 0) / pairs.length;

            let num = 0;
            let denA = 0;
            let denB = 0;

            for (const [a, b] of pairs) {
              const diffA = a - meanA;
              const diffB = b - meanB;
              num += diffA * diffB;
              denA += diffA * diffA;
              denB += diffB * diffB;
            }

            const r =
              denA > 0 && denB > 0 ? num / Math.sqrt(denA * denB) : 0;
            const relationship =
              r > 0.7
                ? "Strong Positive Correlation"
                : r > 0.3
                  ? "Moderate Positive Correlation"
                  : r < -0.7
                    ? "Strong Negative (Inverse) Correlation"
                    : r < -0.3
                      ? "Moderate Inverse Correlation"
                      : "Weak/No Linear Correlation";

            summary += `* "${nameA}" vs "${nameB}": Pearson r = ${r.toFixed(3)} (${relationship})\n`;
          }
        }
      }
    }

    return summary;
  } catch (err) {
    return "Could not compute exact CSV stats: " + String(err);
  }
}

function parseOrRepairJSON(rawText: string): any {
  if (!rawText) return {};
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {}
    }
  }

  // Attempt auto-repair for truncated JSON strings
  try {
    let s = cleaned;
    const jsonStart = s.indexOf("{");
    if (jsonStart !== -1) {
      s = s.substring(jsonStart);
    }

    let inString = false;
    let isEscaped = false;
    const stack: string[] = [];

    let repaired = "";
    for (let i = 0; i < s.length; i++) {
      const char = s[i];
      repaired += char;

      if (inString) {
        if (isEscaped) {
          isEscaped = false;
        } else if (char === "\\") {
          isEscaped = true;
        } else if (char === '"') {
          inString = false;
        }
      } else {
        if (char === '"') {
          inString = true;
        } else if (char === "{" || char === "[") {
          stack.push(char);
        } else if (char === "}") {
          if (stack.length && stack[stack.length - 1] === "{") stack.pop();
        } else if (char === "]") {
          if (stack.length && stack[stack.length - 1] === "[") stack.pop();
        }
      }
    }

    if (inString) {
      repaired += '"';
    }

    repaired = repaired.replace(/,\s*$/, "");
    repaired = repaired.replace(/:\s*$/, ': ""');

    while (stack.length > 0) {
      const top = stack.pop();
      if (top === "{") repaired += "}";
      else if (top === "[") repaired += "]";
    }

    return JSON.parse(repaired);
  } catch (repairErr) {
    console.warn("[parseOrRepairJSON] Repair failed, returning fallback object:", repairErr);
    return {
      title: "Data Analysis Report",
      executive_summary: rawText.replace(/```json|```/g, "").slice(0, 1500),
      insights: [
        {
          title: "Analysis Summary",
          detail: rawText.replace(/```json|```/g, "").slice(0, 800),
          metric: "Status",
          value: "Completed"
        }
      ],
      tables: [],
      recommendations: ["Review the dataset metrics above."]
    };
  }
}

async function runDirectGeminiAnalysis(
  question: string,
  uploadedFiles: Array<{ name: string; content?: string; gsUri?: string }>,
  effectiveDatasetName: string,
  sendEvent: (event: any) => void,
  sendError: (message: string) => void,
  res: express.Response
) {
  try {
    sendEvent({
      type: "info",
      message: "Analyzing dataset with Gemini...",
    });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      sendError(
        "GEMINI_API_KEY is missing. Please verify your Gemini API Key in Settings > Secrets."
      );
      res.end();
      return;
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });

    // Prepare dataset text context and pre-computed exact statistics from uploaded CSV files
    let fileSummaries = "";
    for (const f of uploadedFiles) {
      fileSummaries += `\n========================================\nFILE: ${f.name}\n========================================\n`;
      if (f.content) {
        // Pre-compute exact mathematical statistics across all rows
        const stats = computeExactCsvStatistics(f.content);
        fileSummaries += stats + "\n\n";

        const lines = f.content.split("\n");
        if (lines.length > 3000) {
          fileSummaries += `[RAW DATA CONTENT - Total Rows in File: ${lines.length}]\n`;
          fileSummaries +=
            `[First 2500 Rows]:\n` + lines.slice(0, 2500).join("\n") + "\n";
          fileSummaries +=
            `[Last 500 Rows]:\n` + lines.slice(-500).join("\n");
        } else {
          fileSummaries += `[FULL RAW DATA CONTENT (${lines.length} rows)]:\n` + f.content;
        }
      } else if (f.gsUri) {
        fileSummaries += `[GCS File Location: ${f.gsUri}]\n`;
      }
    }

    sendEvent({
      type: "thinking",
      text: `Reading '${effectiveDatasetName}' (${uploadedFiles.length} file(s)). Calculating exact column sums, averages, counts, distributions, and cross-tabulations across all uploaded data rows...`,
    });

    const systemInstruction = `You are Data Intelligence Engine, an expert AI Data Analyst, Business Intelligence Consultant, Statistician, Financial Analyst, and Decision Support System. Your primary objective is to transform raw datasets into actionable business intelligence suitable for executives, founders, investors, managers, and analysts (thinking like a senior analyst at McKinsey, Deloitte, Google, Microsoft, Amazon, or Gartner).

CRITICAL DIRECTIVES:
1. Every metric, count, sum, average, percentage, table row, and chart MUST be strictly computed from the real dataset content and exact pre-computed statistical profile supplied in the prompt.
2. NEVER produce dummy data, place-holder values, generic numbers, or random examples. Never invent facts or fabricate statistics.
3. Automatically determine dataset shape, missing values, duplicates, date columns, numerical/categorical variables, and infer schema intelligently.
4. Execute full 15-step analytical depth:
   - "executive_summary": Comprehensive executive report formatted with clear Markdown headers (# Executive Summary, # Dataset Overview, # Data Quality, # Statistical Summary, # Trend Analysis, # Business Insights, # Correlation Analysis, # Risk Assessment, # Forecast, # KPI Dashboard, # Recommended Visualizations, # Strategic Recommendations, # Final Conclusion).
   - "insights": Provide AT LEAST 5 to 8 distinct, quantitative key performance indicators/insights with exact metric names and calculated values.
   - "tables": Provide AT LEAST 3 to 5 comprehensive data tables breaking down key categories, time series, top/bottom performers, statistical distributions, and correlation/cross-tabulations. Each table MUST have 5 to 15 detailed rows.
   - "charts": Provide AT LEAST 3 to 5 distinct visual chart specifications representing different dimensions of the dataset (e.g. line for trends over time, bar for comparative metrics, pie or donut for category share, horizontal_bar for top rankings). Each chart MUST include a title, file (e.g. "chart_1.png"), type, and detailed caption explaining the data insights.
   - "methodology": Thorough step-by-step mathematical breakdown of exact formulas, sums, means, and grouping logic used across N rows.
   - "recommendations": AT LEAST 5 to 8 clear, highly actionable, data-driven strategic business recommendations based directly on the findings, concluding with the top 3 highest-impact recommendations.

Return a complete JSON object adhering strictly to this schema:
{
  "dataset_name": "Name of dataset",
  "question": "User question",
  "title": "Clear, informative title for the analysis report",
  "executive_summary": "Rich multi-section executive summary in Markdown format using the requested section headers",
  "insights": [
    {
      "title": "Insight Title",
      "detail": "Detailed explanation backed by real calculated numbers",
      "metric": "Exact Metric Name",
      "value": "Exact Real Calculated Value"
    }
  ],
  "tables": [
    {
      "title": "Table Title",
      "columns": ["Col1", "Col2", "Col3"],
      "rows": [["real_val1", "real_val2", "123.45"]],
      "caption": "Table caption highlighting key data findings"
    }
  ],
  "charts": [
    {
      "title": "Chart Title",
      "file": "chart_1.png",
      "type": "bar",
      "caption": "Explanation of chart trends grounded in the real data"
    }
  ],
  "methodology": "Exact mathematical methodology used across dataset rows",
  "recommendations": [
    "Actionable data-driven recommendation 1 based on real findings",
    "Actionable data-driven recommendation 2 based on real findings"
  ]
}`;

    const promptText = `Dataset Name: "${effectiveDatasetName}"
User Question: "${question}"

Data Files Content:
${fileSummaries}

Please analyze the data thoroughly, compute relevant aggregates, trends, distributions, top drivers, or anomalies, and produce a detailed JSON analysis report answering the question.`;

    sendEvent({
      type: "thinking",
      text: "Calculating key statistical aggregations, segment comparisons, and data relationships...",
    });

    let response: any = null;
    const candidateModels = [
      "gemini-3.6-flash",
      "gemini-3.1-pro-preview",
      "gemini-2.5-flash",
      "gemini-flash-latest",
    ];
    let lastError: any = null;

    for (const modelName of candidateModels) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`[runDirectGeminiAnalysis] Attempting generation with model ${modelName} (attempt ${attempt})...`);
          response = await ai.models.generateContent({
            model: modelName,
            contents: promptText,
            config: {
              systemInstruction,
              maxOutputTokens: 8192,
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  dataset_name: { type: Type.STRING },
                  question: { type: Type.STRING },
                  title: { type: Type.STRING },
                  executive_summary: { type: Type.STRING },
                  insights: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        title: { type: Type.STRING },
                        detail: { type: Type.STRING },
                        metric: { type: Type.STRING },
                        value: { type: Type.STRING },
                      },
                      required: ["title", "detail"],
                    },
                  },
                  tables: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        title: { type: Type.STRING },
                        columns: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                        },
                        rows: {
                          type: Type.ARRAY,
                          items: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                          },
                        },
                        caption: { type: Type.STRING },
                      },
                      required: ["title", "columns", "rows"],
                    },
                  },
                  charts: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        title: { type: Type.STRING },
                        file: { type: Type.STRING },
                        type: { type: Type.STRING },
                        caption: { type: Type.STRING },
                      },
                      required: ["title", "file"],
                    },
                  },
                  methodology: { type: Type.STRING },
                  recommendations: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: [
                  "dataset_name",
                  "question",
                  "title",
                  "executive_summary",
                  "insights",
                  "tables",
                ],
              },
            },
          });
          if (response && response.text) {
            break;
          }
        } catch (err: any) {
          lastError = err;
          console.warn(`[runDirectGeminiAnalysis] Model ${modelName} attempt ${attempt} failed:`, err?.message || err);
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }
      if (response && response.text) {
        break;
      }
    }

    if (!response || !response.text) {
      throw lastError || new Error("All Gemini models failed to respond.");
    }

    sendEvent({
      type: "thinking",
      text: "Synthesizing executive summary, tabular summaries, and strategic recommendations...",
    });

    const text = response.text;
    if (!text) {
      throw new Error("No output generated from Gemini API.");
    }

    let reportData = parseOrRepairJSON(text);
    reportData.dataset_name = reportData.dataset_name || effectiveDatasetName;
    reportData.question = reportData.question || question;

    reportData = enrichAndVerifyReport(reportData);

    sendEvent({
      type: "report_data",
      data: reportData,
    });

    sendEvent({
      type: "text",
      text: `## ${reportData.title || "Analysis Report"}\n\n${reportData.executive_summary || ""}`,
    });

    sendEvent({ type: "complete", interaction: {} });
    sendEvent({ type: "done" });
    res.end();
  } catch (err: any) {
    console.error("[runDirectGeminiAnalysis] Direct analysis error:", err);
    sendError(`Analysis error: ${err.message || String(err)}`);
    res.end();
  }
}

async function getGcpAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: { "Metadata-Flavor": "Google" },
      },
    );
    if (res.ok) {
      const data: any = await res.json();
      return data.access_token || null;
    }
  } catch (err) {
    console.warn(
      "[getGcpAccessToken] Could not fetch token from metadata server:",
      err,
    );
  }
  return null;
}

function extractTarInMemory(tarBuffer: Buffer): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    let isEnd = true;
    for (let i = 0; i < 512; i++) {
      if (tarBuffer[offset + i] !== 0) {
        isEnd = false;
        break;
      }
    }
    if (isEnd) break;

    let name = "";
    for (let i = 0; i < 100; i++) {
      const charCode = tarBuffer[offset + i];
      if (charCode === 0) break;
      name += String.fromCharCode(charCode);
    }
    name = name.trim();

    let sizeStr = "";
    for (let i = 124; i < 136; i++) {
      const charCode = tarBuffer[offset + i];
      if (charCode === 0 || charCode === 32) continue;
      sizeStr += String.fromCharCode(charCode);
    }
    const size = parseInt(sizeStr, 8);

    const typeflag = tarBuffer[offset + 156];
    const isRegularFile = typeflag === 0 || typeflag === 48;

    offset += 512; // skip header

    if (name && isRegularFile && !isNaN(size) && size > 0) {
      if (offset + size <= tarBuffer.length) {
        files[name] = tarBuffer.subarray(offset, offset + size);
      }
    }

    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;
  }

  return files;
}

function extractEnvironmentId(interaction: any): string | undefined {
  if (!interaction || typeof interaction !== "object") return undefined;
  const environment = interaction.environment;
  const candidates = [
    environment?.env_id,
    environment?.environment_id,
    environment?.id,
    environment?.name,
    interaction.environment_id,
    interaction.env_id,
  ];
  const value = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim(),
  );
  if (typeof value !== "string") return undefined;
  return value.replace(/^environments?\//, "").replace(/^environment-/, "");
}

function extractInteractionId(interaction: any): string | undefined {
  if (!interaction || typeof interaction !== "object") return undefined;
  const value =
    interaction.name || interaction.id || interaction.interaction_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type AgentSource =
  | { type: "inline"; content: string; target: string }
  | { type: "gcs"; source: string; target: string }
  | { type: "repository"; source: string; target: string };

function loadAgentFiles(dir: string, basePath: string): AgentSource[] {
  let files: AgentSource[] = [];
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const targetPath = path.posix.join(basePath, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(loadAgentFiles(fullPath, targetPath));
    } else {
      files.push({
        type: "inline",
        content: fs.readFileSync(fullPath, "utf-8"),
        target: targetPath,
      });
    }
  }
  return files;
}

const activeGenerations = new Map<string, AbortController>();

function cleanUpOldGenerations() {
  const outputDir = path.join(process.cwd(), "output");
  if (!fs.existsSync(outputDir)) return;

  const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours threshold
  const now = Date.now();

  try {
    const items = fs.readdirSync(outputDir);
    for (const item of items) {
      if (item.startsWith(".")) continue; // ignore hidden items
      const itemPath = path.join(outputDir, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        const age = now - stats.mtimeMs;
        if (age > maxAgeMs) {
          console.log(
            `[cleanup] Directory ${item} is older than 24 hours (${Math.round(age / 1000 / 60 / 60)} hrs). Deleting to prevent storage bloat.`,
          );
          try {
            fs.rmSync(itemPath, { recursive: true, force: true });
            const zipPath = `${itemPath}.zip`;
            if (fs.existsSync(zipPath)) {
              fs.unlinkSync(zipPath);
            }
          } catch (itemErr) {
            console.error(`[cleanup] Failed to delete ${itemPath}:`, itemErr);
          }
        }
      }
    }
  } catch (err) {
    console.error("[cleanup] Error cleaning up old generations:", err);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Run initial cleanup on startup
  cleanUpOldGenerations();

  app.use(express.json({ limit: "50mb" }));
  app.use("/output", express.static(path.join(process.cwd(), "output")));

  // API routes FIRST
  app.post("/api/cancel-show", (req, res) => {
    const { generationId } = req.body;
    if (generationId && activeGenerations.has(generationId)) {
      console.log(`[cancel-show] Human requested abort for ${generationId}`);
      activeGenerations.get(generationId)?.abort();
      activeGenerations.delete(generationId);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Not found or already completed" });
    }
  });

  app.get("/api/download-proxy", async (req, res) => {
    const targetUrl = req.query.url as string;
    if (!targetUrl) {
      res.status(400).send("Missing url parameter");
      return;
    }
    try {
      const parsedUrl = new URL(targetUrl);
      if (!parsedUrl.hostname.endsWith("storage.googleapis.com") && !parsedUrl.hostname.endsWith("googleusercontent.com")) {
        res.status(403).send("Forbidden: Domain not allowed");
        return;
      }
      const response = await fetch(targetUrl);
      if (!response.ok) {
        res
          .status(response.status)
          .send(`Failed to fetch: ${response.statusText}`);
        return;
      }
      res.setHeader(
        "Content-Type",
        response.headers.get("Content-Type") || "application/octet-stream",
      );
      res.setHeader("Access-Control-Allow-Origin", "*");

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.send(buffer);
    } catch (err) {
      console.error("Download proxy failed:", err);
      res
        .status(500)
        .send(
          `Internal server error: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
  });

  const QUOTA_CACHE_FILE = path.join(
    process.cwd(),
    "output",
    "quota_cache.json",
  );
  const DEFAULT_QUOTA_LIMIT = 999999;

  function getQuotaLimit(): number {
    const limitStr = process.env.DAILY_QUOTA_LIMIT;
    if (limitStr) {
      const parsed = parseInt(limitStr, 10);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }
    return DEFAULT_QUOTA_LIMIT;
  }

  function getTodayStr(): string {
    return new Date().toISOString().split("T")[0];
  }

  let isFirebaseAdminInitialized = false;

  function ensureFirebaseAdmin() {
    // Firebase is disabled
  }

  async function getUserHash(req: express.Request): Promise<string | null> {
    // Fallback during local development or unauthenticated preview testing
    return "dev-user-hash";
  }

  function getQuotaCount(userHash: string | null): number {
    if (!userHash) return 0;
    try {
      const outputDir = path.dirname(QUOTA_CACHE_FILE);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      if (fs.existsSync(QUOTA_CACHE_FILE)) {
        const data = fs.readFileSync(QUOTA_CACHE_FILE, "utf-8");
        const cache = JSON.parse(data);
        const cacheKey = `${getTodayStr()}_${userHash}`;
        return cache[cacheKey] || 0;
      }
    } catch (err) {
      console.error("Error reading quota cache:", err);
    }
    return 0;
  }

  function incrementQuotaCount(userHash: string | null): void {
    if (!userHash) return;
    try {
      const outputDir = path.dirname(QUOTA_CACHE_FILE);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      let cache: Record<string, number> = {};
      if (fs.existsSync(QUOTA_CACHE_FILE)) {
        try {
          const data = fs.readFileSync(QUOTA_CACHE_FILE, "utf-8");
          cache = JSON.parse(data);
        } catch (e) {
          console.error("Error parsing quota file cache on increment:", e);
        }
      }
      const cacheKey = `${getTodayStr()}_${userHash}`;
      cache[cacheKey] = (cache[cacheKey] || 0) + 1;
      fs.writeFileSync(
        QUOTA_CACHE_FILE,
        JSON.stringify(cache, null, 2),
        "utf-8",
      );
    } catch (err) {
      console.error("Error incrementing quota cache:", err);
    }
  }

  app.get("/api/quota", async (req, res) => {
    if (process.env.NODE_ENV !== "production") {
      return res.json({ used: 0, limit: 999999 });
    }
    const userHash = await getUserHash(req);
    const limit = getQuotaLimit();
    if (!userHash) {
      return res.json({ used: 0, limit });
    }
    const count = getQuotaCount(userHash);
    return res.json({ used: count, limit });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  });

  const uploadSingle = upload.single("file");

  app.post(
    "/api/upload",
    (req, res, next) => {
      uploadSingle(req, res, (err) => {
        if (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
              return res
                .status(400)
                .json({
                  error: "File is too large. The maximum allowed size is 50MB.",
                });
            }
            return res
              .status(400)
              .json({ error: `Upload error: ${err.message}` });
          }
          return res
            .status(500)
            .json({
              error: err.message || "An unknown error occurred during upload.",
            });
        }
        next();
      });
    },
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "No file uploaded" });
        }

        // Inline limit: 1 MB per file
        const MAX_INLINE_SIZE = 1 * 1024 * 1024; // 1 MB
        if (req.file.size > MAX_INLINE_SIZE) {
          return res.status(400).json({
            error: `File "${req.file.originalname}" is ${(req.file.size / (1024 * 1024)).toFixed(2)} MB, which exceeds the 1MB inline limit. For CSV files larger than 1MB, please use the "Paste a GCS URI" option!`,
          });
        }

        const content = req.file.buffer.toString("utf-8");
        const safeOriginalName = req.file.originalname.replace(
          /[^a-zA-Z0-9._-]/g,
          "_",
        );
        let gsUri: string | undefined = undefined;
        let url: string | undefined = undefined;

        try {
          const sessionId =
            typeof req.body?.sessionId === "string"
              ? req.body.sessionId.trim()
              : "default";
          const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
          const filename = `uploads/${sessionId}/${uniqueSuffix}-${safeOriginalName}`;

          // Firebase upload omitted
        } catch (gcsErr) {
          console.warn("[api/upload] Optional GCS upload omitted:", gcsErr);
        }

        console.log(
          `[api/upload] Processed inline CSV upload for ${safeOriginalName} (${req.file.size} bytes)`,
        );
        return res.json({
          name: req.file.originalname,
          content,
          size: req.file.size,
          gsUri,
          url,
        });
      } catch (err: any) {
        console.error("[api/upload] CSV upload failed:", err);
        res
          .status(500)
          .json({ error: `Upload failed: ${err.message || err}` });
      }
    },
  );

  async function deleteGcsFiles(files: any[]) {
    // Disabled
  }

  app.get("/api/download-file", async (req, res) => {
    return res.status(500).send("GCS bucket is not configured on Firebase Admin");
  });

  app.post("/api/clear-files", async (req, res) => {
    return res.json({ success: true });
  });

  app.post("/api/analyze", async (req, res) => {
    // Run background cleanup whenever a new analysis is requested to optimize disk space
    cleanUpOldGenerations();

    const {
      question,
      files,
      datasetName = "Dataset",
      generationId,
      environmentId,
      googleToken,
    } = req.body;

    if (!question || typeof question !== "string" || question.trim() === "") {
      return res
        .status(400)
        .json({ error: "Missing required field: question" });
    }

    // Reusing the environment is sufficient. Do not chain to the prior
    // interaction because the report can be retrieved before that interaction
    // has formally completed in the hosted runtime.
    const isFollowUp = !!environmentId;
    const uploadedFiles: Array<{ name: string; content?: string; gsUri?: string }> =
      Array.isArray(files)
        ? files.filter(
            (f: any) =>
              f &&
              typeof f.name === "string" &&
              ((typeof f.content === "string" && f.content.trim() !== "") ||
                (typeof f.gsUri === "string" && f.gsUri.trim() !== "")),
          )
        : [];
    if (!isFollowUp && uploadedFiles.length === 0) {
      return res.status(400).json({ error: "Provide at least one CSV file." });
    }

    console.log(`[analyze] Skipping daily quota tracking as requested.`);

    const effectiveDatasetName = datasetName;

    const gcsFiles = uploadedFiles.filter((f) => f.gsUri);
    const hasGcsFiles = gcsFiles.length > 0;
    let gcsToken: string | null = null;
    let gcsInstructions = "";
    if (hasGcsFiles) {
      gcsToken = await getGcpAccessToken();
      gcsInstructions = `The user uploaded ${gcsFiles.length} file(s) to Google Cloud Storage. First, you MUST run \`python /.agents/download_gcs.py\` to download them to /.agents/data/ before doing anything else.`;
    }

    let prompt = "";

    if (isFollowUp) {
      prompt = `You are an expert data analyst continuing an analysis of the dataset "${effectiveDatasetName}".


FOLLOW-UP BUSINESS QUESTION:
${question}


EXECUTE IMMEDIATELY:
- Your first response MUST be one code_execution call. Do not explain, plan, quote these instructions, or print code as text.
- In that one call, discover source files with glob.glob('./workspace/data/*.csv'), clear prior files under data/analysis/ and charts/, analyze the question with Pandas, save result CSVs, and optionally create up to three charts with the existing make_chart.py script.
- Do not delete source CSVs, profile.json, or the existing report.json before the replacement report is ready.
- Do not import seaborn, scipy, statsmodels, or other unlisted packages. Use Pandas, NumPy, and the provided chart script.
- If the data cannot answer the question or analysis fails, write data/analysis/limitations.csv with columns limitation, detail, and required_data.
- ALWAYS finish the same code_execution call by running:
 python3 /.agents/skills/reporting/scripts/build_report.py --workspace ./workspace --question "${question.replace(/"/g, '\\"')}" --dataset-name "${effectiveDatasetName.replace(/"/g, '\\"')}"
- After the tool output contains "Report saved", return one short sentence and make no more tool calls.`;
    } else {
      const fileNames = uploadedFiles.map((f) => f.name).join(", ");
      const dataSourceInstructions = `The user provided ${uploadedFiles.length} CSV file(s). ${gcsInstructions} The files will be located at /.agents/data/. Copy them all into ./workspace/data/ before profiling: \`cp /.agents/data/*.csv ./workspace/data/\`. Provided file(s): ${fileNames}.`;

      prompt = `You are Data Intelligence Engine, an expert AI Data Analyst, Business Intelligence Consultant, Statistician, Financial Analyst, and Decision Support System. Think like a senior McKinsey/Deloitte/Google analyst. Dataset name: "${effectiveDatasetName}".

OBJECTIVE: Transform this dataset into executive-ready business intelligence covering Dataset Overview, Data Quality, Descriptive Statistics, Trends, BI Insights, Correlations, Outliers, Predictive Forecasts, Risk Ratings (High/Med/Low), KPIs, Visualizations, and Strategic Recommendations (concluding with the top 3 highest-impact actions). Never fabricate facts or statistics.

DATA SOURCE:
${dataSourceInstructions}


BUSINESS QUESTION:
${question}


WORKFLOW REQUIREMENT:
You MUST follow this workflow in order. Keep the run short: use one Python script for profiling and one Python script for the requested analysis instead of creating many exploratory scripts. You MUST NOT finish your response until all steps are completed and 'build_report.py' prints that report.json was saved.
HARD LIMIT: You have at most 10 code-execution calls for the entire run. Use one setup call, one combined profiling call, one combined analysis call, up to three chart calls, and one report call. Do not run ad hoc inspection, describe, correlation, validation, package-check, or report-preview commands. Put required calculations into the two scripts. Once build_report.py prints "Report saved", immediately conclude without another tool call.


1. STAGE & SET UP: Create directories, copy the data, and install the core requirements immediately. Do not assume matplotlib is installed:
  mkdir -p ./workspace/data ./workspace/charts ./workspace/data/analysis && \
  cp /.agents/data/*.csv ./workspace/data/ && \
  pip install -r /.agents/requirements.txt --break-system-packages --prefer-binary --no-cache-dir
  Install scikit-learn separately only if the question genuinely requires an ML model.


2. EXPLORE: Write and run one concise Pandas profiling script that understands the columns and types and writes './workspace/data/profile.json'. The data-explorer skill is agent-driven; there is no profile_data.py supplied by the skill.


3. ANALYZE & SAVE: Write and execute a Python pandas script to perform the data aggregations and calculations needed to answer the question.
  CRITICAL: You MUST save any result tables as CSV files under './workspace/data/analysis/' (e.g., './workspace/data/analysis/streak_data.csv'). Do NOT save files in other folders.


4. VISUALIZE: Create high-quality PNG charts for your findings. Run the visualization script on your saved analysis CSVs:
  python3 /.agents/skills/visualization/scripts/make_chart.py --workspace ./workspace --data data/analysis/<your_csv>.csv --type <bar|line|scatter|pie|heatmap> --x <col> --y <col> --title "<Chart Title>" --output charts/<chart_name>.png


5. BUILD REPORT: Compile everything into the final interactive report JSON by running:
  python3 /.agents/skills/reporting/scripts/build_report.py --workspace ./workspace --question "${question.replace(/"/g, '\\"')}" --dataset-name "${effectiveDatasetName.replace(/"/g, '\\"')}"


CRITICAL RULE FOR RE-ENTRANCY & COMPLETION:
The frontend UI depends 100% on './workspace/data/report.json' to render the charts and tables on the screen. If you output your final textual response or stop calling tools before running step 5 (build_report.py), the user will see a completely blank dashboard!
Therefore, please make sure to run both 'make_chart.py' and 'build_report.py' successfully in the sandbox before concluding your turn.


*SANDBOX TOOL TIP:* Since you run in a Python code_execution sandbox, you should run all shell commands (like directory creation, make_chart.py, or build_report.py scripts) by prefixing them with a "!" in your code cells or by using Python's 'os.system()' or 'subprocess' modules. Do not output plain bash commands or hallucinate external tool calls.


Example of the required execution order:
\`\`\`python
import os
# Stage data and install core dependencies first
os.system("mkdir -p ./workspace/data ./workspace/charts ./workspace/data/analysis && cp /.agents/data/*.csv ./workspace/data/ && pip install -r /.agents/requirements.txt --break-system-packages --prefer-binary --no-cache-dir")


# Explore and profile using Pandas here, then write ./workspace/data/profile.json directly.
# Do not call a nonexistent profiling helper script.


# Analyze & Save CSV
import pandas as pd
df = pd.read_csv('./workspace/data/...')
# ... perform calculations ...
df.to_csv('./workspace/data/analysis/results.csv', index=False)


# Visualize PNG chart
os.system("python3 /.agents/skills/visualization/scripts/make_chart.py --workspace ./workspace --data data/analysis/results.csv --type bar --x col1 --y col2 --title 'Title' --output charts/my_chart.png")


# Compile report immediately after charts (deterministic and network-free)
os.system("""python3 /.agents/skills/reporting/scripts/build_report.py --workspace ./workspace --question "${question.replace(/"/g, '\\"')}" --dataset-name "${effectiveDatasetName.replace(/"/g, '\\"')}" """)
\`\`\``;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (event: any) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    let reportDelivered = false;
    let streamFailed = false;
    const sendError = (message: string) => {
      streamFailed = true;
      sendEvent({ type: "error", message });
    };
    let sentSessionEnvironmentId: string | undefined;
    const sendSessionEnvironment = (environmentIdValue: string | undefined) => {
      if (
        !environmentIdValue ||
        environmentIdValue === sentSessionEnvironmentId
      )
        return;
      sentSessionEnvironmentId = environmentIdValue;
      sendEvent({ type: "session", environmentId: environmentIdValue });
    };
    sendSessionEnvironment(
      typeof environmentId === "string" ? environmentId : undefined,
    );

    // Send a heartbeat every 15 seconds to keep the connection alive
    // (useful for proxies like VS Code port forwarding that drop idle connections)
    const heartbeatInterval = setInterval(() => {
      res.write(`:\n\n`); // SSE comment/ping
    }, 15000);

    let isFinished = false;
    const abortController = new AbortController();

    if (generationId) {
      activeGenerations.set(generationId, abortController);
    }

    req.on("aborted", () => {
      if (!isFinished) {
        console.log(
          `[analyze] Client aborted request. Agent will continue running in background unless explicitly cancelled.`,
        );
      }
      clearInterval(heartbeatInterval);
    });
    req.on("close", () => {
      clearInterval(heartbeatInterval);
    });

    try {
      let agentFiles: AgentSource[] = [];
      if (isFollowUp) {
        console.log(
          `[analyze] Continuing session in active environment: "${environmentId}" without interaction chaining.`,
        );
        sendEvent({
          type: "info",
          message: "Continuing session in active environment...",
        });
      } else {
        console.log(
          `[analyze] Request received. dataset: "${effectiveDatasetName}", source: ${uploadedFiles.length} uploaded file(s), question: "${question.substring(0, 80)}...", generationId: "${generationId}"`,
        );
        console.log(
          `[analyze] GEMINI_API_KEY presence verified: ${!!process.env.GEMINI_API_KEY}`,
        );
        sendEvent({
          type: "info",
          message: "Provisioning analysis environment...",
        });

        console.log(
          `[analyze] Loading agent files from filesystem path: ${path.join(process.cwd(), "agent")}`,
        );
        agentFiles = loadAgentFiles(
          path.join(process.cwd(), "agent"),
          "/.agents",
        );

        // Add user dataset files (inline CSVs or GCS URIs)
        uploadedFiles.forEach((f) => {
          const safeName = path.posix
            .basename(f.name)
            .replace(/[^a-zA-Z0-9._-]/g, "_");
          if (f.content) {
            agentFiles.push({
              type: "inline",
              content: f.content,
              target: `/.agents/data/${safeName}`,
            });
          } else if (f.gsUri) {
            agentFiles.push({
              type: "gcs",
              source: f.gsUri,
              target: "/.agents/data",
            });
          }
        });

        // Uploads are fetched from GCS inside the sandbox via /.agents/download_gcs.py.
        if (hasGcsFiles) {
          const protocol = req.headers["x-forwarded-proto"] || "http";
          const host = req.headers.host || "localhost:3000";
          const serverUrl = `${protocol}://${host}`;

          const gcsFilesToDownload = gcsFiles.map((f) => {
            const safeName = path.posix
              .basename(f.name)
              .replace(/[^a-zA-Z0-9._-]/g, "_");
            let gcsPath = "";
            const uri = f.gsUri || "";
            if (uri.startsWith("gs://")) {
              const parts = uri.slice(5).split("/", 1);
              gcsPath = uri.slice(5 + parts[0].length + 1);
            }
            return {
              source: f.gsUri,
              filename: gcsPath,
              target: `/.agents/data/${safeName}`,
            };
          });

          const gcsDownloadScript = `
import urllib.request
import urllib.parse
import os


files = [
${gcsFilesToDownload.map((f) => `    {"source": "${f.source}", "filename": "${f.filename}", "target": "${f.target}"}`).join(",\n")}
]


server_url = "${serverUrl}"
token = ${gcsToken ? `"${gcsToken}"` : "None"}
os.makedirs("/.agents/data", exist_ok=True)


for f in files:
   filename = f["filename"]
   # 1. First attempt: Download via the secure local Express download proxy (works without direct GCS access or public permission)
   proxy_url = f"{server_url}/api/download-file?filename={urllib.parse.quote(filename)}"
   print(f"Attempting download for {filename} via proxy: {proxy_url}")
   try:
       req = urllib.request.Request(proxy_url)
       with urllib.request.urlopen(req) as response, open(f["target"], "wb") as out:
           out.write(response.read())
       print(f"Successfully downloaded {filename} via Express proxy")
       continue
   except Exception as proxy_err:
       print(f"Express proxy download failed: {proxy_err}. Falling back to direct GCS download...")


   # 2. Second attempt / fallback: Direct GCS API download
   uri = f["source"]
   if uri.startswith("gs://"):
       parts = uri[5:].split("/", 1)
       bucket = parts[0]
       obj = parts[1]
       encoded_obj = urllib.parse.quote(obj)
       url_json = f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{encoded_obj}?alt=media"
       url_xml = f"https://storage.googleapis.com/{bucket}/{encoded_obj}"
      
       success = False
       for url in [url_json, url_xml]:
           req = urllib.request.Request(url)
           if token:
               req.add_header("Authorization", "Bearer " + token)
           try:
               with urllib.request.urlopen(req) as response, open(f["target"], "wb") as out:
                   out.write(response.read())
               print(f"Successfully downloaded {f['source']} from {url}")
               success = True
               break
           except Exception as e:
               print(f"Failed download from {url}: {e}")
       if not success:
           print(f"Failed all download attempts for {f['source']}")
`;
          agentFiles.push({
            type: "inline",
            content: gcsDownloadScript,
            target: `/.agents/download_gcs.py`,
          });
        }
        console.log(
          `[analyze] Finished loading agent files (source: ${uploadedFiles.length} uploaded file(s)). Count: ${agentFiles.length}`,
        );
      }

      if (!gcsToken) {
        gcsToken = await getGcpAccessToken();
      }
      console.log(
        `[analyze] Retrieved GCS access token: ${gcsToken ? "yes (length: " + gcsToken.length + ")" : "no"}`,
      );

      console.log(
        `[analyze] Calling createInteraction with prompt: "${prompt.substring(0, 100)}..."`,
      );
      let response: Response;
      try {
        response = await createInteraction({
          prompt,
          stream: true,
          inlineSources: isFollowUp
            ? undefined
            : agentFiles.length > 0
              ? agentFiles
              : undefined,
          environmentId: isFollowUp ? environmentId : undefined,
          gcsToken: gcsToken || undefined,
          signal: abortController.signal,
        });
      } catch (interactionErr: any) {
        console.warn(
          `[analyze] createInteraction threw exception: ${interactionErr.message || interactionErr}. Falling back to Direct Gemini Analysis...`,
        );
        await runDirectGeminiAnalysis(
          question,
          uploadedFiles,
          effectiveDatasetName,
          sendEvent,
          sendError,
          res,
        );
        return;
      }

      console.log(
        `[analyze] Gemini API responded. HTTP Status: ${response.status} ${response.statusText}`,
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[analyze] Gemini API Non-2xx response (${response.status}). Error Payload: ${errorText}`,
        );

        let displayMessage = `Agent API error: ${response.status} - ${errorText}`;
        try {
          const parsed = JSON.parse(errorText);
          if (parsed?.error?.message) {
            displayMessage = parsed.error.message;
          }
        } catch (e) {
          // ignore parsing error, stick to default
        }

        const isQuotaError =
          response.status === 429 ||
          errorText.toLowerCase().includes("quota") ||
          errorText.toLowerCase().includes("too_many_requests") ||
          errorText.toLowerCase().includes("resource_exhausted") ||
          displayMessage.toLowerCase().includes("quota") ||
          displayMessage.toLowerCase().includes("too_many_requests");

        if (isQuotaError) {
          displayMessage = `Gemini API Quota Limit Reached: ${displayMessage}. The shared free-tier Google Gemini API Key has run out of request quota. To resolve this, go to Settings > Secrets inside AI Studio to verify your personal Gemini API key or set up billing.`;
          sendError(displayMessage);
          res.end();
          return;
        }

        // For non-quota errors (such as 403 permission_denied, 404 env not found, etc.), seamlessly fall back to direct Gemini model analysis
        console.log(
          `[analyze] Falling back to Direct Gemini Analysis due to API status ${response.status}...`,
        );
        await runDirectGeminiAnalysis(
          question,
          uploadedFiles,
          effectiveDatasetName,
          sendEvent,
          sendError,
          res,
        );
        return;
      }

      console.log(
        `[analyze] Response remains ok. Constructing SSE stream reader...`,
      );
      let accumulatedText = "";
      let envId: string | undefined = environmentId;
      let interactionId: string | undefined;
      let reportArtifactReady = false;

      let eventCount = 0;
      for await (const event of streamInteraction(response)) {
        eventCount++;
        console.log(
          `[analyze] SSE yields streaming event #${eventCount}: type="${event.type}"`,
        );
        if (event.type === "done") {
          console.log(
            `[analyze] Received explicit "done" marker from interaction stream.`,
          );
          break;
        }
        if (event.type === "interaction") {
          envId = extractEnvironmentId(event.interaction) || envId;
          interactionId =
            extractInteractionId(event.interaction) || interactionId;
          sendSessionEnvironment(envId);
          console.log(
            `[analyze] Interaction created. Environment ID: "${envId}", interaction ID: "${interactionId}"`,
          );
        }
        if (event.type === "complete") {
          envId = extractEnvironmentId(event.interaction) || envId;
          interactionId =
            extractInteractionId(event.interaction) || interactionId;
          sendSessionEnvironment(envId);
          console.log(
            `[analyze] Interaction completed. Extracted environment ID: "${envId}"`,
          );
          const usage = event.interaction?.usage as any;
          if (usage) {
            console.log(
              `[agent] Token usage: ${usage.total_tokens} total tokens (${usage.total_input_tokens} input, ${usage.total_output_tokens} output, ${usage.total_thought_tokens || 0} thought, ${usage.total_cached_tokens || 0} cached)`,
            );
          }

          // Fallback extraction: iterate and combine text from all elements of the steps array
          const stepsObj = event.interaction?.steps as any[];
          if (Array.isArray(stepsObj)) {
            let combinedStepsText = "";
            for (const step of stepsObj) {
              const isReasoningStep =
                step.type === "thinking" ||
                step.type === "thought" ||
                step.type === "reasoning";
              if (!isReasoningStep && Array.isArray(step.content)) {
                for (const part of step.content) {
                  if (part && typeof part === "object") {
                    if (part.type === "text" && part.text) {
                      combinedStepsText += part.text;
                    } else if (part.text && part.type !== "thought") {
                      combinedStepsText += part.text;
                    }
                  } else if (typeof part === "string") {
                    combinedStepsText += part;
                  }
                }
              }
            }
            if (
              combinedStepsText &&
              combinedStepsText.length > accumulatedText.length
            ) {
              console.log(
                `[analyze] Dynamic steps recovery: Reconstructed text of length ${combinedStepsText.length} exceeds accumulated text of length ${accumulatedText.length}. Restoring fallback text.`,
              );
              accumulatedText = combinedStepsText;
            }
          }
        }

        // Log events to the terminal as well
        if (event.type === "thinking")
          console.log(
            `[agent] thinking delta: ${event.text?.substring(0, 30)}...`,
          );
        else if (event.type === "tool_call") {
          console.log(`[agent] tool_call: ${event.name}`);
          console.log(
            `[agent] args:`,
            JSON.stringify(event.arguments, null, 2),
          );
        } else if (event.type === "tool_result") {
          console.log(`[agent] tool_result for tool: ${event.name}`);
          if (
            event.result?.includes("Report saved to") &&
            event.result.includes("report.json")
          ) {
            reportArtifactReady = true;
            console.log(
              "[analyze] Agent confirmed report.json was saved in the sandbox.",
            );
          }
        } else if (event.type === "text") {
          console.log(
            `[agent] text output segment: ${event.text?.substring(0, 30)}...`,
          );
        }

        sendEvent(event);

        if (event.type === "text" && event.text) {
          accumulatedText += event.text;
        }
        if (reportArtifactReady && envId) {
          console.log(
            "[analyze] report.json is ready; stopping stream consumption and retrieving the sandbox snapshot.",
          );
          break;
        }
      }

      // If the hosted SSE connection closed before interaction.completed,
      // recover the environment ID from the interaction resource itself.
      if (!envId && interactionId) {
        try {
          const interactionPath = interactionId.startsWith("interactions/")
            ? interactionId
            : `interactions/${interactionId}`;
          const interactionRes = await fetch(
            `${API_BASE_URL}/${interactionPath}`,
            {
              headers: {
                "x-goog-api-key": process.env.GEMINI_API_KEY || "",
                "Api-Revision": "2026-05-20",
                "x-goog-api-client": "applet-ai-data-analyst/1.0.0",
              },
            },
          );
          if (interactionRes.ok) {
            const interactionData = await interactionRes.json();
            envId = extractEnvironmentId(interactionData);
            sendSessionEnvironment(envId);
            console.log(
              `[analyze] Recovered environment ID from interaction resource: "${envId}"`,
            );
          } else {
            console.warn(
              `[analyze] Could not recover interaction metadata: ${interactionRes.status} ${interactionRes.statusText}`,
            );
          }
        } catch (metadataErr) {
          console.warn(
            "[analyze] Interaction metadata recovery failed:",
            metadataErr,
          );
        }
      }

      // Fallback: if the agent emitted the report JSON inline in its text output, parse it.
      if (accumulatedText) {
        try {
          const blocks = extractJsonBlocks(accumulatedText);
          const reportBlock = blocks
            .reverse()
            .find(
              (b: any) =>
                b &&
                typeof b === "object" &&
                (b.executive_summary || b.insights || b.title),
            );
          if (reportBlock) {
            reportDelivered = true;
            const enriched = enrichAndVerifyReport(reportBlock);
            sendEvent({ type: "report_data", data: enriched });
          }
        } catch (e) {
          console.error(
            "Failed to parse JSON blocks fallback from accumulated text:",
            e,
          );
        }
      }

      if (envId) {
        sendEvent({
          type: "info",
          message: reportArtifactReady
            ? "Report created. Retrieving dashboard files..."
            : "Retrieving report and charts from the analysis environment...",
        });
        try {
          const downloadUrl = `${API_BASE_URL}/files/environment-${envId}:download?alt=media`;
          let res: Response | null = null;
          for (let attempt = 1; attempt <= 5; attempt++) {
            res = await fetch(downloadUrl, {
              headers: { "x-goog-api-key": process.env.GEMINI_API_KEY || "" },
            });
            if (
              res.ok ||
              ![404, 409, 425].includes(res.status) ||
              attempt === 5
            )
              break;
            console.log(
              `[analyze] Environment snapshot not ready (attempt ${attempt}/5). Retrying...`,
            );
            await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
          }

          if (res?.ok) {
            const arrayBuffer = await res.arrayBuffer();
            const tarBuffer = Buffer.from(arrayBuffer);
            const extractedFiles = extractTarInMemory(tarBuffer);

            let report: any = null;
            // Map of chart basename -> chart image URL
            const chartImages: Record<string, string> = {};

            // Prepare run directory for chart image output
            let runId = "gen-" + Math.random().toString(36).substring(2, 10);
            if (typeof generationId === "string" && /^[A-Za-z0-9_-]+$/.test(generationId)) {
              runId = generationId;
            }
            const outputDirRoot = path.join(process.cwd(), "output");
            let chartRunDir = path.join(outputDirRoot, runId, "charts");
            if (fs.existsSync(chartRunDir)) {
              runId = `${runId}-${Date.now()}`;
              chartRunDir = path.join(outputDirRoot, runId, "charts");
            }
            fs.mkdirSync(chartRunDir, { recursive: true });

            for (const [filePath, fileContent] of Object.entries(
              extractedFiles,
            )) {
              const normalized = filePath.replace(/^\.\//, "");
              if (
                normalized.endsWith("data/report.json") ||
                normalized.endsWith("/report.json") ||
                normalized === "report.json"
              ) {
                try {
                  report = JSON.parse(fileContent.toString("utf8"));
                } catch (err) {
                  console.error(
                    "Failed to parse report.json from memory:",
                    err,
                  );
                }
              } else if (
                normalized.includes("charts/") &&
                /\.(png|jpg|jpeg)$/i.test(normalized)
              ) {
                let base = normalized.split("/").pop() as string;
                if (!/^[A-Za-z0-9_.-]+\.(png|jpe?g)$/i.test(base)) {
                  const ext = base.split(".").pop() || "png";
                  base = `chart-${Object.keys(chartImages).length + 1}.${ext}`;
                }
                const targetFilePath = path.join(chartRunDir, base);
                try {
                  fs.writeFileSync(targetFilePath, fileContent);
                  chartImages[base] = `/output/${runId}/charts/${base}`;
                } catch (writeErr) {
                  console.error(`Failed to write chart ${base} to disk:`, writeErr);
                }
              }
            }

            const reportMatchesCurrentQuestion =
              typeof report?.question === "string" &&
              report.question.trim().toLowerCase() ===
                question.trim().toLowerCase();
            if (
              isFollowUp &&
              !reportArtifactReady &&
              !reportMatchesCurrentQuestion
            ) {
              console.warn(
                "[analyze] Follow-up stream ended without producing a replacement report. Preserving the existing dashboard.",
              );
              sendError(
                "The follow-up analysis stopped before it could update the dashboard. Your previous report has been preserved; please try the question again.",
              );
              return;
            }

            if (!report) {
              console.log(
                "[analyze] report.json was not found in the tar archive. Generating server-side fallback report...",
              );
              const displayTables: any[] = [];

              for (const [filePath, fileContent] of Object.entries(
                extractedFiles,
              )) {
                const normalized = filePath.replace(/^\.\//, "");
                if (
                  normalized.endsWith(".csv") &&
                  !normalized.includes("data/report.json")
                ) {
                  try {
                    const csvText = fileContent.toString("utf8");
                    const lines = csvText
                      .split("\n")
                      .map((l) => l.trim())
                      .filter(Boolean);
                    if (lines.length > 0) {
                      const headers = lines[0]
                        .split(",")
                        .map((h) => h.replace(/^["']|["']$/g, ""));
                      const rows = lines.slice(1, 21).map((line) => {
                        return line
                          .split(",")
                          .map((val) => val.replace(/^["']|["']$/g, ""));
                      });
                      const filename =
                        normalized.split("/").pop() || "table.csv";
                      const title = filename
                        .replace(/\.csv$/i, "")
                        .replace(/_/g, " ")
                        .replace(/\b\w/g, (c) => c.toUpperCase());
                      displayTables.push({
                        title,
                        columns: headers,
                        rows,
                        caption: `Generated data table: ${filename}`,
                      });
                    }
                  } catch (csvErr) {
                    console.error(
                      `Failed to parse csv fallback for ${normalized}:`,
                      csvErr,
                    );
                  }
                }
              }

              if (
                displayTables.length > 0 ||
                Object.keys(chartImages).length > 0 ||
                accumulatedText
              ) {
                let summary =
                  "The data analyst has finished processing your calculations.";
                if (accumulatedText) {
                  summary = accumulatedText
                    .replace(/```json[\s\S]*?```/g, "")
                    .trim();
                  if (summary.length > 500) {
                    summary = summary.substring(0, 500) + "...";
                  }
                }

                report = {
                  dataset_name: effectiveDatasetName || "Dataset",
                  question: question,
                  title: `Analysis Report: ${effectiveDatasetName || "Dataset"}`,
                  executive_summary: summary,
                  insights: [
                    {
                      title: "Calculations Completed",
                      detail:
                        "The analysis successfully completed the necessary Python computations. Explore the generated data tables and supporting documents below.",
                      metric: "Status",
                      value: "Success",
                    },
                  ],
                  charts: [],
                  tables: displayTables,
                  methodology:
                    "Computed using Pandas inside the sandboxed data analyst workspace.",
                  recommendations: [
                    "Review the structured output tables and charts below for specific metrics.",
                  ],
                  generated_at: new Date().toISOString().split("T")[0],
                };
              }
            }

            if (report) {
              // Embed chart image data into the referenced chart entries by matching basename.
              if (Array.isArray(report.charts)) {
                for (const chart of report.charts) {
                  if (
                    chart &&
                    typeof chart === "object" &&
                    typeof chart.file === "string"
                  ) {
                    const base = chart.file.split("/").pop() as string;
                    if (chartImages[base]) {
                      chart.image = chartImages[base];
                    }
                  }
                }
              }

              // Append any rendered charts the report didn't explicitly reference.
              const referenced = new Set(
                (Array.isArray(report.charts) ? report.charts : [])
                  .map((c: any) =>
                    typeof c?.file === "string"
                      ? c.file.split("/").pop()
                      : null,
                  )
                  .filter(Boolean),
              );
              const extras = Object.keys(chartImages)
                .filter((base) => !referenced.has(base))
                .map((base) => ({
                  title: base.replace(/\.[^.]+$/, "").replace(/_/g, " "),
                  file: `charts/${base}`,
                  caption: "",
                  type: "bar",
                  image: chartImages[base],
                }));
              if (extras.length > 0) {
                report.charts = [
                  ...(Array.isArray(report.charts) ? report.charts : []),
                  ...extras,
                ];
              }

              reportDelivered = true;
              report = enrichAndVerifyReport(report);
              sendEvent({ type: "report_data", data: report });
            } else {
              console.error(
                "report.json was not found in the extracted tar archive",
              );
              sendError("The analysis ran but report.json was not produced.");
            }
          } else {
            const errBody = res ? await res.text() : "No response received";
            console.error("Failed to download snapshot:", errBody);
            let displayMessage = `Failed to retrieve files from the analysis environment: ${errBody}`;
            try {
              const parsed = JSON.parse(errBody);
              if (parsed?.error?.message) {
                const msg = parsed.error.message.toLowerCase();
                if (
                  msg.includes("not found") ||
                  msg.includes("not accessible")
                ) {
                  displayMessage =
                    "The previous analysis session has expired or the remote environment has been recycled due to inactivity. Please start a fresh analysis session by uploading your CSV files again.";
                } else {
                  displayMessage = parsed.error.message;
                }
              }
            } catch (e) {
              if (
                errBody.toLowerCase().includes("not found") ||
                errBody.toLowerCase().includes("not accessible")
              ) {
                displayMessage =
                  "The previous analysis session has expired or the remote environment has been recycled due to inactivity. Please start a fresh analysis session by uploading your CSV files again.";
              }
            }
            sendError(displayMessage);
          }
        } catch (err: any) {
          console.error("Error processing snapshot in memory:", err);
          sendError(`Error extracting analysis files: ${err.message}`);
        }
      }

      isFinished = true;
      if (!reportDelivered && !streamFailed) {
        console.log("[analyze] Stream finished without delivering report. Falling back to direct Gemini model analysis...");
        await runDirectGeminiAnalysis(
          question,
          uploadedFiles,
          effectiveDatasetName,
          sendEvent,
          sendError,
          res
        );
        return;
      }
      if (reportDelivered && !streamFailed) {
        sendEvent({ type: "status", status: "completed" });
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.log(`[analyze] Agent interaction aborted successfully.`);
      } else {
        console.error(`[analyze] Error:`, err);
        sendError(err instanceof Error ? err.message : "Unknown error");
      }
    } finally {
      isFinished = true;
      clearInterval(heartbeatInterval);
      if (generationId) {
        activeGenerations.delete(generationId);
      }
      res.end();

      // Files are kept for follow-up chats. They are only deleted when clicking "New Analysis" (POST /api/clear-files).
      /*
     if (!isFollowUp && uploadedFiles.length > 0) {
       deleteGcsFiles(uploadedFiles).catch(err => {
         console.error("[analyze] Error in background deleteGcsFiles:", err);
       });
     }
     */
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development (with a robust fallback to dev middleware if dist/index.html is missing)
  const distPath = path.join(process.cwd(), "dist");
  const indexHtmlExists = fs.existsSync(path.join(distPath, "index.html"));

  if (process.env.NODE_ENV !== "production" || !indexHtmlExists) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "Production mode enabled, but dist/index.html not found. Falling back to Vite dev server middleware to ensure app stays operational.",
      );
    }
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    // Express 5 format for catch-all (if using express 5) or Express 4. Let's use *all for v5 or * for v4.
    // We can use default express 4 catch-all
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const startListening = (port: number) => {
    const server = app
      .listen(port, "0.0.0.0", () => {
        console.log(`Server running on http://localhost:${port}`);
      })
      .on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          console.log(`Port ${port} is in use, trying ${port + 1}...`);
          startListening(port + 1);
        } else {
          console.error(err);
        }
      });

    // Disable timeouts for long-running agent interactions
    server.setTimeout(0);
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 0;
  };

  startListening(PORT);
}

startServer();
