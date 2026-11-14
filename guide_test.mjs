// guide.mjs のテスト。実行: node guide_test.mjs
import assert from "node:assert/strict";
import { matrixToAngles, averageBrightness, decideGuide, isPointInPolygon, isToothLikePixel, measureTeeth, describeMouthPixels, listToothPixels, toothRuleFor, TOOTH_SETTINGS, frameScore, createCaptureTracker, THRESHOLDS, MESSAGES } from "./guide.mjs";

const rad = (deg) => (deg * Math.PI) / 180;

// 歯っぽい画素のテストで使うしきい値。guide.mjs の TOOTH_RULE を、あとで変えても、テストが壊れないように、ここで決める
const RULE = { brightnessMin: 120, saturationMax: 0.35 };

// 3x3 の行列の掛け算
function mul(A, B) {
  return A.map((_, i) => B[0].map((_, j) => A[i].reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
}
const Ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];

// 角度から、MediaPipe と同じ形(列の順の16個)の行列を作る
function makeData(yawDeg, pitchDeg, rollDeg) {
  const R = mul(mul(Ry(rad(yawDeg)), Rx(rad(pitchDeg))), Rz(rad(rollDeg)));
  const data = [];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) data.push(R[row][col]);
    data.push(0);
  }
  data.push(0, 0, -40, 1);   // 最後の列: 移動(角度には関係しない)
  return data;
}

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} が ${expected} に近くない`);
}

// 1. 正面(回転なし)は、全部 0 度
{
  const a = matrixToAngles(makeData(0, 0, 0));
  near(a.yaw, 0, 1e-6, "正面 yaw");
  near(a.pitch, 0, 1e-6, "正面 pitch");
  near(a.roll, 0, 1e-6, "正面 roll");
}

// 2. 1つの方向だけ回した時、その角度だけが出る
for (const deg of [-40, -20, 10, 30]) {
  near(matrixToAngles(makeData(deg, 0, 0)).yaw, deg, 1e-6, `yaw ${deg}`);
  near(matrixToAngles(makeData(0, deg, 0)).pitch, deg, 1e-6, `pitch ${deg}`);
  near(matrixToAngles(makeData(0, 0, deg)).roll, deg, 1e-6, `roll ${deg}`);
}

// 3. 3つ同時に回しても、それぞれが取り出せる
{
  const a = matrixToAngles(makeData(25, -15, 10));
  near(a.yaw, 25, 1e-6, "同時 yaw");
  near(a.pitch, -15, 1e-6, "同時 pitch");
  near(a.roll, 10, 1e-6, "同時 roll");
}

// 4. カメラで実際に出た行列(数字だけ。映像ではない)でも、動く
{
  const real = [0.956, -0.076, -0.283, 0, 0.021, 0.981, -0.192, 0, 0.292, 0.178, 0.94, 0, -6.701, -14.024, -41.773, 1];
  const a = matrixToAngles(real);
  near(a.yaw, 17.3, 0.1, "実測 yaw");
  near(a.pitch, -10.3, 0.1, "実測 pitch");
  near(a.roll, -4.4, 0.1, "実測 roll");
}

// 5. 丸め誤差で、-R(1,2) が 1 を少し超えても、NaN にならない
{
  const data = makeData(0, 90, 0);
  data[9] = -1.0000001;   // R(1,2) をわざと 1 より大きくする
  const a = matrixToAngles(data);
  assert.ok(Number.isFinite(a.pitch), "pitch が NaN になった");
}

// ---- averageBrightness(平均の明るさ) ----

// 6. 真っ黒は 0、真っ白は 255
near(averageBrightness([0, 0, 0, 255, 0, 0, 0, 255]), 0, 1e-9, "黒");
near(averageBrightness([255, 255, 255, 255, 255, 255, 255, 255]), 255, 1e-9, "白");

// 7. 黒と白が半分ずつなら、127.5
near(averageBrightness([0, 0, 0, 255, 255, 255, 255, 255]), 127.5, 1e-9, "半分ずつ");

// 8. 色による重みの違い(緑が一番明るく、青が一番暗く感じる)
near(averageBrightness([255, 0, 0, 255]), 76.245, 1e-6, "赤");
near(averageBrightness([0, 255, 0, 255]), 149.685, 1e-6, "緑");
near(averageBrightness([0, 0, 255, 255]), 29.07, 1e-6, "青");

// 9. 透明度(4つ目)は、明るさに関係しない
near(averageBrightness([100, 100, 100, 0]), averageBrightness([100, 100, 100, 255]), 1e-9, "透明度");

// 10. 画素が無い時は、0(NaN にならない)
assert.equal(averageBrightness([]), 0);

// ---- decideGuide(案内の判断) ----

// 全部OKの測定値(ここから1か所だけ変えて試す)
const GOOD = { faceFound: true, faceSize: 0.3, faceCenterX: 0.5, yaw: 0, brightness: 100, jawOpen: 0.8, teethRatio: 0.3 };
const guide = (change) => decideGuide({ ...GOOD, ...change });

// 11. 全部OKなら「そのまま!」で、チェックは全部OK
{
  const g = guide({});
  assert.equal(g.message, MESSAGES.ok);
  assert.equal(g.allOk, true);
  assert.deepEqual(g.checks.map((c) => c.key), ["size", "position", "angle", "brightness", "mouth", "teeth"]);
  assert.ok(g.checks.every((c) => c.ok));
}

// 12. 1か所だけダメなら、その案内が出る(チェックも、その1つだけがNG)
{
  const cases = [
    [{ faceSize: 0.1 }, MESSAGES.tooSmall, "size"],
    [{ faceSize: 0.6 }, MESSAGES.tooBig, "size"],
    [{ faceCenterX: 0.1 }, MESSAGES.moveLeft, "position"],
    [{ faceCenterX: 0.9 }, MESSAGES.moveRight, "position"],
    [{ yaw: 30 }, MESSAGES.turnFront, "angle"],
    [{ yaw: -30 }, MESSAGES.turnFront, "angle"],
    [{ brightness: 10 }, MESSAGES.tooDark, "brightness"],
    [{ jawOpen: 0.1 }, MESSAGES.openMouth, "mouth"],
    [{ teethRatio: 0.01 }, MESSAGES.showTeeth, "teeth"],
  ];
  for (const [change, message, key] of cases) {
    const g = guide(change);
    assert.equal(g.message, message, JSON.stringify(change));
    assert.equal(g.allOk, false);
    assert.deepEqual(g.checks.filter((c) => !c.ok).map((c) => c.key), [key], JSON.stringify(change));
  }
}

// 13. 境目: ちょうどの値の扱い(顔の大きさ・位置・向き・明るさ・口)
{
  const T = THRESHOLDS;
  assert.equal(guide({ faceSize: T.faceSizeMin }).allOk, true);
  assert.equal(guide({ faceSize: T.faceSizeMax }).allOk, true);
  assert.equal(guide({ faceSize: T.faceSizeMin - 0.001 }).message, MESSAGES.tooSmall);
  assert.equal(guide({ faceSize: T.faceSizeMax + 0.001 }).message, MESSAGES.tooBig);
  assert.equal(guide({ faceCenterX: T.faceCenterXMin }).allOk, true);
  assert.equal(guide({ faceCenterX: T.faceCenterXMax }).allOk, true);
  assert.equal(guide({ faceCenterX: T.faceCenterXMin - 0.001 }).message, MESSAGES.moveLeft);
  assert.equal(guide({ faceCenterX: T.faceCenterXMax + 0.001 }).message, MESSAGES.moveRight);
  assert.equal(guide({ yaw: T.yawMax }).allOk, true);          // 15度ちょうどは、正面(OK)
  assert.equal(guide({ yaw: -T.yawMax }).allOk, true);
  assert.equal(guide({ yaw: T.yawMax + 0.01 }).message, MESSAGES.turnFront);
  assert.equal(guide({ yaw: -T.yawMax - 0.01 }).message, MESSAGES.turnFront);
  assert.equal(guide({ brightness: T.brightnessMin }).allOk, true);
  assert.equal(guide({ brightness: T.brightnessMin - 0.01 }).message, MESSAGES.tooDark);
  assert.equal(guide({ jawOpen: T.jawOpenMin }).allOk, true);
  assert.equal(guide({ jawOpen: T.jawOpenMin - 0.001 }).message, MESSAGES.openMouth);
  assert.equal(guide({ teethRatio: T.teethRatioMin }).allOk, true);                     // 歯の割合がちょうどのしきい値は、OK
  assert.equal(guide({ teethRatio: T.teethRatioMin - 0.001 }).message, MESSAGES.showTeeth);
}

// 14. 優先順位: 複数ダメな時は、上の項目の案内が出る(全部のチェックはNGと分かる)
{
  const g = guide({ faceSize: 0.1, yaw: 40, brightness: 5, jawOpen: 0 });
  assert.equal(g.message, MESSAGES.tooSmall);                       // 大きさが最優先
  assert.deepEqual(g.checks.filter((c) => !c.ok).map((c) => c.key), ["size", "angle", "brightness", "mouth"]);
  assert.equal(guide({ yaw: 40, brightness: 5, jawOpen: 0 }).message, MESSAGES.turnFront);   // 向き > 明るさ > 口
  assert.equal(guide({ brightness: 5, jawOpen: 0 }).message, MESSAGES.tooDark);              // 明るさ > 口
  assert.equal(guide({ jawOpen: 0, teethRatio: 0 }).message, MESSAGES.openMouth);            // 口 > 歯(口が閉じていたら、先に口を開けてもらう)
}

// 15. 顔が見つからない時は「顔を映してください」。チェックは全部NG
{
  const g = decideGuide({ faceFound: false });
  assert.equal(g.message, MESSAGES.noFace);
  assert.equal(g.allOk, false);
  assert.equal(g.checks.length, 6);
  assert.ok(g.checks.every((c) => c.ok === false));
}

// 16. 数字が NaN や undefined の時は、OKにしない(安全側)
{
  assert.equal(guide({ faceSize: NaN }).allOk, false);
  assert.equal(guide({ faceCenterX: undefined }).allOk, false);
  assert.equal(guide({ yaw: NaN }).allOk, false);
  assert.equal(guide({ brightness: NaN }).allOk, false);
  assert.equal(guide({ jawOpen: undefined }).allOk, false);
  assert.equal(guide({ teethRatio: NaN }).allOk, false);
  assert.equal(guide({ teethRatio: undefined }).allOk, false);
}

// 17. しきい値と文は、差し替えられる(言葉やしきい値を変えても、仕組みは同じ)
{
  const g = decideGuide({ ...GOOD, yaw: 20 }, { ...THRESHOLDS, yawMax: 25 }, MESSAGES);
  assert.equal(g.allOk, true);
  const g2 = decideGuide({ ...GOOD, brightness: 1 }, THRESHOLDS, { ...MESSAGES, tooDark: "もっと明るく" });
  assert.equal(g2.message, "もっと明るく");
}

// ---- isPointInPolygon(点が多角形の内側か) ----

const poly = (...pairs) => pairs.map(([x, y]) => ({ x, y }));

// 18. 四角形: 中は true、外(上下左右)は false
{
  const square = poly([0, 0], [10, 0], [10, 10], [0, 10]);
  assert.equal(isPointInPolygon(5, 5, square), true);
  assert.equal(isPointInPolygon(1, 1, square), true);
  assert.equal(isPointInPolygon(9, 9, square), true);
  for (const [x, y] of [[15, 5], [-1, 5], [5, -1], [5, 11], [-5, -5], [20, 20]]) {
    assert.equal(isPointInPolygon(x, y, square), false, `(${x}, ${y})`);
  }
}

// 19. 三角形
{
  const tri = poly([0, 0], [10, 0], [5, 10]);
  assert.equal(isPointInPolygon(5, 3, tri), true);
  assert.equal(isPointInPolygon(1, 8, tri), false);
  assert.equal(isPointInPolygon(9, 8, tri), false);
}

// 20. へこみのある形(L字)。へこみの中は、外側
{
  const L = poly([0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]);
  assert.equal(isPointInPolygon(2, 2, L), true);
  assert.equal(isPointInPolygon(2, 8, L), true);
  assert.equal(isPointInPolygon(8, 2, L), true);
  assert.equal(isPointInPolygon(8, 8, L), false);      // へこみの中
  assert.equal(isPointInPolygon(6, 6, L), false);
}

// 21. 辺をたどる向きを逆にしても、同じ結果
{
  const L = poly([0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]);
  const reversed = [...L].reverse();
  for (const [x, y] of [[2, 2], [2, 8], [8, 2], [8, 8], [6, 6], [-1, 3], [12, 3]]) {
    assert.equal(isPointInPolygon(x, y, reversed), isPointInPolygon(x, y, L), `(${x}, ${y})`);
  }
}

// 22. 点の高さが、頂点の高さとぴったり同じでも、正しく数える(ひし形の中心)
{
  const diamond = poly([5, 0], [10, 5], [5, 10], [0, 5]);
  assert.equal(isPointInPolygon(5, 5, diamond), true);
  assert.equal(isPointInPolygon(12, 5, diamond), false);
  assert.equal(isPointInPolygon(-2, 5, diamond), false);
  assert.equal(isPointInPolygon(9, 5, diamond), true);
}

// 23. 点が3つ未満は、多角形にならない(いつも false)
{
  assert.equal(isPointInPolygon(1, 1, []), false);
  assert.equal(isPointInPolygon(1, 1, poly([0, 0])), false);
  assert.equal(isPointInPolygon(1, 1, poly([0, 0], [2, 2])), false);
}

// 24. 口の内側のような、細長い20角形(INNER_LIP と同じ点の数)
{
  const mouth = Array.from({ length: 20 }, (_, i) => {
    const a = (2 * Math.PI * i) / 20;
    return { x: 100 + 40 * Math.cos(a), y: 200 + 10 * Math.sin(a) };
  });
  assert.equal(isPointInPolygon(100, 200, mouth), true);       // 中心
  assert.equal(isPointInPolygon(75, 200, mouth), true);        // 横に細長い、左寄り
  assert.equal(isPointInPolygon(100, 220, mouth), false);      // 上下は、すぐ外
  assert.equal(isPointInPolygon(150, 200, mouth), false);      // 左右の外
}

// 25. たくさんの点で確かめる: 正20角形(半径 10)。確実に中なら true、確実に外なら false
{
  const R = 10;
  const circle = Array.from({ length: 20 }, (_, i) => {
    const a = (2 * Math.PI * i) / 20;
    return { x: R * Math.cos(a), y: R * Math.sin(a) };
  });
  const sureInside = R * Math.cos(Math.PI / 20) - 0.001;      // 辺までの一番近い距離より、少し内側
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  let checkedIn = 0, checkedOut = 0;
  for (let k = 0; k < 4000; k++) {
    const x = (rand() - 0.5) * 30;
    const y = (rand() - 0.5) * 30;
    const d = Math.hypot(x, y);
    if (d <= sureInside) { assert.equal(isPointInPolygon(x, y, circle), true, `中 (${x}, ${y})`); checkedIn++; }
    else if (d >= R + 0.001) { assert.equal(isPointInPolygon(x, y, circle), false, `外 (${x}, ${y})`); checkedOut++; }
  }
  assert.ok(checkedIn > 300 && checkedOut > 1000, `確かめた数: 中 ${checkedIn}、外 ${checkedOut}`);
}

// ---- isToothLikePixel(歯っぽい画素か) ----

// 26. 歯っぽい色(白、少しクリーム色、少し影になった歯)
assert.equal(isToothLikePixel(255, 255, 255, RULE), true);     // 白
assert.equal(isToothLikePixel(235, 225, 200, RULE), true);     // 少しクリーム色
assert.equal(isToothLikePixel(150, 145, 135, RULE), true);     // 影で少し暗い

// 27. 歯ではない色(唇、舌、口の奥、皮膚に近い色、暗い灰色)
assert.equal(isToothLikePixel(180, 70, 80, RULE), false);      // 赤い唇
assert.equal(isToothLikePixel(200, 100, 100, RULE), false);    // 舌
assert.equal(isToothLikePixel(40, 20, 20, RULE), false);       // 口の奥(暗い)
assert.equal(isToothLikePixel(60, 60, 60, RULE), false);       // 暗い灰色(色は薄いが暗い)
assert.equal(isToothLikePixel(0, 0, 0, RULE), false);          // 真っ黒(NaN にならない)
assert.equal(isToothLikePixel(210, 140, 110, RULE), false);    // 濃い肌色

// 28. 境目: ちょうどの値は、歯っぽい(以上・以下)
{
  const rule = { brightnessMin: 100, saturationMax: 0.5 };
  assert.equal(isToothLikePixel(100, 100, 100, rule), true);      // 明るさがちょうど 100
  assert.equal(isToothLikePixel(99, 99, 99, rule), false);        // 少し暗い
  assert.equal(isToothLikePixel(200, 100, 100, rule), true);      // 色の濃さがちょうど 0.5
  assert.equal(isToothLikePixel(200, 99, 99, rule), false);       // 少し濃い(約 0.505)
}

// 28b. 真っ黒の「色の濃さ」は 0(0 ÷ 0 で NaN にならない)。明るさのしきい値が 0 なら、歯っぽい
assert.equal(isToothLikePixel(0, 0, 0, { brightnessMin: 0, saturationMax: 0.35 }), true);

// 28c. 明るさは、緑を重く、青を軽く数える(色が濃い画素で、単純平均と差が出る)
{
  const loose = { brightnessMin: 100, saturationMax: 1 };      // 色の濃さは、気にしない設定
  assert.equal(isToothLikePixel(0, 255, 0, loose), true);      // 緑: 重み付き 約150、単純平均 85
  assert.equal(isToothLikePixel(0, 0, 255, { brightnessMin: 50, saturationMax: 1 }), false);   // 青: 重み付き 約29、単純平均 85
  assert.equal(isToothLikePixel(255, 0, 0, { brightnessMin: 80, saturationMax: 1 }), false);   // 赤: 重み付き 約76、単純平均 85
}

// 29. しきい値は差し替えられる(厳しくすると、歯っぽくなくなる)
assert.equal(isToothLikePixel(150, 145, 135, { brightnessMin: 200, saturationMax: 0.35 }), false);
assert.equal(isToothLikePixel(235, 225, 200, { brightnessMin: 120, saturationMax: 0.05 }), false);

// ---- measureTeeth(歯の割合) ----

// 合成の画像を作る(幅 w、高さ h。色は、関数 colorAt(x, y) で決める)
function makeImage(w, h, colorAt) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return data;
}
const WHITE = [255, 255, 255];
const RED = [180, 70, 80];
const square = [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }];   // 40 × 40 = 1600画素

// 30. 全部白なら 1、全部赤なら 0。中の画素の数は、1600
{
  const white = makeImage(100, 100, () => WHITE);
  const r1 = measureTeeth(white, 100, 100, square, RULE);
  assert.deepEqual(r1, { ratio: 1, insidePixels: 1600, toothPixels: 1600 });
  const red = makeImage(100, 100, () => RED);
  const r2 = measureTeeth(red, 100, 100, square, RULE);
  assert.deepEqual(r2, { ratio: 0, insidePixels: 1600, toothPixels: 0 });
}

// 31. 左半分が白、右半分が赤なら、ちょうど 0.5(x と y の取り違えも見つかる)
{
  const half = makeImage(100, 100, (x) => (x < 40 ? WHITE : RED));
  assert.equal(measureTeeth(half, 100, 100, square, RULE).ratio, 0.5);
  const top = makeImage(100, 100, (x, y) => (y < 30 ? WHITE : RED));         // 上の10行(20〜29)だけ白
  const rt = measureTeeth(top, 100, 100, square, RULE);
  assert.equal(rt.toothPixels, 10 * 40);
  assert.equal(rt.ratio, 0.25);
}

// 32. 多角形の「外」の画素は、数えない(外が白、中が赤なら、割合は 0)
{
  const ring = makeImage(100, 100, (x, y) => (x >= 20 && x < 60 && y >= 20 && y < 60 ? RED : WHITE));
  assert.equal(measureTeeth(ring, 100, 100, square, RULE).ratio, 0);
  assert.equal(measureTeeth(ring, 100, 100, square, RULE).insidePixels, 1600);
}

// 33. 画像の外にはみ出す多角形でも、止まらず、中にある分だけ数える(幅 100 の画像で、x が 80〜120)
{
  const white = makeImage(100, 100, () => WHITE);
  const wide = [{ x: 80, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 60 }, { x: 80, y: 60 }];
  const r = measureTeeth(white, 100, 100, wide, RULE);
  assert.equal(r.insidePixels, 20 * 40);            // x = 80〜99 の 20列 × 40行
  assert.equal(r.ratio, 1);
  const outside = [{ x: 200, y: 200 }, { x: 220, y: 200 }, { x: 220, y: 220 }, { x: 200, y: 220 }];
  assert.deepEqual(measureTeeth(white, 100, 100, outside, RULE), { ratio: 0, insidePixels: 0, toothPixels: 0 });
}

// 34. ひし形: 中の画素の数は、面積(対角線 40 と 40 → 800)に近い
{
  const white = makeImage(100, 100, () => WHITE);
  const diamond = [{ x: 40, y: 20 }, { x: 60, y: 40 }, { x: 40, y: 60 }, { x: 20, y: 40 }];
  const r = measureTeeth(white, 100, 100, diamond, RULE);
  assert.ok(Math.abs(r.insidePixels - 800) <= 40, `画素の数 ${r.insidePixels}`);
}

// 34b. 斜めの辺: 画素の「中心」で数える。直角三角形(辺 39.9)の中の画素は、x + y が 38 以下 → 780画素
//      (角で数えると 820 になる。どの画素の中心も、斜めの辺の上にはぴったり乗らない)
{
  const white = makeImage(100, 100, () => WHITE);
  const tri = [{ x: 0, y: 0 }, { x: 39.9, y: 0 }, { x: 0, y: 39.9 }];
  assert.equal(measureTeeth(white, 100, 100, tri, RULE).insidePixels, 780);
}

// 34c. 下・左・上にはみ出しても、画像の中にある分だけ数える
{
  const white = makeImage(100, 100, () => WHITE);
  const bottom = [{ x: 20, y: 80 }, { x: 60, y: 80 }, { x: 60, y: 120 }, { x: 20, y: 120 }];
  assert.equal(measureTeeth(white, 100, 100, bottom, RULE).insidePixels, 40 * 20);    // y = 80〜99
  const left = [{ x: -20, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 60 }, { x: -20, y: 60 }];
  assert.equal(measureTeeth(white, 100, 100, left, RULE).insidePixels, 20 * 40);      // x = 0〜19
  const top = [{ x: 20, y: -20 }, { x: 60, y: -20 }, { x: 60, y: 20 }, { x: 20, y: 20 }];
  assert.equal(measureTeeth(white, 100, 100, top, RULE).insidePixels, 40 * 20);       // y = 0〜19
}

// 35. 多角形にならない(点が3つ未満)なら、0 を返す
{
  const white = makeImage(10, 10, () => WHITE);
  assert.deepEqual(measureTeeth(white, 10, 10, [], RULE), { ratio: 0, insidePixels: 0, toothPixels: 0 });
  assert.deepEqual(measureTeeth(white, 10, 10, [{ x: 1, y: 1 }, { x: 5, y: 5 }], RULE), { ratio: 0, insidePixels: 0, toothPixels: 0 });
}

// 36. しきい値(rule)を渡すと、それで判定する(厳しくすると、歯っぽい画素が減る)
{
  const cream = makeImage(100, 100, () => [235, 225, 200]);
  assert.equal(measureTeeth(cream, 100, 100, square, RULE).ratio, 1);
  assert.equal(measureTeeth(cream, 100, 100, square, { brightnessMin: 120, saturationMax: 0.05 }).ratio, 0);
}

// 37. 口の内側のような、細長い20角形(INNER_LIP と同じ点の数)で、真ん中の帯だけ白
{
  const mouth = Array.from({ length: 20 }, (_, i) => {
    const a = (2 * Math.PI * i) / 20;
    return { x: 100 + 40 * Math.cos(a), y: 100 + 12 * Math.sin(a) };
  });
  const striped = makeImage(200, 200, (x, y) => (y >= 95 && y < 105 ? WHITE : RED));    // y = 95〜104 が白
  const r = measureTeeth(striped, 200, 200, mouth, RULE);
  assert.ok(r.insidePixels > 1400 && r.insidePixels < 1600, `画素の数 ${r.insidePixels}`);   // 楕円の面積 π×40×12 ≒ 1508
  // 白い帯(中心から上下に 5 まで)が、楕円(縦の半径 12)の面積に占める割合は、計算で約 0.515
  assert.ok(r.ratio > 0.47 && r.ratio < 0.56, `割合 ${r.ratio}`);
}

// ---- describeMouthPixels(中身の数字。しきい値を決めるために使う) ----

// 38. 全部白: 平均の明るさ 255、色の濃さ 0、条件は全部満たす
{
  const white = makeImage(100, 100, () => WHITE);
  const d = describeMouthPixels(white, 100, 100, square, RULE);
  assert.equal(d.insidePixels, 1600);
  assert.ok(Math.abs(d.meanBrightness - 255) < 1e-9);
  assert.ok(Math.abs(d.meanSaturation - 0) < 1e-9);
  assert.deepEqual([d.brightRatio, d.paleRatio, d.toothRatio], [1, 1, 1]);
}

// 39. 赤い唇の色: 明るさの条件も、色の薄さの条件も、満たさない
{
  const red = makeImage(100, 100, () => RED);                   // 明るさ 約104、色の濃さ 約0.61
  const d = describeMouthPixels(red, 100, 100, square, RULE);
  assert.ok(Math.abs(d.meanBrightness - 104.03) < 0.01, `明るさ ${d.meanBrightness}`);
  assert.ok(Math.abs(d.meanSaturation - (180 - 70) / 180) < 1e-9, `濃さ ${d.meanSaturation}`);
  assert.deepEqual([d.brightRatio, d.paleRatio, d.toothRatio], [0, 0, 0]);
}

// 40. 黄みがかった歯(230, 210, 140): 明るいが、色が濃めで、歯と判定されない  ← しきい値が合わない例
{
  const warm = makeImage(100, 100, () => [230, 210, 140]);       // 明るさ 約209、色の濃さ 約0.39
  const d = describeMouthPixels(warm, 100, 100, square, RULE);
  assert.equal(d.brightRatio, 1);          // 明るさの条件は満たす
  assert.equal(d.paleRatio, 0);            // 色が薄い条件を満たさない
  assert.equal(d.toothRatio, 0);           // だから、歯っぽくない(割合 0)
  // 色の濃さのしきい値を 0.45 に緩めると、歯と判定される
  const d2 = describeMouthPixels(warm, 100, 100, square, { brightnessMin: 120, saturationMax: 0.45 });
  assert.equal(d2.toothRatio, 1);
}

// 41. 左半分が白、右半分が赤: 割合が、それぞれの条件ごとに出る。toothRatio は measureTeeth の ratio と同じ
{
  const half = makeImage(100, 100, (x) => (x < 40 ? WHITE : RED));
  const d = describeMouthPixels(half, 100, 100, square, RULE);
  assert.equal(d.brightRatio, 0.5);
  assert.equal(d.paleRatio, 0.5);
  assert.equal(d.toothRatio, measureTeeth(half, 100, 100, square, RULE).ratio);
  assert.ok(Math.abs(d.meanBrightness - (255 + 104.03) / 2) < 0.01);
}

// 42. 明るいだけ・薄いだけ、の画素が混ざっている時、brightRatio と paleRatio が、別々の値になる
{
  // 左の半分: 明るくて色が濃い(230, 210, 140)。右の半分: 暗くて色が薄い(60, 60, 60)
  const mixed = makeImage(100, 100, (x) => (x < 40 ? [230, 210, 140] : [60, 60, 60]));
  const d = describeMouthPixels(mixed, 100, 100, square, RULE);
  assert.equal(d.brightRatio, 0.5);
  assert.equal(d.paleRatio, 0.5);
  assert.equal(d.toothRatio, 0);            // 両方を満たす画素は、1つも無い
  const brightOnly = makeImage(100, 100, (x) => (x < 40 ? [230, 210, 140] : WHITE));   // 全部明るい。左だけ色が濃い
  const d2 = describeMouthPixels(brightOnly, 100, 100, square, RULE);
  assert.equal(d2.brightRatio, 1);
  assert.equal(d2.paleRatio, 0.5);
}

// 43. 多角形にならない時・画像の外の時は、全部 0
{
  const white = makeImage(10, 10, () => WHITE);
  const zero = {
    insidePixels: 0, meanBrightness: 0, meanSaturation: 0,
    brightRatio: 0, paleRatio: 0, toothRatio: 0, topBrightness: 0, topSaturation: 0,
    brightnessP50: 0, brightnessP90: 0, brightnessP97: 0, brightnessMax: 0,
  };
  assert.deepEqual(describeMouthPixels(white, 10, 10, [], RULE), zero);
  assert.deepEqual(describeMouthPixels(white, 10, 10, [{ x: 100, y: 100 }, { x: 120, y: 100 }, { x: 120, y: 120 }], RULE), zero);
}

// ---- describeMouthPixels の「明るい方の上位10%」 ----
// 40 × 40 の四角(square)の中は 1600画素。上位10% = 160画素

const DARK = [40, 20, 20];                 // 口の奥。明るさ 約25.98
const CREAM = [230, 210, 140];             // 黄みがかった歯。明るさ 約208.0、色の濃さ 約0.391
const nearly = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} が ${expected} に近くない`);

