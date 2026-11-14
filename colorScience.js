/* ============================================================
   colorScience.js — v3.0 (Precision Color Science & Manifold Projection)
   
   Thư viện thuần túy: chuyển đổi màu + ước lượng pH độ chính xác cao
   KHÔNG đụng DOM — dùng được cho Node.js, Web Worker, trình duyệt...

   CẢI TIẾN v3.0 (High-Precision Calibration):
     ✅ Bảng màu tham chiếu chuẩn sRGB & CIELAB cho giấy quỳ pH 3.0 - 9.0
     ✅ Chuẩn hóa Hue liên tục qua 0°/360° (sửa triệt để lỗi màu đỏ dải 350°-360°)
     ✅ Chiếu đa tạp (Manifold Curve Projection) trên không gian CIELAB (CIEDE2000)
     ✅ Cân bằng trắng chọn lọc (Selective White-Patch on Neutral Prior)
        -> Không làm bợt hay biến dạng màu khi ảnh đã crop sát dải quỳ!
     ✅ Lấy mẫu Gaussian kernel đa điểm + lọc dị biệt MAD (Median Absolute Deviation)
     ✅ Thang điểm độ tin cậy đa yếu tố (khoảng cách đa tạp, độ bão hòa, chiếu sáng)
     ✅ Đồng bộ 100% nhóm phân loại với recommendations.json (very-acid, acid, optimal...)
   ============================================================ */

