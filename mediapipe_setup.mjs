// MediaPipe(顔の点を見つける部品)を準備する。初めての部品で、準備が少し複雑なので、
// ここにまとめてある。app.js からは、createFaceLandmarker() を呼ぶだけでよい。
import { FaceLandmarker, FilesetResolver } from "./lib/mediapipe/vision_bundle.mjs";

const WASM_DIR = "./lib/mediapipe/wasm"; // MediaPipeの計算部分(WASM)の場所
const MODEL_PATH = "./models/face_landmarker.task";             // 顔のモデルの場所

// 顔の点を見つける「FaceLandmarker」を作って、返す(時間がかかるので async)
export async function createFaceLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);

  // モデルは、ファイルの場所ではなく、中身(バイト列)で渡す。
  // MediaPipeは、日本語を含むフォルダの場所を、開けないことがあるため
  const modelBuffer = await fetch(MODEL_PATH).then((r) => r.arrayBuffer());

  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: new Uint8Array(modelBuffer) },
    runningMode: "VIDEO",                       // 動画(1コマずつ、続けて調べる)
    numFaces: 1,                                // 顔は、1人だけ
    outputFaceBlendshapes: true,                // 口の開き(jawOpen)などの数字も、返してもらう
    outputFacialTransformationMatrixes: true,   // 顔の向きを出すための行列も、返してもらう
  });
}