// 44. 全部白なら、上位10%も 255 / 0
{
  const d = describeMouthPixels(makeImage(100, 100, () => WHITE), 100, 100, square, RULE);
  nearly(d.topBrightness, 255, 1e-9, "白の上位");
  nearly(d.topSaturation, 0, 1e-9, "白の濃さ");
}

// 45. 口の奥(暗い)の中に、歯の帯が10%以上ある: 平均は暗いが、上位10%は、歯の色になる
{
  // 左の 4 列(x = 20〜23)が歯の色 → 4 × 40 = 160画素(ちょうど10%)。残りは暗い
  const img = makeImage(100, 100, (x) => (x < 24 ? CREAM : DARK));
  const d = describeMouthPixels(img, 100, 100, square, RULE);
  assert.ok(d.meanBrightness < 60, `平均 ${d.meanBrightness}`);       // 平均は、暗い(約 44)
  nearly(d.topBrightness, 208.0, 0.1, "歯の帯の上位");
  nearly(d.topSaturation, (230 - 140) / 230, 1e-9, "歯の帯の濃さ");
}

// 46. 歯の帯が10%より少ない(100画素 = 6.25%): 上位10%(160画素)には、暗い画素が混ざる
{
  // 左の 2.5 列分は割り切れないので、行で作る: y = 20〜21(2行 × 40 = 80)と、y = 22 の最初の 20列(20)→ 100画素
  const img = makeImage(100, 100, (x, y) => ((y < 22 || (y === 22 && x < 40)) ? CREAM : DARK));
  const d = describeMouthPixels(img, 100, 100, square, RULE);
  const expected = (100 * 208.0 + 60 * 25.98) / 160;                  // 約 140.3
  nearly(d.topBrightness, expected, 0.2, "混ざった上位");
}