(function(global){
  'use strict';

  /* ============================================================
     HẰNG SỐ CHUẨN CIE — WHITE POINTS
     ============================================================ */
  const D65 = { Xn: 95.047, Yn: 100.000, Zn: 108.883 };
  const D50 = { Xn: 96.422, Yn: 100.000, Zn: 82.521 };
  const A   = { Xn: 109.850, Yn: 100.000, Zn: 35.585 };

  /* ============================================================
     BẢNG MÀU THAM CHIẾU GIẤY QUỲ CHUẨN — Dải pH 3.0 → 9.0 (bước 0.5)
     Chuẩn sRGB cho điều kiện D65, ánh sáng tiêu chuẩn buồng đo
     ============================================================ */
  const DEFAULT_REF_COLORS = [
    { ph: 3.0, r: 195, g: 28,  b: 48,  name: 'Đỏ thẫm' },
    { ph: 3.5, r: 208, g: 42,  b: 48,  name: 'Đỏ đậm' },
    { ph: 4.0, r: 220, g: 60,  b: 54,  name: 'Đỏ tươi' },
    { ph: 4.5, r: 228, g: 96,  b: 62,  name: 'Đỏ cam' },
    { ph: 5.0, r: 236, g: 142, b: 72,  name: 'Cam' },
    { ph: 5.5, r: 242, g: 192, b: 86,  name: 'Vàng cam' },
    { ph: 6.0, r: 182, g: 208, b: 96,  name: 'Vàng chanh' },
    { ph: 6.5, r: 116, g: 194, b: 114, name: 'Xanh lá' },
    { ph: 7.0, r: 72,  g: 176, b: 170, name: 'Xanh ngọc' },
    { ph: 7.5, r: 62,  g: 132, b: 198, name: 'Xanh lam' },
    { ph: 8.0, r: 58,  g: 96,  b: 208, name: 'Xanh dương đậm' },
    { ph: 8.5, r: 74,  g: 78,  b: 198, name: 'Xanh tím' },
    { ph: 9.0, r: 94,  g: 58,  b: 176, name: 'Tím' }
  ];

  const PH_MIN = 3.0;
  const PH_MAX = 9.0;

  /* ============================================================
     NHÃN TIẾNG VIỆT & KHUYẾN NGHỊ (Khớp hoàn toàn với recommendations.json)
     ============================================================ */
  const PH_DETAILED_LABELS = {
    'very-acid':         { vi: 'Chua gắt',  color: '#dc2626', advice: 'Bón vôi lượng lớn, tăng cường hữu cơ, ngừa nấm rễ' },
    'acid':              { vi: 'Chua',      color: '#f97316', advice: 'Bón vôi nhẹ, bổ sung phân chuồng hoai mục' },
    'optimal':           { vi: 'Tối ưu',    color: '#10b981', advice: 'Đất lý tưởng cho sầu riêng (5.5 - 6.5), duy trì hữu cơ' },
    'slightly-alkaline': { vi: 'Hơi kiềm',  color: '#3b82f6', advice: 'Bón phân hữu cơ sinh học, thêm lưu huỳnh nếu cần hạ pH' },
    'alkaline':          { vi: 'Kiềm',      color: '#8b5cf6', advice: 'Bón thạch cao, rửa mặn, hạ pH, tăng vi sinh' }
  };

  // Aliases để tương thích ngược
  PH_DETAILED_LABELS['very-strong-acid'] = PH_DETAILED_LABELS['very-acid'];
  PH_DETAILED_LABELS['strong-acid']      = PH_DETAILED_LABELS['very-acid'];

  /* ============================================================
     1. CHUYỂN ĐỔI KHÔNG GIAN MÀU
     ============================================================ */

  /**
   * sRGB gamma expansion (IEC 61966-2-1)
   */
  function srgbToLinear(c){
    c = c / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  /**
   * Linear → gamma-encoded sRGB [0-1]
   */
  function linearToSrgb(c){
    if(c <= 0.0031308) return c * 12.92;
    return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  /**
   * RGB → HSV
   * @returns {{h:number, s:number, v:number}} h:0-360, s:0-100, v:0-100
   */
  function rgb2hsv(r, g, b){
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;

    if(d !== 0){
      if(max === r)      h = (g - b) / d + (g < b ? 6 : 0);
      else if(max === g) h = (b - r) / d + 2;
      else               h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), v: Math.round(v * 100) };
  }

  /**
   * RGB → HSL
   * @returns {{h:number, s:number, l:number}}
   */
  function rgb2hsl(r, g, b){
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;

    if(max !== min){
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if(max === r)      h = (g - b) / d + (g < b ? 6 : 0);
      else if(max === g) h = (b - r) / d + 2;
      else               h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  /**
   * Chuẩn hóa Hue quanh trục đỏ:
   * Giá trị đỏ thẫm 300°-360° được ánh xạ liên tục thành số góc âm [-60°, 0°]
   * Tránh hiện tượng đứt gãy phi tuyến tính tại điểm 0°/360°.
   */
  function normalizeHue(h){
    return h > 300 ? h - 360 : h;
  }

  /**
   * RGB → XYZ (chuẩn sRGB D65)
   */
  function rgb2xyz(r, g, b, illuminant){
    const R = srgbToLinear(r);
    const G = srgbToLinear(g);
    const B = srgbToLinear(b);

    let M;
    if(illuminant === 'D50'){
      M = [
        [0.4360747, 0.3850649, 0.1430804],
        [0.2225045, 0.7168786, 0.0606169],
        [0.0139322, 0.0971045, 0.7141733]
      ];
    } else {
      M = [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041]
      ];
    }

    return {
      x: (R * M[0][0] + G * M[0][1] + B * M[0][2]) * 100,
      y: (R * M[1][0] + G * M[1][1] + B * M[1][2]) * 100,
      z: (R * M[2][0] + G * M[2][1] + B * M[2][2]) * 100
    };
  }

  /**
   * XYZ → CIELAB
   */
  function xyz2lab(x, y, z, whitePoint){
    const wp = whitePoint || D65;
    const epsilon = 216 / 24389;
    const kappa = 24389 / 27;

    const f = t => t > epsilon ? Math.cbrt(t) : (kappa * t + 16) / 116;

    const fx = f(x / wp.Xn);
    const fy = f(y / wp.Yn);
    const fz = f(z / wp.Zn);

    return {
      L: 116 * fy - 16,
      a: 500 * (fx - fy),
      b: 200 * (fy - fz)
    };
  }

  /**
   * RGB → CIELAB
   */
  function rgb2lab(r, g, b, illuminant){
    const wp = illuminant === 'D50' ? D50 : illuminant === 'A' ? A : D65;
    const xyz = rgb2xyz(r, g, b, illuminant);
    return xyz2lab(xyz.x, xyz.y, xyz.z, wp);
  }

  /* ============================================================
     2. SO SÁNH MÀU — CIEDE2000 (CIE 2000)
     Hỗ trợ trọng số kL, kC, kH (mặc định kL=1.4 để chống nhiễu phơi sáng)
     ============================================================ */
  function deltaE2000(lab1, lab2, weights){
    weights = weights || {};
    const kL = weights.kL || 1.4;
    const kC = weights.kC || 1.0;
    const kH = weights.kH || 1.0;

    const L1 = lab1.L, a1 = lab1.a, b1 = lab1.b;
    const L2 = lab2.L, a2 = lab2.a, b2 = lab2.b;

    const C1 = Math.sqrt(a1*a1 + b1*b1);
    const C2 = Math.sqrt(a2*a2 + b2*b2);
    const Cbar = (C1 + C2) / 2;
    const Cbar7 = Math.pow(Cbar, 7);
    const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));

    const a1p = (1 + G) * a1;
    const a2p = (1 + G) * a2;
    const C1p = Math.sqrt(a1p*a1p + b1*b1);
    const C2p = Math.sqrt(a2p*a2p + b2*b2);

    let h1p = Math.atan2(b1, a1p) * 180 / Math.PI;
    if(h1p < 0) h1p += 360;
    let h2p = Math.atan2(b2, a2p) * 180 / Math.PI;
    if(h2p < 0) h2p += 360;

    const dLp = L2 - L1;
    const dCp = C2p - C1p;

    let dhp = 0;
    if(C1p * C2p !== 0){
      dhp = h2p - h1p;
      if(dhp > 180) dhp -= 360;
      else if(dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * Math.PI / 360);

    const Lbarp = (L1 + L2) / 2;
    const Cbarp = (C1p + C2p) / 2;

    let hbarp = 0;
    if(C1p * C2p !== 0){
      hbarp = (h1p + h2p) / 2;
      if(Math.abs(h1p - h2p) > 180){
        hbarp = (h1p + h2p < 360)
          ? (h1p + h2p + 360) / 2
          : (h1p + h2p - 360) / 2;
      }
    }

    const T = 1
      - 0.17 * Math.cos((hbarp - 30) * Math.PI / 180)
      + 0.24 * Math.cos(2 * hbarp * Math.PI / 180)
      + 0.32 * Math.cos((3 * hbarp + 6) * Math.PI / 180)
      - 0.20 * Math.cos((4 * hbarp - 63) * Math.PI / 180);

    const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2))
                 / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
    const SC = 1 + 0.045 * Cbarp;
    const SH = 1 + 0.015 * Cbarp * T;

    const Cbarp7 = Math.pow(Cbarp, 7);
    const RT = -2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)))
             * Math.sin(60 * Math.exp(-Math.pow((hbarp - 275) / 25, 2)) * Math.PI / 180);

    return Math.sqrt(
      Math.pow(dLp / (kL * SL), 2) +
      Math.pow(dCp / (kC * SC), 2) +
      Math.pow(dHp / (kH * SH), 2) +
      RT * (dCp / (kC * SC)) * (dHp / (kH * SH))
    );
  }

  /* ============================================================
     3. ƯỚC LƯỢNG NHIỆT ĐỘ MÀU (CCT) — McCamy's approximation
     ============================================================ */
  function estimateCCT(r, g, b){
    const xyz = rgb2xyz(r, g, b);
    const sum = xyz.x + xyz.y + xyz.z;
    if(sum === 0) return 6500;

    const x = xyz.x / sum;
    const y = xyz.y / sum;
    const n = (x - 0.3320) / (0.1858 - y);
    const cct = 449 * n*n*n + 3525 * n*n + 6823.3 * n + 5520.33;

    return Math.max(2000, Math.min(15000, cct));
  }

  /* ============================================================
     4. PHÁT HIỆN PIXEL ĐẶC BIỆT
     ============================================================ */
  function isHighlight(r, g, b, threshold){
    threshold = threshold || 248;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max >= threshold && (max - min) < 25;
  }

  function isShadow(r, g, b, threshold){
    threshold = threshold || 25;
    return (r + g + b) / 3 < threshold;
  }

  /* ============================================================
     5. CÂN BẰNG TRẮNG CHỌN LỌC (Selective White-Patch)
     Tôn trọng màu dải quỳ: Chỉ cân bằng trắng khi phát hiện bề mặt
     trung tính/trắng thực tế (viền giấy, nền trắng). Nếu ảnh đã crop
     sát dải màu chỉ có quỳ, GIỮ NGUYÊN (scale=1.0) để không làm bợt màu!
     ============================================================ */
  function autoWhiteBalance(imgData, options){
    options = options || {};
    const data = imgData.data;
    const len = data.length;

    const neutralPixels = [];
    let sumR = 0, sumG = 0, sumB = 0, n = 0;

    // Quét tìm pixel trung tính (Neutral Candidates)
    for(let i = 0; i < len; i += 4){
      const r = data[i], g = data[i+1], b = data[i+2];

      if(isHighlight(r, g, b) || isShadow(r, g, b)) continue;

      sumR += r; sumG += g; sumB += b; n++;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;

      // Pixel trung tính/trắng nền: độ sáng tốt (120-252) và độ lệch kênh thấp (< 38)
      if(lum >= 120 && lum <= 252 && (max - min) <= 38){
        neutralPixels.push({ r, g, b, lum });
      }
    }

    if(n === 0){
      return { scaleR: 1.0, scaleG: 1.0, scaleB: 1.0, method: 'none', cct: 6500 };
    }

    const avgAllR = sumR / n, avgAllG = sumG / n, avgAllB = sumB / n;
    const cctEst = Math.round(estimateCCT(avgAllR, avgAllG, avgAllB));

    // Nếu tìm thấy đủ pixel trung tính thực tế (>= 25 pixel)
    if(neutralPixels.length >= 25){
      neutralPixels.sort((a, b) => b.lum - a.lum);
      const topCount = Math.max(15, Math.floor(neutralPixels.length * 0.25));
      let topR = 0, topG = 0, topB = 0;
      for(let i = 0; i < topCount; i++){
        topR += neutralPixels[i].r;
        topG += neutralPixels[i].g;
        topB += neutralPixels[i].b;
      }
      const whiteR = topR / topCount;
      const whiteG = topG / topCount;
      const whiteB = topB / topCount;
      const maxCh = Math.max(whiteR, whiteG, whiteB);

      return {
        scaleR: Math.max(0.75, Math.min(1.30, maxCh / Math.max(1, whiteR))),
        scaleG: Math.max(0.75, Math.min(1.30, maxCh / Math.max(1, whiteG))),
        scaleB: Math.max(0.75, Math.min(1.30, maxCh / Math.max(1, whiteB))),
        method: 'neutral-reference',
        neutralCount: neutralPixels.length,
        cct: cctEst
      };
    }

    // Nếu không có pixel trắng (ảnh đã crop sát vào dải quỳ màu sắc):
    // Giữ nguyên tỉ lệ để không làm hỏng màu thuốc thử!
    return {
      scaleR: 1.0,
      scaleG: 1.0,
      scaleB: 1.0,
      method: 'pass-through',
      neutralCount: 0,
      cct: cctEst
    };
  }

  /* ============================================================
     6. LẤY MẪU MÀU GAUSSIAN NÂNG CAO + LỌC DỊ BIỆT MAD
     ============================================================ */
  function sampleColors(imgData, cx, cy, size){
    size = size || 11;
    const data = imgData.data;
    const w = imgData.width;
    const h = imgData.height;
    const half = Math.floor(size / 2);
    const samples = [];
    const sigma = Math.max(1.2, size / 3);

    for(let y = cy - half; y <= cy + half; y++){
      for(let x = cx - half; x <= cx + half; x++){
        if(x < 0 || y < 0 || x >= w || y >= h) continue;
        const idx = (y * w + x) * 4;
        const r = data[idx], g = data[idx+1], b = data[idx+2];

        if(isHighlight(r, g, b) || isShadow(r, g, b)) continue;

        const dx = x - cx, dy = y - cy;
        const weight = Math.exp(-(dx*dx + dy*dy) / (2 * sigma * sigma));
        samples.push({ r, g, b, weight });
      }
    }

    if(samples.length === 0){
      return { r: 128, g: 128, b: 128, count: 0, cct: 6500, dispersion: 0 };
    }

    const rs = samples.map(s => s.r).sort((a, b) => a - b);
    const gs = samples.map(s => s.g).sort((a, b) => a - b);
    const bs = samples.map(s => s.b).sort((a, b) => a - b);

    const medianR = rs[Math.floor(rs.length / 2)];
    const medianG = gs[Math.floor(gs.length / 2)];
    const medianB = bs[Math.floor(bs.length / 2)];

    const mad = (arr, med) => {
      const devs = arr.map(v => Math.abs(v - med)).sort((a, b) => a - b);
      return devs[Math.floor(devs.length / 2)] || 1;
    };

    const madR = mad(rs, medianR);
    const madG = mad(gs, medianG);
    const madB = mad(bs, medianB);

    const thrR = 2.5 * madR + 4;
    const thrG = 2.5 * madG + 4;
    const thrB = 2.5 * madB + 4;

    let wSumR = 0, wSumG = 0, wSumB = 0, wTotal = 0;
    let inlierCount = 0;

    for(let i = 0; i < samples.length; i++){
      const s = samples[i];
      if(Math.abs(s.r - medianR) > thrR) continue;
      if(Math.abs(s.g - medianG) > thrG) continue;
      if(Math.abs(s.b - medianB) > thrB) continue;

      wSumR += s.r * s.weight;
      wSumG += s.g * s.weight;
      wSumB += s.b * s.weight;
      wTotal += s.weight;
      inlierCount++;
    }

    if(wTotal === 0){
      return {
        r: medianR, g: medianG, b: medianB,
        count: samples.length,
        cct: Math.round(estimateCCT(medianR, medianG, medianB)),
        dispersion: Math.round((madR + madG + madB) / 3)
      };
    }

    const finalR = Math.round(wSumR / wTotal);
    const finalG = Math.round(wSumG / wTotal);
    const finalB = Math.round(wSumB / wTotal);

    return {
      r: Math.max(0, Math.min(255, finalR)),
      g: Math.max(0, Math.min(255, finalG)),
      b: Math.max(0, Math.min(255, finalB)),
      count: inlierCount,
      cct: Math.round(estimateCCT(finalR, finalG, finalB)),
      dispersion: Math.round((madR + madG + madB) / 3)
    };
  }

  /* ============================================================
     7. CHIẾU ĐA TẠP CIELAB ĐỂ ĐO pH CHÍNH XÁC CAO
     Đường biến đổi màu của giấy quỳ là một đa tạp 1D (Manifold)
     được tham số hóa bởi pH tăng dần từ 3.0 đến 9.0.
     Thuật toán chiếu điểm mẫu trực giao lên đoạn thẳng nối 2 màu
     chuẩn liền kề để nội suy giá trị pH thực tế liên tục.
     ============================================================ */
  function estimatePH(correctedRGB, options){
    options = options || {};
    const refColors  = options.refColors || DEFAULT_REF_COLORS;
    const illuminant = options.illuminant || 'D65';

    // 1. Chuyển RGB mẫu sang CIELAB & HSV
    const lab = rgb2lab(correctedRGB.r, correctedRGB.g, correctedRGB.b, illuminant);
    const hsv = rgb2hsv(correctedRGB.r, correctedRGB.g, correctedRGB.b);
    const normH = normalizeHue(hsv.h);

    // Chuẩn bị node tham chiếu có sẵn tọa độ Lab
    const refNodes = refColors.map(r => ({
      ph: r.ph,
      r: r.r,
      g: r.g,
      b: r.b,
      name: r.name,
      lab: r.lab || rgb2lab(r.r, r.g, r.b, illuminant),
      normH: normalizeHue(rgb2hsv(r.r, r.g, r.b).h)
    }));

    // 2. Tính khoảng cách CIEDE2000 tới tất cả các mốc
    const deltas = refNodes.map(r => ({
      ph: r.ph,
      dE: deltaE2000(lab, r.lab, { kL: 1.4, kC: 1.0, kH: 1.0 }),
      ref: r
    })).sort((a, b) => a.dE - b.dE);

    const bestMatch = deltas[0];
    const secondMatch = deltas[1];

    let estimatedPH = bestMatch.ph;
    let minManifoldDist = bestMatch.dE;

    // Nếu rất gần mốc chuẩn (dE < 0.25)
    if(bestMatch.dE < 0.25){
      estimatedPH = bestMatch.ph;
      minManifoldDist = bestMatch.dE;
    } else {
      // 3. Chiếu trực giao lên 2 đoạn lân cận [k-1, k] và [k, k+1]
      const bestIdx = refNodes.findIndex(r => r.ph === bestMatch.ph);
      const candidates = [];

      if(bestIdx > 0){
        candidates.push([refNodes[bestIdx - 1], refNodes[bestIdx]]);
      }
      if(bestIdx < refNodes.length - 1){
        candidates.push([refNodes[bestIdx], refNodes[bestIdx + 1]]);
      }

      let bestSegmentProj = null;
      let minSegmentDE = 999;

      for(let i = 0; i < candidates.length; i++){
        const A = candidates[i][0];
        const B = candidates[i][1];

        const vL = B.lab.L - A.lab.L;
        const va = B.lab.a - A.lab.a;
        const vb = B.lab.b - A.lab.b;
        const len2 = vL*vL + va*va + vb*vb;

        if(len2 > 0){
          const uL = lab.L - A.lab.L;
          const ua = lab.a - A.lab.a;
          const ub = lab.b - A.lab.b;

          let t = (uL*vL + ua*va + ub*vb) / len2;
          t = Math.max(0, Math.min(1, t));

          const Q = {
            L: A.lab.L + t * vL,
            a: A.lab.a + t * va,
            b: A.lab.b + t * vb
          };

          const dE = deltaE2000(lab, Q, { kL: 1.4, kC: 1.0, kH: 1.0 });
          if(dE < minSegmentDE){
            minSegmentDE = dE;
            bestSegmentProj = {
              ph: A.ph + t * (B.ph - A.ph),
              dE: dE,
              t: t
            };
          }
        }
      }

      if(bestSegmentProj){
        estimatedPH = bestSegmentProj.ph;
        minManifoldDist = bestSegmentProj.dE;
      }
    }

    // Giới hạn trong khoảng hợp lệ
    estimatedPH = Math.max(PH_MIN, Math.min(PH_MAX, estimatedPH));

    // 4. Đánh giá độ tin cậy đa yếu tố (0% - 99%)
    // - Yếu tố khoảng cách tới dải màu chuẩn
    const confDist = Math.max(0, Math.min(1, 1 - (minManifoldDist / 18)));
    // - Yếu tố độ tách biệt giữa các mốc
    const confSep = Math.max(0, Math.min(1, (secondMatch.dE - bestMatch.dE) / 10 + 0.35));
    // - Yếu tố độ bão hòa (giấy quỳ phản ứng có màu rõ ràng)
    const sat = hsv.s / 100;
    const confSat = Math.max(0.25, Math.min(1, sat * 1.25));
    // - Yếu tố độ sáng đầy đủ (L trong khoảng 30 - 90)
    let confLum = 1.0;
    if(lab.L < 30) confLum = Math.max(0.3, lab.L / 30);
    else if(lab.L > 92) confLum = Math.max(0.3, (100 - lab.L) / 8);

    let confidence = (0.55 * confDist + 0.20 * confSep + 0.15 * confSat + 0.10 * confLum) * 100;
    confidence = Math.max(10, Math.min(99, Math.round(confidence)));

    return {
      ph: Math.round(estimatedPH * 10) / 10,
      confidence: confidence,
      lab: lab,
      bestDE: Math.round(minManifoldDist * 10) / 10,
      refMatch: bestMatch,
      deltas: deltas.slice(0, 5),
      cct: Math.round(estimateCCT(correctedRGB.r, correctedRGB.g, correctedRGB.b)),
      hsv: hsv
    };
  }

  /* ============================================================
     8. PHÂN LOẠI pH (Đồng bộ với recommendations.json)
     ============================================================ */

  /**
   * Phân loại pH đất (5 nhóm hiển thị trên badge UI)
   */
  function classifyPH(ph){
    if(ph < 4.5)  return { status: 'Chua gắt',   cls: 'status-chua',     color: '#ef4444' };
    if(ph < 5.5)  return { status: 'Chua',       cls: 'status-chua',     color: '#f97316' };
    if(ph <= 6.5) return { status: 'Tối ưu',     cls: 'status-toiuu',    color: '#10b981' };
    if(ph <= 7.5) return { status: 'Hơi kiềm',   cls: 'status-kiem',     color: '#3b82f6' };
    return              { status: 'Kiềm',       cls: 'status-kiemmanh', color: '#8b5cf6' };
  }

  /**
   * Phân loại pH chi tiết — Khớp 100% key trong recommendations.json:
   * 'very-acid' | 'acid' | 'optimal' | 'slightly-alkaline' | 'alkaline'
   */
  function classifyPHDetailed(ph){
    if(ph < 4.5)  return 'very-acid';
    if(ph < 5.5)  return 'acid';
    if(ph <= 6.5) return 'optimal';
    if(ph <= 7.5) return 'slightly-alkaline';
    return 'alkaline';
  }

  /* ============================================================
     9. TIỆN ÍCH HỖ TRỢ
     ============================================================ */
  function describeCCT(cct){
    if(cct < 3200) return { label: 'Ấm (đèn vàng)',    quality: 'warning', hint: 'Nên dùng đèn LED trắng hoặc ánh sáng ban ngày' };
    if(cct < 5000) return { label: 'Trung tính',       quality: 'good',    hint: 'Ánh sáng tốt' };
    if(cct < 7200) return { label: 'Ban ngày (D65)',   quality: 'best',    hint: 'Ánh sáng lý tưởng' };
    if(cct < 9000) return { label: 'Trắng lạnh',       quality: 'good',    hint: 'Ánh sáng tốt' };
    return               { label: 'Rất lạnh',          quality: 'warning', hint: 'Nên kiểm tra lại góc chiếu đèn' };
  }

  function assessSampleQuality(rgb){
    const hsv = rgb2hsv(rgb.r, rgb.g, rgb.b);
    const issues = [];

    if(hsv.s < 16) issues.push('Màu nhạt — có thể chưa thấm đều dịch quỳ');
    if(hsv.v < 22) issues.push('Quá tối — bật thêm đèn LED buồng tối');
    if(hsv.v > 96 && hsv.s < 20) issues.push('Bị cháy sáng lóa');

    return {
      hsv: hsv,
      quality: issues.length === 0 ? 'good' : issues.length === 1 ? 'warning' : 'poor',
      issues: issues
    };
  }

  /* ============================================================
     XUẤT MODULE (UMD)
     ============================================================ */
  const ColorScience = {
    // Chuyển đổi
    rgb2hsv,
    rgb2hsl,
    rgb2xyz,
    xyz2lab,
    rgb2lab,
    srgbToLinear,
    linearToSrgb,
    normalizeHue,

    // So sánh màu
    deltaE2000,

    // Xử lý ảnh
    autoWhiteBalance,
    sampleColors,

    // Tiện ích
    estimateCCT,
    describeCCT,
    assessSampleQuality,
    isHighlight,
    isShadow,

    // Phân tích pH
    estimatePH,
    classifyPH,
    classifyPHDetailed,

    // Hằng số
    DEFAULT_REF_COLORS,
    PH_DETAILED_LABELS,
    PH_MIN,
    PH_MAX,
    WHITE_POINTS: { D65, D50, A }
  };

  if(typeof module !== 'undefined' && module.exports){
    module.exports = ColorScience;
  } else {
    global.ColorScience = ColorScience;
  }

})(typeof window !== 'undefined' ? window : globalThis);
