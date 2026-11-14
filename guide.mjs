// guide.mjs — 測定の計算と、案内の判断をする部品。
// 画面(DOM)や MediaPipe には依存しない「ただの関数」だけを置く。
// こうしておくと、カメラ無しで、Node でテストできる(guide_test.mjs)。

const toDeg = (rad) => (rad * 180) / Math.PI;

// 画素の並び(getImageData の data。赤,緑,青,透明度 の4つずつ)から、平均の明るさを出す。
//   明るさは 0(真っ黒)〜 255(真っ白)。人の目の感じ方に合わせて、緑を重く数える。
//   画素が1つも無い時は 0 を返す。
export function averageBrightness(rgba) {
  const pixelCount = Math.floor(rgba.length / 4);
  if (pixelCount === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pixelCount; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    sum += 0.299 * r + 0.587 * g + 0.114 * b;   // 透明度(4つ目)は使わない
  }
  return sum / pixelCount;
}

// MediaPipe の「顔の変換行列」(4x4。数字16個)から、顔の向きを、角度(度)で出す。
//   data : 数字16個の配列。「列の順」に並んでいる(最後の4つが、顔の位置の移動)
//   戻り値: { yaw, pitch, roll }
//     yaw   … 左右の向き(首を横に振る)
//     pitch … 上下の向き(うなずく)
//     roll  … 傾き(首をかしげる)
//   符号(どちらを向くとプラスか)は、実際に向いて確かめる。
export function matrixToAngles(data) {
  const R = (row, col) => data[col * 4 + row];   // 行と列を指定して、数字を取り出す
  const sinPitch = Math.max(-1, Math.min(1, -R(1, 2)));   // asin は -1〜1 だけ受け付ける
  return {
    yaw: toDeg(Math.atan2(R(0, 2), R(2, 2))),
    pitch: toDeg(Math.asin(sinPitch)),
    roll: toDeg(Math.atan2(R(1, 0), R(1, 1))),
  };
}

// ================= 案内の判断 =================

// しきい値(境目の数字)。ここ1か所で決める。
export const THRESHOLDS = {
  faceSizeMin: 0.2,      // 顔の幅の割合。これより小さいと「遠い」
  faceSizeMax: 0.5,      // これより大きいと「近い」
  faceCenterXMin: 0.3,   // 顔の中心の横位置(反転前の映像で 0〜1)。これより小さいと、画面では右寄り
  faceCenterXMax: 0.7,   // これより大きいと、画面では左寄り
  yawMax: 15,            // 左右の向きの許す角度(度)。±この角度まではOK(ちょうどは、OK)
  brightnessMin: 40,     // 顔の平均の明るさ(0〜255)。これより小さいと暗い(ちょうどは、OK)
  jawOpenMin: 0.5,       // 口の開き(0〜1)。これ以上でOK(ちょうどは、OK)
  teethRatioMin: 0.08,   // 歯の割合(0〜1)。これ以上でOK(ちょうどは、OK)。実機の数字(閉じる 0、開ける 0、唇を引く 0.13)の間で決めた
};

// 画面に出す案内の文。ここを書き換えると、言葉が変わる。
export const MESSAGES = {
  noFace: "顔を映してください",
  tooSmall: "もう少し近づいてください",
  tooBig: "少し離れてください",
  moveLeft: "もう少し左に寄ってください",     // 画面で顔が右寄りの時
  moveRight: "もう少し右に寄ってください",    // 画面で顔が左寄りの時
  turnFront: "正面を向いてください",
  tooDark: "明るい場所で撮影してください",
  openMouth: "口を大きく開けてください",
  showTeeth: "歯が見えるように、唇を引いてください",
  ok: "そのまま!",
};

// チェック一覧の項目名(上から、案内の優先順位の順)
const CHECK_LABELS = {
  size: "顔の大きさ",
  position: "顔の位置",
  angle: "顔の向き",
  brightness: "明るさ",
  mouth: "口の開き",
  teeth: "歯の見え方",
};