// 47. 並び方が逆(暗い順)になっていない: 暗い画素が多数でも、上位は明るい方
{
  const img = makeImage(100, 100, (x, y) => (x === 20 && y === 20 ? WHITE : DARK));     // 白は、1画素だけ
  const d = describeMouthPixels(img, 100, 100, square, RULE);
  const expected = (255 + 159 * 25.98) / 160;                          // 上位 160画素 = 白1 + 暗い159
  nearly(d.topBrightness, expected, 0.2, "白が1画素だけ");
}

// 48. 中の画素が 1つだけ: 上位は、その1画素(少なくとも1画素は使う)
{
  const img = makeImage(30, 30, () => CREAM);
  const oneCell = [{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 10.5, y: 11 }];   // 画素 (10, 10) の中心だけを含む三角形
  const d = describeMouthPixels(img, 30, 30, oneCell, RULE);
  assert.equal(d.insidePixels, 1);
  nearly(d.topBrightness, 208.0, 0.1, "1画素");
  nearly(d.topSaturation, (230 - 140) / 230, 1e-9, "1画素の濃さ");
}

// ---- describeMouthPixels の明るさの分布(P50、P90、P97、最大) ----

// 49. 4つの明るさが、決まった数だけ混ざった絵(四角の 1600画素を、上から順に塗り分ける)
//     白 100画素(0〜99番目)、歯の色 160画素(100〜259)、中くらい 700画素(260〜959)、暗い 640画素(960〜1599)
{
  const MID = [120, 100, 100];                    // 明るさ 約106
  const bands = makeImage(100, 100, (x, y) => {
    if (x < 20 || x >= 60 || y < 20 || y >= 60) return DARK;      // 四角の外(数えない)
    const idx = (y - 20) * 40 + (x - 20);                         // 四角の中の通し番号(0〜1599)
    if (idx < 100) return WHITE;
    if (idx < 260) return CREAM;
    if (idx < 960) return MID;
    return DARK;
  });
  const d = describeMouthPixels(bands, 100, 100, square, RULE);
  assert.equal(d.insidePixels, 1600);
  nearly(d.brightnessMax, 255, 1e-9, "最大");                      // 一番明るいのは、白
  nearly(d.brightnessP97, 255, 1e-9, "P97");                       // 上から3% = 48番目 → 白(0〜99番目)
  nearly(d.brightnessP90, 208.0, 0.1, "P90");                      // 上から10% = 160番目 → 歯の色
  nearly(d.brightnessP50, 0.299 * 120 + 0.587 * 100 + 0.114 * 100, 1e-9, "P50");   // 上から50% = 800番目 → 中くらい
}

