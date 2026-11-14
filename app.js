// @ts-check

import { createFaceLandmarker } from "./mediapipe_setup.mjs";
import { matrixToAngles,averageBrightness, decideGuide, describeMouthPixels,
         createCaptureTracker, frameScore, listToothPixels} from "./guide.mjs";

console.log("app.js が、読み込まれました");

// Elementの取得

function getElement(id){
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)){throw new Error(`error of ${id}`);}
  return element;
}

const video = getElement("video");
const overlay = getElement("overlay");
const status = getElement("status");
const faceInfo = getElement("face-info");
const instruction = getElement("instruction");
const checks = getElement("checks");
const teethInfo = getElement("teeth-info");
const teethInfo2 = getElement("teeth-info-2");
const teethShot = getElement("teeth-shot");
const shotImage = getElement("shot-image");
const shotSaved = getElement("shot-saved");
const againButton = getElement("again");
const holdProgress = getElement("hold-progress");
const autoSave = getElement("auto-save");
const showTeeth = getElement("show-teeth");

const INNER_LIP = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
    console.log("カメラを取れました:", stream);
    video.addEventListener("loadedmetadata", () => {
      overlay.width = video.videoWidth; 
      overlay.height = video.videoHeight;
    });
    video.srcObject = stream;
    status.textContent = "カメラが映っています";
  } catch (err) {
    status.textContent = "カメラを使えませんでした: " + err.message;
  }
}

startCamera();

// 口を描く
function drawMouth(ctx, face, width, height) {
  ctx.fillStyle = "red";
  // 点で描く
  for (let i=0; i<INNER_LIP.length; i++){
    let p=face[INNER_LIP[i]];
    ctx.fillRect(p.x*width-3, p.y*height-3, 6, 6);
  }
  // 線で結ぶ
  ctx.strokeStyle = "lime";
  ctx.beginPath(); 
  let p=face[INNER_LIP[0]];
  ctx.moveTo(p.x*width, p.y*height);
  for (let i=1; i<INNER_LIP.length; i++){
    let p=face[INNER_LIP[i]];
      ctx.lineTo(p.x*width, p.y*height);
  }
  ctx.closePath();
  ctx.stroke();
}        

// 口の開き
function readJawOpen(categories) {
  const jaw=categories.find((e) => e.categoryName === "jawOpen");
  return jaw.score;
}

// 顔の横幅
function readFaceSize(face) {
  let p1=face[234];
  let p2=face[454];
  return Math.abs(p1.x-p2.x);
}

// 顔の位置
function readFacePosition(face) {
  let p1=face[234];
  let p2=face[454];
  return Math.abs(p1.x+p2.x)/2;
}

// 顔の領域
function readFaceBox(face, width, height) {
  let x=Math.round(face[234].x*width);
  let w=Math.round((face[454].x-face[234].x)*width);
  let y=Math.round(face[10].y*height);
  let h=Math.round((face[152].y-face[10].y)*height);
  return {x,y,w,h};
}

// フレームの取得
function drawFrame(video, width, height) {
  const work = document.createElement("canvas");
  work.width = width;
  work.height = height;
  work.getContext("2d").drawImage(video, 0, 0, width, height);
  return work;        
}

// 顔の明るさ
function readFaceBrightness(work, box){
  const wctx = work.getContext("2d");
  let img=wctx.getImageData(box.x, box.y, box.w, box.h).data;
  return Math.round(averageBrightness(img));
}

// 歯っぽい画素に、色を付ける(確認用)
function drawTeeth(ctx, work, face) {
  const wctx = work.getContext("2d");
  const img = wctx.getImageData(0, 0, work.width, work.height).data;
  const polygon = INNER_LIP.map((n) => ({ x: face[n].x * work.width, y: face[n].y * work.height }));
  const pixels = listToothPixels(img, work.width, work.height, polygon);
  ctx.fillStyle = "rgba(0, 255, 255, 0.6)";          // 水色(半分、透ける)
  for (const p of pixels) {
    ctx.fillRect(p.x, p.y, 1, 1);                    // 1画素分
  }
}

function readTeeth(work, face) {
  const wctx = work.getContext("2d");
  let img0=wctx.getImageData(0, 0, work.width, work.height).data;        
  let q1=INNER_LIP.map((n) => ({ x: (face[n].x)*work.width, y: (face[n].y)*work.height }));
  return describeMouthPixels(img0, work.width, work.height, q1);
}

function formatTeeth(d) {
  return "歯 "+d.toothRatio.toFixed(2)+" / 明るい"+d.brightRatio.toFixed(2)
        +" / 薄さ "+d.paleRatio.toFixed(2)+" / 明るさ "+d.meanBrightness.toFixed(0)
        +" / 濃さ "+d.meanSaturation.toFixed(2)+" / 上位明るさ "+d.topBrightness.toFixed(0)
        +" / 上位濃さ "+d.topSaturation.toFixed(2);
}

function formatTeethDetail(measures){
  const d = measures.teeth;
  return "分布 P50 "+d.brightnessP50.toFixed(0)
        +" / P90 "+d.brightnessP90.toFixed(0)
        +" / P97 "+d.brightnessP97.toFixed(0)
        +" / 最大 "+d.brightnessMax.toFixed(0)
        +" / 顔の明るさ "+measures.brightness
        +" / 口の内側の画素数 "+d.insidePixels
        +" / 歯っぽい画素数 "+measures.toothPixels;
}

function showGuide(message, items){
  checks.textContent = "";
  for (const c of items) {
    let li=document.createElement("li");
    li.textContent =(c.ok ? "✓ " : "✗ ") + c.label;
    checks.append(li);
  }
  instruction.textContent = message;
}