// 測った値から、「いま一番大事な案内1つ」と、各項目のOK/NGを決める。
//   m = {
//     faceFound : 顔が見つかったか(true / false)
//     faceSize  : 顔の幅の割合(0〜1)
//     faceCenterX: 顔の中心の横位置(0〜1)
//     yaw       : 左右の向き(度)
//     brightness: 顔の平均の明るさ(0〜255)
//     jawOpen   : 口の開き(0〜1)
//     teethRatio: 歯の割合(0〜1)。describeMouthPixels の toothRatio
//   }
//   戻り値: { message, allOk, checks: [{ key, label, ok }, ...] }
//   優先順位: 顔なし → 大きさ → 位置 → 向き → 明るさ → 口 → 歯 → 全部OK
//   数字が NaN などで比べられない時は、OKにしない(安全側)。
export function decideGuide(m, t = THRESHOLDS, msg = MESSAGES) {
  if (!m.faceFound) {
    return {
      message: msg.noFace,
      allOk: false,
      checks: Object.keys(CHECK_LABELS).map((key) => ({ key, label: CHECK_LABELS[key], ok: false })),
    };
  }

  // 優先順位の順に並べる。ok が false の時に出す文(message)も、一緒に持たせる
  const items = [
    {
      key: "size",
      ok: m.faceSize >= t.faceSizeMin && m.faceSize <= t.faceSizeMax,
      message: m.faceSize < t.faceSizeMin ? msg.tooSmall : msg.tooBig,
    },
    {
      key: "position",
      ok: m.faceCenterX >= t.faceCenterXMin && m.faceCenterX <= t.faceCenterXMax,
      message: m.faceCenterX < t.faceCenterXMin ? msg.moveLeft : msg.moveRight,
    },
    {
      key: "angle",
      ok: Math.abs(m.yaw) <= t.yawMax,
      message: msg.turnFront,
    },
    {
      key: "brightness",
      ok: m.brightness >= t.brightnessMin,
      message: msg.tooDark,
    },
    {
      key: "mouth",
      ok: m.jawOpen >= t.jawOpenMin,
      message: msg.openMouth,
    },
    {
      key: "teeth",
      ok: m.teethRatio >= t.teethRatioMin,
      message: msg.showTeeth,
    },
  ];

  const firstNg = items.find((item) => !item.ok);   // 最初にダメだった項目
  return {
    message: firstNg ? firstNg.message : msg.ok,
    allOk: firstNg === undefined,
    checks: items.map((item) => ({ key: item.key, label: CHECK_LABELS[item.key], ok: item.ok })),
  };
}

// ================= 歯の判定の部品 =================

// 点 (x, y) が、多角形の内側にあるか。
//   polygon: 点の配列 [{ x, y }, { x, y }, …](順番は、ぐるっと一周する順。右回りでも左回りでもよい)
//   考え方: 点から「右へ」線を引いて、多角形の辺と何回交わるかを数える。
//           奇数回なら内側、偶数回なら外側。
//   点が辺の上にぴったりある時の扱いは、決めていない(画素の判定では、気にしなくてよい)。
//   点が3つ未満の時(多角形にならない)は、いつも false。
export function isPointInPolygon(x, y, polygon) {
  const n = polygon.length;
  if (n < 3) return false;

  let inside = false;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];                 // 最後の点の次は、最初の点に戻る

    // 辺 a-b が、点の高さ y をまたいでいるか(端点が、y の上と下に分かれているか)
    if ((a.y > y) !== (b.y > y)) {
      // y の高さで、この辺が通る x の位置
      const xOnEdge = a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x < xOnEdge) {
        inside = !inside;                           // 点の右で交わった: 内外を入れ替える
      }
    }
  }
  return inside;
}

// 「歯っぽい画素」のルール(しきい値は、5-d で、実際に試して決める。いまは仮の値)
//   歯は「明るくて、色が薄い(白っぽい)」。唇や舌は赤みが強く、口の奥は暗い。
//   これは「明るさを、固定の値で決める」時の既定値。実際には、下の toothRuleFor で、
//   顔の明るさに合わせた rule を作って、渡して使う。
export const TOOTH_RULE = {
  brightnessMin: 60,   // 明るさ(0〜255)がこれ以上
  saturationMax: 0.45,  // 色の濃さ(0〜1。0 は無彩色=白・灰色)がこれ以下
};