// 50. 全部同じ色なら、P50、P90、P97、最大は、全部同じ値
{
  const d = describeMouthPixels(makeImage(100, 100, () => CREAM), 100, 100, square, RULE);
  for (const v of [d.brightnessP50, d.brightnessP90, d.brightnessP97, d.brightnessMax]) nearly(v, 208.0, 0.1, "全部同じ");
}

// 51. 画素が1つだけでも、止まらない(範囲の外を読まない)
{
  const img = makeImage(30, 30, () => CREAM);
  const oneCell = [{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 10.5, y: 11 }];
  const d = describeMouthPixels(img, 30, 30, oneCell, RULE);
  assert.equal(d.insidePixels, 1);
  for (const v of [d.brightnessP50, d.brightnessP90, d.brightnessP97, d.brightnessMax]) nearly(v, 208.0, 0.1, "1画素");
}

// ---- toothRuleFor(顔の明るさとの差で決める rule) ----

// 52. 明るさのしきい値は、顔の明るさ + 差。色の濃さは、そのまま
{
  const settings = { brightnessDiffMin: 10, saturationMax: 0.45 };
  assert.deepEqual(toothRuleFor(64, settings), { brightnessMin: 74, saturationMax: 0.45 });
  assert.deepEqual(toothRuleFor(0, settings), { brightnessMin: 10, saturationMax: 0.45 });
  assert.deepEqual(toothRuleFor(100, { brightnessDiffMin: 25, saturationMax: 0.3 }), { brightnessMin: 125, saturationMax: 0.3 });
}

