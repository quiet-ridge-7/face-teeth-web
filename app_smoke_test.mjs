// app_smoke_test.mjs — app.js を、作り物の画面・カメラ・顔の点の中で動かして、
// 「顔が見つかった側」(口を描く、測る、案内を出す、撮影する、ボタンを押す)まで、通して確かめるテスト。
//   実行: node app_smoke_test.mjs
// カメラも、写真も、使わない。ファイルも、保存しない(保存の依頼は、偽の関数が数えるだけ)。
// app.js は、読むだけ(書き換えない)。整理(リファクタリング)のたびに、動きが変わっていないかを確かめるために使う。
//   別の app.js を試す時: APP_JS=別のパス node app_smoke_test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP_JS || path.join(dir, "app.js");
const HTML = path.join(dir, "index.html");
const guide = await import(pathToFileURL(path.join(dir, "guide.mjs")).href);
const { MESSAGES } = guide;

// app.js が import している自作のモジュール(./○○.mjs。MediaPipe の mediapipe_setup.mjs は除く)を、全部読み込んで、
// 取り出せる名前(export)を、まとめて、app.js に渡す。これで、関数を別のファイルに移しても、確認できる。
const appSource = fs.readFileSync(APP, "utf-8");
const moduleFiles = [...new Set([...appSource.matchAll(/from\s*"\.\/([^"]+\.mjs)"/g)].map((m) => m[1]))].filter((f) => f !== "mediapipe_setup.mjs");
const injected = {};
for (const file of moduleFiles) Object.assign(injected, await import(pathToFileURL(path.join(dir, file)).href));

// ---- index.html にある id だけを、「画面の部品」として用意する(app.js が、無い id を探すと、エラーになる)
const html = fs.readFileSync(HTML, "utf-8");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const hiddenInHtml = (id) => {
  const tag = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`));
  return !!tag && /\shidden(\s|>|=|\/)/.test(tag[0]);
};

const HTMLElementBase = (globalThis.HTMLElement = class {});
class El extends HTMLElementBase {
  constructor(id = "") {
    super();
    this.id = id; this._text = ""; this.hidden = hiddenInHtml(id); this.value = 0; this.checked = false;
    this.src = ""; this.children = []; this.listeners = {}; this.width = 640; this.height = 480;
    this.videoWidth = 640; this.videoHeight = 480; this.readyState = 4; this.srcObject = null; this.style = {};
  }
  append(child) { this.children.push(child); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  getContext() { return (this.ctx ??= fakeCtx()); }
  toBlob(cb) { cb(new Blob([Buffer.from("fake-png-for-smoke-test")], { type: "image/png" })); }
  set textContent(v) { this._text = String(v); if (v === "") this.children = []; }
  get textContent() { return this._text; }
}
function fakeCtx() {
  const state = { fillStyle: "", cyanFills: 0 };                    // 水色(歯の確認用)で塗った回数を、数える
  return new Proxy(state, {
    get: (t, name) => {
      if (name === "cyanFills") return t.cyanFills;
      if (name === "fillRect") return () => { if (t.fillStyle === "rgba(0, 255, 255, 0.6)") t.cyanFills++; };
      if (name === "getImageData") return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)).fill(100) });   // 灰色(明るさ 100、色の濃さ 0)
      return () => {};
    },
    set: (t, name, value) => { t[name] = value; return true; },
  });
}

// ---- 偽の顔の点・口の開き・顔の向き
const blendNames = Array.from({ length: 52 }, (_, i) => `blend${i}`); blendNames[25] = "jawOpen";
const LIP = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
function makeResult({ found, jawOpen = 0.7 }) {
  if (!found) return { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] };
  const face = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  face[234] = { x: 0.38, y: 0.55, z: 0 };            // 顔の幅 0.24(0.2〜0.5 の中)
  face[454] = { x: 0.62, y: 0.55, z: 0 };
  face[10] = { x: 0.5, y: 0.3, z: 0 };
  face[152] = { x: 0.5, y: 0.8, z: 0 };
  LIP.forEach((n, i) => { const a = (2 * Math.PI * i) / LIP.length; face[n] = { x: 0.5 + 0.08 * Math.cos(a), y: 0.65 + 0.04 * Math.sin(a), z: 0 }; });
  return {
    faceLandmarks: [face],
    faceBlendshapes: [{ categories: blendNames.map((n, i) => ({ index: i, categoryName: n, score: n === "jawOpen" ? jawOpen : 0.01 })) }],
    facialTransformationMatrixes: [{ rows: 4, columns: 4, data: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -40, 1] }],   // 正面(回転なし)
  };
}

// ---- app.js を、作り物の中で起動する。step(n, 間隔ms) で、n コマ進める
async function startApp(resultOf) {
  const elements = {};
  const saved = [];
  const rafQueue = [];
  const document = {
    getElementById: (id) => (htmlIds.has(id) ? (elements[id] ??= new El(id)) : null),
    createElement: () => new El(""),
  };
  const window = { api: { savePhoto: async (buf) => { saved.push(buf.byteLength); return { path: "(偽の保存先)" }; }, openCaptures: async () => ({ ok: true }) } };
  const navigator = { mediaDevices: { getUserMedia: async () => ({ fake: "stream" }) } };
  const createFaceLandmarker = async () => ({ detectForVideo: () => resultOf() });

  const code = fs.readFileSync(APP, "utf-8").replace(/import\s*\{[^}]*\}\s*from\s*"[^"]+";?/g, "");   // import の行は、外から渡す(上で読み込んだモジュールから)
  const names = [...Object.keys(injected), "createFaceLandmarker", "window", "document", "navigator", "requestAnimationFrame"];
  // "use strict": 本物の app.js(<script type="module">)は、厳密モードで動く。
  // 厳密モードでは、let の無い代入(message = … のような、作っていない変数への代入)も、ReferenceError になる。
  const fn = new Function(...names, `"use strict";\nreturn (async () => {\n${code}\n})();`);
  const log = console.log; console.log = () => {};                  // app.js の、読み込みの表示を、静かにする
  try {
    await fn(...Object.keys(injected).map((k) => injected[k]), createFaceLandmarker, window, document, navigator, (f) => { rafQueue.push(f); });
  } finally { console.log = log; }
  await new Promise((r) => setTimeout(r, 30));

  const step = async (n = 1, gapMs = 0) => {
    for (let i = 0; i < n; i++) {
      const next = rafQueue.shift();
      assert.ok(next, "次のコマが予約されていない(loop が止まった。エラーで止まった可能性)");
      next(performance.now());                                      // 本物の requestAnimationFrame は、時刻(ミリ秒)を引数に渡す。エラーが出れば、そのまま、テストが失敗する
      await new Promise((r) => setTimeout(r, gapMs || 1));
    }
    await new Promise((r) => setTimeout(r, 30));                    // toBlob の中(あとで動く所)の、終わりを待つ
  };
  return { elements, saved, step };
}

const listText = (elements) => elements.checks.children.map((li) => li.textContent);

// 1. 顔が見つからない
{
  const app = await startApp(() => makeResult({ found: false }));
  await app.step(3);
  assert.equal(app.elements.instruction.textContent, MESSAGES.noFace);
  assert.deepEqual(listText(app.elements), []);
  assert.equal(app.elements["hold-progress"].value, 0);
}

// 2. 顔が見つかった: 口を閉じている → 口の開きが ✗。案内は「口を大きく開けてください」
{
  const app = await startApp(() => makeResult({ found: true, jawOpen: 0.1 }));
  await app.step(3);
  const e = app.elements;
  assert.equal(e.instruction.textContent, MESSAGES.openMouth);
  assert.equal(listText(e).length, 6);
  assert.ok(listText(e).includes("✗ 口の開き"));
  assert.ok(listText(e).includes("✓ 顔の大きさ"));
  assert.match(e["face-info"].textContent, /顔数: 1 /);
  assert.match(e["face-info"].textContent, /口の開き: 0\.10/);
  assert.match(e["face-info"].textContent, /顔の大きさ: 0\.24/);
  assert.match(e["face-info"].textContent, /顔の位置: 0\.50/);
  assert.match(e["face-info"].textContent, /顔の明るさ: 100/);
  assert.match(e["face-info"].textContent, /yaw:0 /);
  assert.match(e["teeth-info"].textContent, /歯 1\.00/);
  assert.equal(e["hold-progress"].value, 0);
}

// 3. 全部OKが約1.4秒続く(保存のチェックなし = 標準): 撮れて、静止画と「もう一度撮る」が出る。保存はしない
{
  const app = await startApp(() => makeResult({ found: true, jawOpen: 0.7 }));
  await app.step(14, 100);
  const e = app.elements;
  assert.equal(e.instruction.textContent, MESSAGES.ok);
  assert.ok(listText(e).every((t) => t.startsWith("✓")), "6項目とも ✓");
  assert.equal(e["hold-progress"].value, 1);
  assert.equal(e["shot-image"].hidden, false, "静止画が出る");
  assert.equal(e.again.hidden, false, "「もう一度撮る」が出る");
  assert.match(e["shot-saved"].textContent, /保存していません/);
  assert.equal(app.saved.length, 0, "標準では、保存を頼まない");
  // 「もう一度撮る」を押す
  e.again.listeners.click();
  assert.equal(e["shot-image"].hidden, true);
  assert.equal(e.again.hidden, true);
  assert.equal(e["shot-saved"].textContent, "");
}

// 4. 保存のチェックあり: 撮れたら、保存を頼む。「もう一度撮る」のあと、もう1枚撮れる
{
  const app = await startApp(() => makeResult({ found: true, jawOpen: 0.7 }));
  app.elements["auto-save"].checked = true;
  await app.step(14, 100);
  const e = app.elements;
  assert.equal(app.saved.length, 1, "保存を、1回頼む");
  assert.match(e["shot-saved"].textContent, /^保存しました: /);
  e.again.listeners.click();
  await app.step(14, 100);
  assert.equal(app.saved.length, 2, "もう一度撮ると、2枚目の保存を頼む");
}

// 4b. 「歯の判定を色で見る」: チェックなしは、水色を塗らない。チェックありは、塗る(口の内側に、歯っぽい画素がある時)
{
  const app = await startApp(() => makeResult({ found: true, jawOpen: 0.7 }));
  await app.step(2);
  assert.equal(app.elements.overlay.getContext("2d").cyanFills, 0, "標準(チェックなし)では、水色を塗らない");
  app.elements["show-teeth"].checked = true;
  await app.step(1);
  const filled = app.elements.overlay.getContext("2d").cyanFills;
  assert.ok(filled > 1000, `チェックありでは、水色を塗る(${filled} 回)`);
  assert.equal(filled, app.elements["teeth-info-2"].textContent.match(/歯っぽい画素数 (\d+)/)[1] * 1, "塗った数 = 歯っぽい画素数");
}

// 5. 顔が見つかっている途中で、顔が消える: 棒が 0 に戻り、案内が「顔を映してください」になり、一覧が消える
{
  let faceThere = true;
  const app = await startApp(() => makeResult({ found: faceThere, jawOpen: 0.7 }));
  await app.step(5, 100);                                            // 全部OKが、約0.5秒続く(まだ、撮れない)
  const e = app.elements;
  assert.equal(e.instruction.textContent, MESSAGES.ok);
  assert.ok(e["hold-progress"].value > 0.2 && e["hold-progress"].value < 1, `棒が途中: ${e["hold-progress"].value}`);
  faceThere = false;                                                 // 顔が、画面から消える
  await app.step(1, 100);
  assert.equal(e["hold-progress"].value, 0, "顔が消えたら、棒は 0 に戻る");
  assert.equal(e.instruction.textContent, MESSAGES.noFace);
  assert.deepEqual(listText(e), []);
  faceThere = true;                                                  // 顔が戻っても、保持は、最初から(前の 0.5秒を、引きずらない)
  await app.step(2, 100);
  assert.ok(e["hold-progress"].value < 0.3, `戻ったあとは、最初から: ${e["hold-progress"].value}`);
  assert.equal(e["shot-image"].hidden, true, "1秒に届いていないので、まだ、撮れていない");
}

console.log("app_smoke_test: すべて通りました");