// 歯の明るさを、「顔の明るさとの差」で決める設定(しきい値は、5-d で、実際に試して決める。いまは仮の値)
//   カメラの自動調整や部屋の明るさが変わっても、ずれにくい。
export const TOOTH_SETTINGS = {
  brightnessDiffMin: 10,   // 顔の平均の明るさより、これ以上、明るい画素を、歯の候補にする
  saturationMax: 0.45,     // 色の濃さ(0〜1)がこれ以下
};

// 顔の平均の明るさ(0〜255)から、「歯っぽい画素」のルールを作る。
//   明るさのしきい値 = 顔の明るさ + 差。 戻り値は、isToothLikePixel などの rule に、そのまま渡せる。
export function toothRuleFor(faceBrightness, settings = TOOTH_SETTINGS) {
  return {
    brightnessMin: faceBrightness + settings.brightnessDiffMin,
    saturationMax: settings.saturationMax,
  };
}

// 1つの画素(赤 r、緑 g、青 b。それぞれ 0〜255)の、明るさと、色の濃さ。
//   明るさ: averageBrightness と同じ重み(緑を重く数える)。0(黒)〜 255(白)
//   色の濃さ: (一番大きい色 − 一番小さい色) ÷ 一番大きい色。0(白・灰色)〜 1(真っ赤など)
//             白や灰色は 0 に近く、赤い唇は 0.5〜0.7 くらいになる。真っ黒(0)は 0 とする
function brightnessAndSaturation(r, g, b) {
  const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  return { brightness, saturation };
}

// 「明るさ」の条件と、「色が薄い」条件。ちょうどの値は、どちらも満たす(以上・以下)。
const isBrightEnough = (brightness, rule) => brightness >= rule.brightnessMin;
const isPaleEnough = (saturation, rule) => saturation <= rule.saturationMax;

// 1つの画素が、歯っぽいか(明るくて、色が薄い)。
export function isToothLikePixel(r, g, b, rule = TOOTH_RULE) {
  const { brightness, saturation } = brightnessAndSaturation(r, g, b);
  return isBrightEnough(brightness, rule) && isPaleEnough(saturation, rule);
}

// 多角形の中にある画素を、1つずつ callback(r, g, b, x, y) に渡す。中の画素の数を返す。
//   (x, y) は、その画素の位置(画像の左上が 0, 0)
//   画素の「中心」(x+0.5, y+0.5)が多角形の中にあれば、その画素を数える。画像の外は数えない。
function forEachPixelInside(rgba, width, height, polygon, callback) {
  if (polygon.length < 3) return 0;

  // 多角形を囲む四角だけを調べる(画像の外にはみ出さないようにする)
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));

  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!isPointInPolygon(x + 0.5, y + 0.5, polygon)) continue;
      count++;
      const i = (y * width + x) * 4;                  // この画素の、並びの中の位置
      callback(rgba[i], rgba[i + 1], rgba[i + 2], x, y);
    }
  }
  return count;
}

// 多角形の中の画素のうち、歯っぽい画素がどれくらいかを測る。
//   rgba   : 画像の画素の並び(getImageData(…).data。赤,緑,青,透明度 の4つずつ)
//   width, height: その画像の大きさ(ピクセル)
//   polygon: 口の内側などの多角形。点の配列 [{ x, y }, …]。座標は、その画像のピクセル
//   戻り値  : { ratio, insidePixels, toothPixels }
//     ratio        … 歯っぽい画素 ÷ 多角形の中の画素(0〜1)。中が0画素なら 0
//     insidePixels … 多角形の中の画素の数(口が閉じていると、小さい。割合を信じてよいかの目安)
//     toothPixels  … そのうち、歯っぽい画素の数
export function measureTeeth(rgba, width, height, polygon, rule = TOOTH_RULE) {
  let toothPixels = 0;
  const insidePixels = forEachPixelInside(rgba, width, height, polygon, (r, g, b) => {
    if (isToothLikePixel(r, g, b, rule)) toothPixels++;
  });
  return { ratio: insidePixels === 0 ? 0 : toothPixels / insidePixels, insidePixels, toothPixels };
}