// 53. 設定を渡さなければ、TOOTH_SETTINGS を使う
{
  const rule = toothRuleFor(50);
  assert.equal(rule.brightnessMin, 50 + TOOTH_SETTINGS.brightnessDiffMin);
  assert.equal(rule.saturationMax, TOOTH_SETTINGS.saturationMax);
}

// 54. 同じ画素でも、顔が暗ければ歯っぽく、顔が明るければ歯っぽくない(顔との差で決まる)
{
  const settings = { brightnessDiffMin: 10, saturationMax: 0.45 };
  const gray80 = [80, 80, 80];                                                  // 明るさ 80、色の濃さ 0
  assert.equal(isToothLikePixel(...gray80, toothRuleFor(64, settings)), true);  // 顔 64 → 74 以上が必要 → 歯っぽい
  assert.equal(isToothLikePixel(...gray80, toothRuleFor(75, settings)), false); // 顔 75 → 85 以上が必要 → 歯っぽくない
  assert.equal(isToothLikePixel(...gray80, toothRuleFor(70, settings)), true);  // 顔 70 → 80 以上が必要 → ちょうど(以上)
}

// 55. 顔の明るさが変わると、同じ絵の「歯の割合」も変わる(顔が暗いほど、歯と判定されやすい)
{
  const settings = { brightnessDiffMin: 10, saturationMax: 0.45 };
  const img = makeImage(100, 100, (x) => (x < 40 ? [90, 90, 90] : [40, 40, 40]));   // 左半分: 明るさ 90。右半分: 40
  assert.equal(measureTeeth(img, 100, 100, square, toothRuleFor(60, settings)).ratio, 0.5);    // 顔 60 → 70 以上: 左半分が歯っぽい
  assert.equal(measureTeeth(img, 100, 100, square, toothRuleFor(85, settings)).ratio, 0);      // 顔 85 → 95 以上: どれも歯っぽくない
}