// 画像を、ダウンロードさせる(ブラウザの「保存」の動き)
function downloadBlob(blob, fileName) {
  const link = document.createElement("a");     // 見えないリンクを作る
  link.href = URL.createObjectURL(blob);        // 行き先: 画像のデータ(blob)の、一時的なURL
  link.download = fileName;                     // 保存する時の、ファイルの名前
  link.click();                                 // リンクを、押したことにする
}

function showShot(bestFrame){
  bestFrame.toBlob(async (blob) => {                   // canvas を PNG のデータにする(終わったら、この関数が呼ばれる)
    const buffer = await blob.arrayBuffer();           // データを、送れる形にする
    shotImage.src = URL.createObjectURL(blob);
    shotImage.hidden = false;
    againButton.hidden = false;
    const fileName = "teeth_" + Date.now() + ".png";   // 保存する名前(時刻の数字が入る)
    if (autoSave.checked){
      downloadBlob(blob,fileName);                     // downloadBlob で、ダウンロードさせる(blob と fileName を渡す)
      shotSaved.textContent = "ダウンロードしました: " + fileName; // 画面に出す文に、ファイルの名前を入れる
    } else {
      shotSaved.textContent = "保存していません(チェックを入れると、次から保存します)";
    }
  }, "image/png");
}

function showMeasures(measures){
  faceInfo.textContent = "顔数: " +  measures.faceNum 
  + " / 口の開き: " + measures.jawOpen.toFixed(2)
  + " / 顔の大きさ: " + measures.faceSize.toFixed(2)
  + " / 顔の位置: " + measures.faceCenterX.toFixed(2)
  + " / 顔の明るさ: "+measures.brightness
  + " / yaw:" + (measures.angle.yaw).toFixed(0)
  + " / pitch: " + (measures.angle.pitch).toFixed(0) 
  + " / roll: " + (measures.angle.roll).toFixed(0);
  teethInfo.textContent=formatTeeth(measures.teeth);
  teethInfo2.textContent=formatTeethDetail(measures);        
}

function measure(result, work, width, height) {
  const face = result.faceLandmarks[0];
  const box = readFaceBox(face, width, height);   // 顔の領域(readFaceBox を使う)
  const teeth = readTeeth(work, face);            // 歯(readTeeth を使う)
  return {
    faceNum: result.faceLandmarks.length,         // 顔数 
    jawOpen: readJawOpen(result.faceBlendshapes[0].categories),  // 口の開き
    faceSize: readFaceSize(face),                 // 顔の大きさ
    faceCenterX: readFacePosition(face),          // 顔の位置
    angle: matrixToAngles(result.facialTransformationMatrixes[0].data),  // 顔の向き(matrixToAngles を使う。{ yaw, pitch, roll })
    brightness: readFaceBrightness(work, box),    // 顔の明るさ
    teeth,                                        // 歯(describeMouthPixels の結果)
    toothPixels: Math.round(teeth.toothRatio * teeth.insidePixels),  // 歯っぽい画素数(Math.round(teeth.toothRatio * teeth.insidePixels))
  };
}

async function startFaceFinder() {
  const faceLandmarker = await createFaceLandmarker();
  console.log("顔を見つける準備ができました:", faceLandmarker);
  let ctx=overlay.getContext("2d");
  const tracker = createCaptureTracker();
  let bestFrame = null;
  againButton.addEventListener("click", () => {
    tracker.reset();
    bestFrame = null;
    URL.revokeObjectURL(shotImage.src);
    shotImage.hidden = true;
    shotSaved.textContent = "";
    againButton.hidden = true;
  });
  function loop() {
    if (video.readyState >= 2) {
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      const result = faceLandmarker.detectForVideo(video, performance.now());
      faceInfo.textContent = "顔数: " + result.faceLandmarks.length;
      if (result.faceLandmarks.length > 0){
        drawMouth(ctx, result.faceLandmarks[0], overlay.width, overlay.height); // 口を描く
        const work = drawFrame(video, overlay.width, overlay.height);
        if (showTeeth.checked) {                         // 確認用: 歯っぽい画素を水色に(チェックがある時だけ)
          drawTeeth(ctx, work, result.faceLandmarks[0]);
        }
        const measures = measure(result, work, overlay.width, overlay.height); // 指標を計算       
        showMeasures(measures);  // 指標を表示
        // 誘導
        let m = {faceFound: true, faceSize: measures.faceSize, faceCenterX: measures.faceCenterX,
          yaw: measures.angle.yaw, brightness: measures.brightness, jawOpen: measures.jawOpen, 
          teethRatio: measures.teeth.toothRatio};
        const g = decideGuide(m);
        showGuide(g.message, g.checks);
        // 進捗
        const r = tracker.update(performance.now(), g.allOk, frameScore({ toothPixels: measures.toothPixels }));
        teethShot.textContent="進捗: " + (r.elapsedMs / 1000).toFixed(1) + " / 1.0 秒";
        holdProgress.value = r.progress;
        if (r.isNewBest) { bestFrame = work; }
        if (r.state === "captured") {                   // 撮れた後は、ずっと表示
          teethShot.textContent = "撮影画像: " + bestFrame.width + " × " + bestFrame.height;
        }
        if (r.done) { showShot(bestFrame); }   
      } else {
        showGuide(decideGuide({ faceFound: false }).message, []);
        const r2 = tracker.update(performance.now(), false, 0);
        holdProgress.value = r2.progress;
      }
    }
    requestAnimationFrame(loop);
  }
  loop();
}

startFaceFinder();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js");
}