// 明るい順に並んだ画素から、「上から fraction の所」の画素の明るさを返す。
//   fraction = 0.1 なら、上から10%の所(これより明るい画素が、約10%ある)
function brightnessFromTop(sortedPixels, fraction) {
  const index = Math.min(sortedPixels.length - 1, Math.floor(sortedPixels.length * fraction));
  return sortedPixels[index].brightness;
}

// しきい値を決めるための、中身の数字。多角形の中の画素が、「明るさ」と「色の濃さ」のどちらで外れているかが分かる。
//   戻り値: {
//     insidePixels   … 多角形の中の画素の数
//     meanBrightness … 平均の明るさ(0〜255)
//     meanSaturation … 平均の色の濃さ(0〜1)
//     brightRatio    … 「明るさ」の条件だけを満たす画素の割合(明るさ ≥ rule.brightnessMin)
//     paleRatio      … 「色が薄い」条件だけを満たす画素の割合(色の濃さ ≤ rule.saturationMax)
//     toothRatio     … 両方を満たす画素の割合(measureTeeth の ratio と同じ)
//     topBrightness  … 明るい方の上位10%の画素の、平均の明るさ(歯は、口の中で一番明るい部分にある)
//     topSaturation  … その、上位10%の画素の、平均の色の濃さ
//     brightnessP50  … 明るさの分布。明るい順に並べて、上から50%の所の画素の明るさ(真ん中の値)
//     brightnessP90  … 同じく、上から10%の所(これより明るい画素が、全体の約10%)
//     brightnessP97  … 同じく、上から3%の所
//     brightnessMax  … 一番明るい画素の明るさ
//   }
export function describeMouthPixels(rgba, width, height, polygon, rule = TOOTH_RULE) {
  let sumBrightness = 0;
  let sumSaturation = 0;
  let bright = 0;
  let pale = 0;
  let both = 0;
  const pixels = [];                                  // 各画素の { brightness, saturation }(上位10%を出すために、取っておく)
  const insidePixels = forEachPixelInside(rgba, width, height, polygon, (r, g, b) => {
    const { brightness, saturation } = brightnessAndSaturation(r, g, b);
    pixels.push({ brightness, saturation });
    sumBrightness += brightness;
    sumSaturation += saturation;
    const isBright = isBrightEnough(brightness, rule);
    const isPale = isPaleEnough(saturation, rule);
    if (isBright) bright++;
    if (isPale) pale++;
    if (isBright && isPale) both++;
  });
  if (insidePixels === 0) {
    return {
      insidePixels: 0, meanBrightness: 0, meanSaturation: 0,
      brightRatio: 0, paleRatio: 0, toothRatio: 0, topBrightness: 0, topSaturation: 0,
      brightnessP50: 0, brightnessP90: 0, brightnessP97: 0, brightnessMax: 0,
    };
  }

  // 明るい順に並べて、上位10%(少なくとも1画素)の平均を出す
  pixels.sort((a, b) => b.brightness - a.brightness);
  const topCount = Math.max(1, Math.ceil(insidePixels * 0.1));
  let topSumBrightness = 0;
  let topSumSaturation = 0;
  for (let i = 0; i < topCount; i++) {
    topSumBrightness += pixels[i].brightness;
    topSumSaturation += pixels[i].saturation;
  }

  return {
    insidePixels,
    meanBrightness: sumBrightness / insidePixels,
    meanSaturation: sumSaturation / insidePixels,
    brightRatio: bright / insidePixels,
    paleRatio: pale / insidePixels,
    toothRatio: both / insidePixels,
    topBrightness: topSumBrightness / topCount,
    topSaturation: topSumSaturation / topCount,
    brightnessP50: brightnessFromTop(pixels, 0.5),
    brightnessP90: brightnessFromTop(pixels, 0.1),
    brightnessP97: brightnessFromTop(pixels, 0.03),
    brightnessMax: pixels[0].brightness,
  };
}