// ---- listToothPixels(歯っぽい画素の場所) ----

// 56. 四角の中の、横 10 × 縦 5 だけが白(縦横が違う): その50画素の位置が、返る
{
  const img = makeImage(100, 100, (x, y) => (x >= 20 && x < 30 && y >= 30 && y < 35 ? WHITE : RED));
  const list = listToothPixels(img, 100, 100, square, RULE);
  assert.equal(list.length, 50);
  assert.ok(list.every((p) => p.x >= 20 && p.x < 30 && p.y >= 30 && p.y < 35), "位置が、白い所の中にある");
  assert.deepEqual(list[0], { x: 20, y: 30 });                    // 最初は、左上(上の行から、左から右へ)
  assert.deepEqual(list[49], { x: 29, y: 34 });                   // 最後は、右下
  assert.equal(new Set(list.map((p) => `${p.x},${p.y}`)).size, 50);    // 同じ位置が、2回出ない
}

// 57. measureTeeth の歯っぽい画素数と、同じ数になる
{
  const img = makeImage(100, 100, (x) => (x < 37 ? WHITE : RED));
  assert.equal(listToothPixels(img, 100, 100, square, RULE).length, measureTeeth(img, 100, 100, square, RULE).toothPixels);
}

// 58. 多角形の外の白い画素は、返らない。歯っぽい画素が無ければ、空
{
  const ring = makeImage(100, 100, (x, y) => (x >= 20 && x < 60 && y >= 20 && y < 60 ? RED : WHITE));
  assert.deepEqual(listToothPixels(ring, 100, 100, square, RULE), []);
  assert.deepEqual(listToothPixels(makeImage(10, 10, () => WHITE), 10, 10, [], RULE), []);
}

