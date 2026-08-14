const fs = require('fs');
const jpeg = require('jpeg-js');

const MIN_REGION_AREA = 2000; // ignore small green speckles/noise
// The placeholder green varies a bit between template revisions (seen both
// #00ff2a and #24ff00) - isGreen() is a fuzzy range check, not an exact
// match, so it tolerates that. GREEN_LABEL is just for log/error messages.
const GREEN_LABEL = 'green (~#00ff2a-#24ff00)';

function isGreen(r, g, b) {
  return g > 180 && r < 100 && b < 150 && g > r + 80 && g > b + 60;
}

function decodeJpeg(filePath) {
  const buffer = fs.readFileSync(filePath);
  return jpeg.decode(buffer, { useTArray: true }); // { width, height, data: RGBA }
}

// 4-connected flood fill over a green/not-green mask, iterative (stack-based)
// to avoid recursion-depth issues on a ~3M pixel image.
function findGreenRegions(width, height, data) {
  const pixelCount = width * height;
  const mask = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    mask[i] = isGreen(data[o], data[o + 1], data[o + 2]) ? 1 : 0;
  }

  const visited = new Uint8Array(pixelCount);
  const regions = [];
  const stack = new Int32Array(pixelCount);

  for (let start = 0; start < pixelCount; start++) {
    if (!mask[start] || visited[start]) continue;

    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    let count = 0;

    while (sp > 0) {
      const cur = stack[--sp];
      const cx = cur % width;
      const cy = (cur - cx) / width;
      count++;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      if (cy > 0) {
        const n = cur - width;
        if (mask[n] && !visited[n]) { visited[n] = 1; stack[sp++] = n; }
      }
      if (cy < height - 1) {
        const n = cur + width;
        if (mask[n] && !visited[n]) { visited[n] = 1; stack[sp++] = n; }
      }
      if (cx > 0) {
        const n = cur - 1;
        if (mask[n] && !visited[n]) { visited[n] = 1; stack[sp++] = n; }
      }
      if (cx < width - 1) {
        const n = cur + 1;
        if (mask[n] && !visited[n]) { visited[n] = 1; stack[sp++] = n; }
      }
    }

    if (count > MIN_REGION_AREA) {
      regions.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area: count });
    }
  }

  return regions;
}

// Maps the 4 detected blobs to named zones by shape/position, not by
// assuming an exact pixel location - so it tolerates the "slight" drift
// the designer expects between template revisions. Topology must still
// match (1 big Featured/center, 1 Upcoming/left, 2 stacked boxes on the
// right - Recent above Prayers) - a real layout change (different box
// count/arrangement) throws, on purpose, rather than silently guessing
// wrong.
function classifyZones(regions, canvasWidth) {
  if (regions.length !== 4) {
    throw new Error(
      `Expected 4 ${GREEN_LABEL} zones, found ${regions.length}. ` +
      'This looks like a structural layout change, not a minor position/size tweak - the zone-classification logic in server/services/templateScan.js needs updating to match.'
    );
  }

  const byArea = [...regions].sort((a, b) => b.area - a.area);
  const middle = byArea[0];
  const rest = byArea.slice(1);

  const half = canvasWidth / 2;
  const left = rest.filter((r) => r.x + r.w / 2 < half);
  const right = rest.filter((r) => r.x + r.w / 2 >= half);

  if (left.length !== 1 || right.length !== 2) {
    throw new Error(
      `Expected 1 left-side box and 2 right-side boxes among the remaining 3 zones, found ${left.length} left / ${right.length} right. ` +
      'This looks like a structural layout change, not a minor position/size tweak.'
    );
  }

  // The two right-side boxes stack vertically - Recent on top, Prayers
  // (new, below it) underneath - so sort by y to tell them apart.
  const [recent, prayers] = [...right].sort((a, b) => a.y - b.y);

  return { left: left[0], middle, right: recent, prayers };
}

function scanTemplate(filePath) {
  const { width, height, data } = decodeJpeg(filePath);
  const regions = findGreenRegions(width, height, data);
  const zones = classifyZones(regions, width);
  return { canvasWidth: width, canvasHeight: height, zones };
}

module.exports = { scanTemplate, findGreenRegions, classifyZones, decodeJpeg };