// 多角形の中で、歯っぽい画素の「場所」の一覧を返す。画面に色を付けて、どこを歯と数えたかを確かめるために使う。
//   戻り値: [{ x, y }, …](画像のピクセルの位置。画像の左上が 0, 0)。measureTeeth の toothPixels と、同じ画素。
export function listToothPixels(rgba, width, height, polygon, rule = TOOTH_RULE) {
  const positions = [];
  forEachPixelInside(rgba, width, height, polygon, (r, g, b, x, y) => {
    if (isToothLikePixel(r, g, b, rule)) positions.push({ x, y });
  });
  return positions;
}

// ================= 撮影の部品(ステップ6) =================

// 撮影の設定
export const CAPTURE_SETTINGS = {
  holdMs: 1000,          // 全部OKが、これだけ(ミリ秒)続いたら、撮る(ちょうどは、撮る)
};

// 点数の設定。点数は、大きいほど良い。
export const SCORE_SETTINGS = {
  motionPenalty: 0,      // 動きの減点の重さ。0 なら、使わない(あとで、ブレを避けたい時に、決める)
};

// 1コマの点数(大きいほど、良い写真)。
//   主な点数: 歯っぽい画素数(歯が、たくさん見えているほど良い)
//   m = { toothPixels: 歯っぽい画素数, motion: 前のコマからの動き(省略できる。大きいほど、ブレている) }
export function frameScore(m, settings = SCORE_SETTINGS) {
  return m.toothPixels - settings.motionPenalty * (m.motion ?? 0);
}

// 「全部OKが続いている間で、一番良いコマ」を見つける仕組み。時刻(ミリ秒)は、呼ぶ側が渡す。
//   使い方: const tracker = createCaptureTracker();
//           毎フレーム  const r = tracker.update(performance.now(), g.allOk, frameScore(m));
//             r.isNewBest が true なら、「このコマが、いままでで一番良い」→ 画像をとっておく
//             r.done が true なら、「1秒続いた」→ とっておいた画像を、保存する
//           写真を撮ったあと: tracker.reset() を呼ぶまで、続けて撮らない
//   状態: "waiting"(待ち)→ "holding"(全部OKが続いている)→ "captured"(撮れた)
//   戻り値: { state, elapsedMs, progress(0〜1), isNewBest, done, discarded, bestScore }
//     discarded … 保持中に、全部OKが崩れて、とっておいたコマを捨てる時だけ true
//   同じ点数の時は、先のコマを残す(より良い時だけ、入れ替える)。
//   点数が NaN の時は、良いとは、数えない(ただし、保持の最初のコマは、必ず「一番良い」にする。
//   とっておく画像が、無い状態を作らないため)。
export function createCaptureTracker(settings = CAPTURE_SETTINGS) {
  let state = "waiting";
  let startMs = 0;
  let bestScore = -Infinity;

  const snapshot = (extra) => ({
    state,
    elapsedMs: 0,
    progress: 0,
    isNewBest: false,
    done: false,
    discarded: false,
    bestScore,
    ...extra,
  });

  return {
    get state() {
      return state;
    },

    update(nowMs, allOk, score) {
      if (state === "captured") {
        return snapshot({ elapsedMs: nowMs - startMs, progress: 1 });       // 撮れたあとは、何もしない
      }

      if (state === "waiting") {
        if (!allOk) return snapshot({});
        // 保持の最初のコマ。必ず「いままでで一番良い」にする
        state = "holding";
        startMs = nowMs;
        bestScore = Number.isNaN(score) ? -Infinity : score;
        return snapshot({ isNewBest: true });
      }

      // holding
      if (!allOk) {
        state = "waiting";                          // 崩れた: とっておいたコマを捨てて、最初から
        bestScore = -Infinity;
        return snapshot({ discarded: true });
      }
      const elapsedMs = nowMs - startMs;
      let isNewBest = false;
      if (score > bestScore) {                      // NaN は、比べると false になる
        bestScore = score;
        isNewBest = true;
      }
      if (elapsedMs >= settings.holdMs) {
        state = "captured";
        return snapshot({ elapsedMs, progress: 1, isNewBest, done: true });
      }
      return snapshot({ elapsedMs, progress: elapsedMs / settings.holdMs, isNewBest });
    },

    // 撮ったあと、もう一度撮れる状態(待ち)に戻す
    reset() {
      state = "waiting";
      bestScore = -Infinity;
    },
  };
}