// 59. しきい値(rule)で、返る画素が変わる
{
  const cream = makeImage(100, 100, () => CREAM);
  assert.equal(listToothPixels(cream, 100, 100, square, RULE).length, 0);                    // 色の濃さ 0.39 > 0.35 → 歯っぽくない
  assert.equal(listToothPixels(cream, 100, 100, square, { brightnessMin: 120, saturationMax: 0.45 }).length, 1600);
}

// ---- frameScore(1コマの点数) ----

// 60. 点数は、歯っぽい画素数(多いほど良い)。動きは、省略できる
assert.equal(frameScore({ toothPixels: 164 }), 164);
assert.equal(frameScore({ toothPixels: 0 }), 0);
assert.equal(frameScore({ toothPixels: 164, motion: 5 }), 164);                       // 既定では、動きは、使わない

// 61. 動きの減点を使う設定: 動きが大きいほど、点数が下がる
{
  const settings = { motionPenalty: 2 };
  assert.equal(frameScore({ toothPixels: 100, motion: 10 }, settings), 80);
  assert.equal(frameScore({ toothPixels: 100 }, settings), 100);                       // 動きが無ければ、減点なし
  assert.ok(frameScore({ toothPixels: 100, motion: 1 }, settings) > frameScore({ toothPixels: 100, motion: 9 }, settings));
}

// ---- createCaptureTracker(1秒の間で、一番良いコマを見つける) ----
// 以下の update(時刻ミリ秒, 全部OKか, 点数) の列で、動きを確かめる

// 62. 全部OKでない間は、待ち。何も起きない
{
  const t = createCaptureTracker();
  for (const ms of [0, 100, 500]) {
    const r = t.update(ms, false, 999);
    assert.deepEqual([r.state, r.isNewBest, r.done, r.discarded, r.progress], ["waiting", false, false, false, 0]);
  }
}

// 63. 全部OKになった最初のコマが、「一番良い」(とっておく画像を、必ず持つため)。進み具合は 0
{
  const t = createCaptureTracker();
  const r = t.update(1000, true, 5);
  assert.deepEqual([r.state, r.isNewBest, r.done, r.progress, r.bestScore], ["holding", true, false, 0, 5]);
}

// 64. 一番良いコマを見つける: 点数 10、30、20、25 の順 → 10 と 30 だけが「新しい一番」。最後に 1秒で撮れる。
{
  const t = createCaptureTracker();
  const seq = [[0, 10], [300, 30], [600, 20], [900, 25], [1000, 5]];
  const results = seq.map(([ms, score]) => t.update(ms, true, score));
  assert.deepEqual(results.map((r) => r.isNewBest), [true, true, false, false, false]);
  assert.deepEqual(results.map((r) => r.done), [false, false, false, false, true]);
  assert.equal(results[4].bestScore, 30);
  assert.equal(results[4].state, "captured");
}

// 65. 進み具合: 経過時間 ÷ 1000。1 を超えない
{
  const t = createCaptureTracker();
  t.update(0, true, 1);
  assert.equal(t.update(250, true, 1).progress, 0.25);
  assert.equal(t.update(500, true, 1).progress, 0.5);
  assert.equal(t.update(999, true, 1).progress, 0.999);
  const last = t.update(1500, true, 1);                    // 1秒を過ぎてから届いたコマ
  assert.equal(last.progress, 1);
  assert.equal(last.done, true);
}

// 66. ちょうど 1000ミリ秒で撮る。999ミリ秒では、まだ
{
  const a = createCaptureTracker();
  a.update(0, true, 1);
  assert.equal(a.update(999, true, 1).done, false);
  assert.equal(a.update(1000, true, 1).done, true);
}

// 67. 最後のコマが、一番良い時: 同じ update で、isNewBest と done が、両方 true(画像をとっておいてから、保存する)
{
  const t = createCaptureTracker();
  t.update(0, true, 10);
  t.update(500, true, 20);
  const r = t.update(1000, true, 99);
  assert.deepEqual([r.isNewBest, r.done, r.bestScore], [true, true, 99]);
}

// 68. 途中で崩れたら、捨てて、待ちに戻る。次の保持は、最初から(前の一番良い点数を、引きずらない)
{
  const t = createCaptureTracker();
  t.update(0, true, 100);
  t.update(400, true, 200);
  const broken = t.update(600, false, 300);
  assert.deepEqual([broken.state, broken.discarded, broken.isNewBest, broken.done], ["waiting", true, false, false]);
  const again = t.update(700, true, 5);                    // 新しい保持。点数 5 は、前の 200 より低いが、最初のコマなので「一番」
  assert.deepEqual([again.state, again.isNewBest, again.progress, again.bestScore], ["holding", true, 0, 5]);
  const next = t.update(1100, true, 6);                    // 経過 400ミリ秒。1秒に届いていない(前の保持の時間は、引きずらない)
  assert.deepEqual([next.done, next.progress, next.isNewBest], [false, 0.4, true]);
}

// 69. 待ちのときに、崩れた通知(全部OKでない)が来ても、捨てたことにならない
{
  const t = createCaptureTracker();
  assert.equal(t.update(0, false, 1).discarded, false);
}

// 70. 撮れたあとは、reset() するまで、続けて撮らない
{
  const t = createCaptureTracker();
  t.update(0, true, 1);
  t.update(1000, true, 1);
  assert.equal(t.state, "captured");
  const after = t.update(1100, true, 9999);
  assert.deepEqual([after.state, after.isNewBest, after.done], ["captured", false, false]);
  assert.equal(after.progress, 1);                                // 撮れたあとの進み具合は、1(満タン)のまま
  assert.equal(after.elapsedMs, 1100);
  assert.equal(t.update(1200, false, 0).discarded, false);       // 崩れても、何も起きない
  t.reset();
  assert.equal(t.state, "waiting");
  const r = t.update(5000, true, 3);                              // reset したあとは、また撮れる
  assert.deepEqual([r.state, r.isNewBest], ["holding", true]);
}

// 71. 同じ点数なら、先のコマを残す(入れ替えない)
{
  const t = createCaptureTracker();
  t.update(0, true, 50);
  assert.equal(t.update(300, true, 50).isNewBest, false);
  assert.equal(t.update(600, true, 51).isNewBest, true);
}

// 72. 点数が NaN: 最初のコマは「一番良い」のまま。あとの NaN は、一番良いにならない。有効な点数が来れば、入れ替わる
{
  const t = createCaptureTracker();
  assert.equal(t.update(0, true, NaN).isNewBest, true);
  assert.equal(t.update(300, true, NaN).isNewBest, false);
  assert.equal(t.update(600, true, -5).isNewBest, true);          // 有効な点数(負の数でも)は、NaN より良い
  assert.equal(t.update(700, true, undefined).isNewBest, false);  // undefined も、良いとは数えない
}

// 73. 保持の長さは、設定で変えられる
{
  const t = createCaptureTracker({ holdMs: 300 });
  t.update(0, true, 1);
  assert.equal(t.update(299, true, 1).done, false);
  assert.equal(t.update(300, true, 1).done, true);
}

console.log("guide_test: すべて通りました");
