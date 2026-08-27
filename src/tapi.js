import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/meshopt_decoder.module.js';

/* ================================================================
   TAPI TAPI 脱出 — 2ステージ構成
   - ステージ1: タピオカ店。クッション・ボトルの裏の数字を探し、
     レバー3本で [4,7,2] を入力してドアから脱出する
   - ステージ2 (?stage=2): 塾の教室。レバーのノブが赤・青・黄に
     塗り分けられ、同じ色で書かれた数字が3か所に隠れている。
     [5,8,3] を入力して入口の引き戸から脱出する
   - ステージ1クリア時に「次のステージへ」「ここで終わる」を選べる
   共通操作: 十字パッドで移動 / ドラッグで視点 / タップで拾う・置く /
   「詳細を見る」で持ち物を360°回す / レバー1回タップ=1つ進む
   ================================================================ */

/* ---------------- WebGL 判定 ---------------- */
function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}
if (!webglAvailable()) {
  document.getElementById('nowebgl').style.display = 'flex';
  document.getElementById('loading').style.display = 'none';
  throw new Error('WebGL unavailable');
}

/* ---------------- ステージ定義 ---------------- */
const params = new URLSearchParams(location.search);
const STAGE = params.get('stage') === '2' ? 2 : 1;
const PREV_SEC = Math.max(0, parseInt(params.get('t') || '0', 10) || 0); // 前ステージまでの秒数

// 通常は圧縮版（.min.glb 合計約4MB）を使う。?full=1 で元データに切り替え
const GLB_SUFFIX = params.has('full') ? '.glb' : '.min.glb';

const STAGE_DEF = {
  1: {
    glb: './assets/TAPI_TAPI_Shop' + GLB_SUFFIX,
    scale: 0.6,           // 元モデルは実寸の約1.7倍
    floorName: 'Floor',
    ceilY: 3.85,
    ceilColor: 0xf3ede6,
    sky: 0xe9e2da,
    // 前方一致にしておく（圧縮版はメッシュ統合で _1 等の枝番が変わるため）
    colliders: /^(Counter_Main|Counter_Side|Table_Round|Table_Wood|Sofa_|Chair_|Stool_Wood|Shelf_Bottles|Register)/,
    correct: [4, 7, 2],
    start: { x: 4.6, z: -4.6, yaw: Math.PI / 2 },
    digitColors: [0xffc94d, 0xffc94d, 0xffc94d], // 表示は3桁ともアンバー
    knobColors: [0xd8d2ca, 0xd8d2ca, 0xd8d2ca],
    clearTitle: 'ステージ1 クリア',
  },
  2: {
    glb: './assets/Classroom' + GLB_SUFFIX,
    scale: 0.58,          // 引き戸の高さ3.46 → 実寸2.0mに合わせる
    floorName: '平面',
    ceilY: 2.55,
    ceilColor: 0xeae7e0,
    sky: 0xdfe3e8,
    colliders: /^(立方体|Shelf|Shose|Kohe|Iwata|Personal-Desk|Screw)/,
    colliderExclude: /^(立方体021|立方体025)/, // 開く引き戸は衝突から外す
    correct: [5, 8, 3],
    start: { x: -4.5, z: -13.0, yaw: Math.PI }, // 教室の奥の通路から入口方向を向く
    // 表示の3桁は赤・青・黄（隠し数字の色と対応）。
    // レバーのノブはあえて全部同じ色にする: どのレバーがどの色の桁を
    // 動かすかは、実際に引いてみて表示の変化で気づかせる
    digitColors: [0xd2413a, 0x3465c9, 0xe8b93c],
    knobColors: [0xd8d2ca, 0xd8d2ca, 0xd8d2ca],
    clearTitle: '脱出成功',
    // 教室はポリゴン数が多い（約180万）ため描画解像度を抑える
    pixelCap: 1.0,
    antialias: false,
  },
};
const DEF = STAGE_DEF[STAGE];

/* ---------------- 定数 ---------------- */
const EYE = 1.6;
const WALK_SPEED = 2.5;
const PLAYER_R = 0.3;
const HOLD_DIST = 1.1;    // 持った物はカメラ前1.1m（近すぎると画面を覆う）
const PLACE_DIST = 3.5;   // 置ける・拾える距離
const PITCH_LIMIT = 70 * (Math.PI / 180);

const state = {
  stage: STAGE,
  holding: null,     // 持っているオブジェクト名 or null
  inspecting: false, // 「詳細を見る」中（ドラッグで持ち物を360°回す）
  dial: [0, 0, 0],   // 表示中の3桁。桁ごとに対応するレバーで進める
  solved: false,
  cleared: false,
};
window.__state = state; // 動作検証用
window.__hidden = [];   // 動作検証用（隠し数字のグループ）

/* ---------------- レンダラ・シーン・カメラ ---------------- */
const fadeEl = document.getElementById('fade');
const renderer = new THREE.WebGLRenderer({ antialias: DEF.antialias !== false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, DEF.pixelCap || 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(DEF.sky);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 80);
camera.rotation.order = 'YXZ';

scene.add(new THREE.HemisphereLight(0xfff6ec, 0x9a8f86, 1.15));
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const sun = new THREE.DirectionalLight(0xfff2e0, 0.8);
sun.position.set(4, 9, 3);
scene.add(sun);

let viewW = 1, viewH = 1;
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (!w || !h) return;
  viewW = w;
  viewH = h;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = w < h ? 70 : 58;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);
onResize();

/* ---------------- 7セグメント数字 ---------------- */
const SEG_MAP = {
  0: 'ABCDEF', 1: 'BC', 2: 'ABGED', 3: 'ABGCD', 4: 'FGBC',
  5: 'AFGCD', 6: 'AFGECD', 7: 'ABC', 8: 'ABCDEFG', 9: 'ABCDFG',
};
function makeSevenSeg(h, color) {
  const w = h * 0.55;
  const t = h * 0.14;
  const d = 0.006;
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color });
  const horiz = () => new THREE.Mesh(new THREE.BoxGeometry(w - t, t, d), mat);
  const vert = () => new THREE.Mesh(new THREE.BoxGeometry(t, h / 2 - t, d), mat);
  const segs = {};
  const put = (key, mesh, x, y) => {
    mesh.position.set(x, y, 0);
    mesh.raycast = () => {};
    group.add(mesh);
    segs[key] = mesh;
  };
  put('A', horiz(), 0, h / 2);
  put('G', horiz(), 0, 0);
  put('D', horiz(), 0, -h / 2);
  put('F', vert(), -w / 2, h / 4);
  put('B', vert(), w / 2, h / 4);
  put('E', vert(), -w / 2, -h / 4);
  put('C', vert(), w / 2, -h / 4);
  const set = (n) => {
    const on = SEG_MAP[n];
    for (const k in segs) segs[k].visible = on.includes(k);
  };
  return { group, set };
}

/* ---------------- 進行用の入れ物（モデル読込後に埋まる） ---------------- */
const raycastList = [];       // タップ判定の対象
const colliders = [];         // 歩行をブロックするAABB
const carryables = new Map(); // name -> { node, offsetY, quat0 }
let bounds = { x1: -8, x2: 5, z1: -8.5, z2: 0 };
let doorParts = [];           // スライドさせるドアのメッシュ
let doorZone = null;          // 出口の通過判定（ステージごとに形が違う）
let dialSegs = [];
const leverPivots = [];
const leverBusy = [false, false, false];
let ready = false;

/* ---------------- 共通部品 ---------------- */
function registerCarry(node) {
  node.userData.tag = 'carry';
  const b = new THREE.Box3().setFromObject(node);
  node.updateMatrixWorld(true);
  const worldPos = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
  carryables.set(node.name, {
    node,
    offsetY: worldPos.y - b.min.y,
    quat0: node.quaternion.clone(), // 置くときは元の向きに戻す
  });
}

// 動かせる物の底面に数字を刻む（裏返さないと読めない）
function markBottom(node, digit, color, rotZ = -Math.PI / 2) {
  const b = new THREE.Box3().setFromObject(node);
  const scale = node.getWorldScale(new THREE.Vector3()).x || 1;
  // 底面からはみ出さない大きさにする（小さい本などのため）
  const sizeWorld = Math.min(
    0.14,
    (b.max.x - b.min.x) * 0.8,
    (b.max.z - b.min.z) * 0.8
  );
  const seg = makeSevenSeg(sizeWorld / scale, color);
  seg.set(digit);
  seg.group.rotation.x = Math.PI / 2; // 下（-y）を向く
  seg.group.rotation.z = rotZ;        // 裏返したとき正立する向き
  const world = new THREE.Vector3(
    (b.min.x + b.max.x) / 2, b.min.y - 0.003, (b.min.z + b.max.z) / 2);
  seg.group.position.copy(node.worldToLocal(world));
  node.add(seg.group);
  window.__hidden.push(seg.group);
}

// レバー盤（表示3桁 + レバー3本）を作る。
// ローカル座標では壁が x=0 にあり +x（部屋側）を向く形で組み、
// wrapper の位置と回転で実際の壁に合わせる
function buildLeverPanel(pos, rotY) {
  const wrapper = new THREE.Group();
  wrapper.position.copy(pos);
  wrapper.rotation.y = rotY;
  scene.add(wrapper);

  const PITCH = 0.34; // 桁とレバーの間隔。指で隣を誤爆しない幅

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.5, PITCH * 3 + 0.22),
    new THREE.MeshLambertMaterial({ color: 0x4a5058 })
  );
  board.position.set(0, 1.55, 0);
  wrapper.add(board);
  raycastList.push(board);

  for (let i = 0; i < 3; i++) {
    // 正面から見て左→右の順（+x向きの面では左=+z）
    const z = PITCH - i * PITCH;

    const seg = makeSevenSeg(0.17, DEF.digitColors[i]);
    seg.set(state.dial[i]);
    seg.group.rotation.y = Math.PI / 2;
    seg.group.position.set(0.035, 1.55, z);
    wrapper.add(seg.group);
    dialSegs.push(seg);

    const lever = new THREE.Group();
    lever.userData.tag = 'lever';
    lever.userData.leverIndex = i;
    wrapper.add(lever);
    raycastList.push(lever);

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.34, 0.22),
      new THREE.MeshLambertMaterial({ color: 0x5a616a })
    );
    base.position.set(0.03, 1.05, z);
    lever.add(base);

    // 動かない当たり判定（腕は倒れる途中で位置が変わり、連打が空振りするため）
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.56, 0.3),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hit.position.set(0.12, 1.13, z);
    lever.add(hit);

    const pivot = new THREE.Group();
    pivot.position.set(0.08, 1.05, z);
    lever.add(pivot);
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.3, 0.05),
      new THREE.MeshLambertMaterial({ color: 0xb8412f })
    );
    arm.position.y = 0.15;
    pivot.add(arm);
    const knobBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 16, 12),
      new THREE.MeshLambertMaterial({ color: DEF.knobColors[i] })
    );
    knobBall.position.y = 0.3;
    pivot.add(knobBall);
    pivot.rotation.z = -0.6; // 待機位置: 部屋側へ突き出して上向き
    leverPivots.push(pivot);
  }
}

/* ---------------- モデル読み込み ---------------- */
const gltfLoader = new GLTFLoader();
gltfLoader.setMeshoptDecoder(MeshoptDecoder); // .min.glb の圧縮を解くデコーダ
gltfLoader.load(DEF.glb, (gltf) => {
  const root = new THREE.Group();
  root.scale.setScalar(DEF.scale);
  root.add(gltf.scene);
  scene.add(root);
  root.updateMatrixWorld(true);

  const box = (o) => new THREE.Box3().setFromObject(o); // ワールド座標

  const meshByName = {};
  gltf.scene.traverse((o) => { if (o.isMesh) meshByName[o.name] = o; });
  const nodeByName = (n) => gltf.scene.getObjectByName(n);

  // 部屋の範囲を床メッシュから取る（見つからなければ全体から）
  {
    const floorObj = meshByName[DEF.floorName] || nodeByName(DEF.floorName) || gltf.scene;
    const fb = box(floorObj);
    bounds = {
      x1: fb.min.x + PLAYER_R, x2: fb.max.x - PLAYER_R,
      z1: fb.min.z + PLAYER_R, z2: fb.max.z - PLAYER_R,
    };
    // 天井（どちらのモデルにも無いので1枚足す）
    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(fb.max.x - fb.min.x + 2, fb.max.z - fb.min.z + 2),
      new THREE.MeshLambertMaterial({ color: DEF.ceilColor })
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set((fb.min.x + fb.max.x) / 2, DEF.ceilY, (fb.min.z + fb.max.z) / 2);
    scene.add(ceil);
  }

  // 出口として動かすメッシュ（先に決めて、衝突判定から除外する）
  const doorMeshSet = new Set();

  // 家具・壁の衝突AABBと、タップ判定リストを組む（ドア決定後に呼ぶ）
  function buildColliders() {
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      raycastList.push(o);
      if (!DEF.colliders.test(o.name)) return;
      if (doorMeshSet.has(o)) return;
      const b = box(o);
      if (b.min.y > 1.4 || b.max.y < 0.25) return; // 頭上・床すれすれの物は無視
      const c = {
        x1: b.min.x - PLAYER_R, x2: b.max.x + PLAYER_R,
        z1: b.min.z - PLAYER_R, z2: b.max.z + PLAYER_R,
      };
      // 出口の通り道と重なる衝突箱（戸のレール等）は外す。
      // 通り道は正解までドア本体の位置クランプで塞がっている
      if (doorZone && doorZone.axis === 'z' &&
          c.x2 > doorZone.lat1 && c.x1 < doorZone.lat2 &&
          c.z2 > doorZone.bound - 0.1 && c.z1 < doorZone.out + 1.0) {
        return;
      }
      if (doorZone && doorZone.axis === 'x' &&
          c.z2 > doorZone.lat1 && c.z1 < doorZone.lat2 &&
          c.x1 < doorZone.bound + 0.1 && c.x2 > doorZone.out - 1.0) {
        return;
      }
      colliders.push(c);
    });
  }

  if (STAGE === 1) {
    /* ============ ステージ1: タピオカ店 ============ */

    // 運べる物: クッション10個とボトル5組
    for (let i = 1; i <= 10; i++) {
      const name = 'Cushion_' + String(i).padStart(2, '0');
      const m = meshByName[name] || nodeByName(name);
      if (m) registerCarry(m);
    }
    for (let i = 1; i <= 5; i++) {
      // 圧縮版はボトル1本が1ノードに統合されている。元データは2メッシュ
      const single = nodeByName(`Bottle_0${i}`);
      if (single) {
        single.name = 'BottleSet_' + i;
        registerCarry(single);
        continue;
      }
      const a = meshByName[`Bottle_0${i}_1`];
      const b2 = meshByName[`Bottle_0${i}_2`];
      if (!a || !b2) continue;
      const g = new THREE.Group();
      g.name = 'BottleSet_' + i;
      const cb = box(a).union(box(b2));
      const center = cb.getCenter(new THREE.Vector3());
      g.position.copy(gltf.scene.worldToLocal(center.clone()));
      gltf.scene.add(g);
      g.updateMatrixWorld(true);
      g.attach(a);
      g.attach(b2);
      registerCarry(g);
    }

    // 隠し数字（物の裏に刻む）。クッションはソファが東(+x)の壁際に
    // あるので、壁側=+x面に貼れば置いてある間は見えない
    root.updateMatrixWorld(true);
    const markCushion = (node, digit) => {
      const b = box(node);
      const scale = node.getWorldScale(new THREE.Vector3()).x || 1;
      const seg = makeSevenSeg(0.14 / scale, 0x2f2f2f);
      seg.set(digit);
      const world = new THREE.Vector3(
        b.max.x + 0.006, (b.min.y + b.max.y) / 2 + 0.02, (b.min.z + b.max.z) / 2);
      seg.group.position.copy(node.worldToLocal(world));
      const parentQ = node.getWorldQuaternion(new THREE.Quaternion());
      const wantQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), Math.PI / 2); // ワールドで+x向き
      seg.group.quaternion.copy(parentQ.clone().invert().multiply(wantQ));
      node.add(seg.group);
      window.__hidden.push(seg.group);
    };
    markCushion(carryables.get('Cushion_07').node, 4);
    markBottom(carryables.get('BottleSet_1').node, 7, 0xf2ede6);
    markCushion(carryables.get('Cushion_02').node, 2);

    // ドア（西壁）: 正解で横にスライドして開く
    doorParts = ['Door_Panel', 'Door_Glass', 'Door_Knob']
      .map((n) => meshByName[n] || nodeByName(n)).filter(Boolean);
    doorParts.forEach((m) => doorMeshSet.add(m));
    const db = doorParts.reduce((acc, m) => acc.union(box(m)), new THREE.Box3());
    doorZone = {
      axis: 'x', dir: -1,
      lat1: db.min.z - 0.1, lat2: db.max.z + 0.1,
      bound: db.max.x,            // 部屋側の面
      out: db.min.x - 0.6,        // ここを越えたらクリア
      slideAxis: 'z',
      slideBy: -(db.max.z - db.min.z) * 0.92 / DEF.scale,
    };
    // ドアの外の明るい面
    const outside = new THREE.Mesh(
      new THREE.PlaneGeometry(3.5, 3.4),
      new THREE.MeshBasicMaterial({ color: 0xf6f3ee })
    );
    outside.rotation.y = Math.PI / 2;
    outside.position.set(db.min.x - 1.3, 1.6, (db.min.z + db.max.z) / 2);
    scene.add(outside);

    buildLeverPanel(new THREE.Vector3(db.max.x + 0.02, 0, db.max.z + 1.0), 0);
  } else {
    /* ============ ステージ2: 塾の教室 ============ */

    // 運べる物: 本棚の本すべてと、机の上の鏡
    const books = [];
    gltf.scene.traverse((o) => { if (/^Book\d+$/.test(o.name)) books.push(o); });
    books.forEach((b) => registerCarry(b));
    const mirror = nodeByName('Mirror');
    if (mirror) registerCarry(mirror);

    // 当たりの1冊: 色は変えず、1冊だけ棚から数cm手前にはみ出させる
    // （気づいた人だけが引っかかる控えめな手がかり）。底に赤の「5」
    const redBook = nodeByName('Book005') || books[0];
    redBook.position.z -= 0.1; // 本棚の本は南(-z)向き。ローカルはscale 0.58分大きめに
    root.updateMatrixWorld(true);
    markBottom(redBook, 5, 0xd2413a, 0); // 本の底面は細長いので向きが90度違う

    // 黄の「3」: 鏡の裏
    if (mirror) {
      const mb = box(mirror);
      const scale = mirror.getWorldScale(new THREE.Vector3()).x || 1;
      const seg = makeSevenSeg(0.14 / scale, 0xe8b93c);
      seg.set(3);
      const world = new THREE.Vector3(
        mb.min.x - 0.004, (mb.min.y + mb.max.y) / 2 + 0.03, (mb.min.z + mb.max.z) / 2);
      seg.group.position.copy(mirror.worldToLocal(world));
      // 鏡のローカル軸は回転しているため、ワールドで「-x向き」になる姿勢を
      // 親の逆回転を掛けて求める
      const parentQ = mirror.getWorldQuaternion(new THREE.Quaternion());
      const wantQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), -Math.PI / 2);
      seg.group.quaternion.copy(parentQ.clone().invert().multiply(wantQ));
      mirror.add(seg.group);
      window.__hidden.push(seg.group);
    }

    // 青の「8」: 自習ブース Personal-Desk003 の机の上。
    // ブースに歩いて入らないと見えない
    {
      const booth = nodeByName('Personal-Desk003');
      const bb = box(booth);
      const cx = (bb.min.x + bb.max.x) / 2;
      const cz = (bb.min.z + bb.max.z) / 2;
      const down = new THREE.Raycaster(
        new THREE.Vector3(cx, bb.max.y - 0.05, cz), new THREE.Vector3(0, -1, 0));
      const hit = down.intersectObject(booth, true)[0];
      const surfaceY = hit ? hit.point.y : bb.min.y + 0.7;
      const seg = makeSevenSeg(0.14, 0x3465c9);
      seg.set(8);
      seg.group.rotation.x = -Math.PI / 2; // 上向き
      seg.group.position.set(cx, surfaceY + 0.01, cz);
      scene.add(seg.group);
      window.__hidden.push(seg.group);
    }

    // 出口: 引き戸の左（部屋の内側から見て東）にある入口の扉。
    // glTF出力で名前が重複しているため、名前ではなく位置でメッシュを選ぶ
    doorParts = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const b = box(o);
      const c = b.getCenter(new THREE.Vector3());
      if (c.x > -0.2 && c.x < 1.85 && c.z > 0.55 && c.z < 0.95 && b.max.y < 2.5) {
        // 幅2.05m超の部品はドア「枠」。枠は壁に残し、ガラス扉と取っ手だけを開く
        // （名前は圧縮で変わりうるので寸法で判別する）
        if (b.max.x - b.min.x > 2.05) return;
        doorParts.push(o);
        doorMeshSet.add(o);
      }
    });
    const db = doorParts.reduce((acc, m) => acc.union(box(m)), new THREE.Box3());
    // 蝶番: 取っ手の反対側（西端）に軸を立てて、外(+z)へ振り開く。
    // 取っ手のある側が大きく開く
    const hinge = new THREE.Group();
    hinge.position.copy(gltf.scene.worldToLocal(
      new THREE.Vector3(db.min.x, 0, (db.min.z + db.max.z) / 2)));
    gltf.scene.add(hinge);
    hinge.updateMatrixWorld(true);
    doorParts.forEach((m) => hinge.attach(m));
    doorZone = {
      axis: 'z', dir: 1,
      lat1: db.min.x + 0.05, lat2: db.max.x - 0.05,
      bound: db.min.z,            // 部屋側の面
      out: db.max.z + 0.5,        // ここを越えたらクリア
      mode: 'hinge',
      hinge,
      hingeAngle: -1.75,          // 約100度、外側へ（西端軸なので負方向）
    };
    // 戸の外の明るい面
    const outside = new THREE.Mesh(
      new THREE.PlaneGeometry(4.5, 2.6),
      new THREE.MeshBasicMaterial({ color: 0xf6f3ee })
    );
    outside.position.set((db.min.x + db.max.x) / 2, 1.2, db.max.z + 1.0);
    scene.add(outside);

    // レバー盤: 出口の扉のすぐ横（東側）の壁 立方体016 に付ける（-z向き = 部屋の内側）
    {
      const wallB = box(nodeByName('立方体016') || meshByName['立方体016'] || doorParts[0]);
      buildLeverPanel(
        new THREE.Vector3(2.75, 0, wallB.min.z - 0.02),
        Math.PI / 2
      );
    }
  }

  buildColliders();
  ready = true;
  window.__doorZone = doorZone; // 動作検証用
  window.__doorParts = doorParts.map((m) => m.name); // 動作検証用
  document.getElementById('loading').classList.add('hide');
  fadeEl.style.opacity = '0';
}, undefined, (err) => {
  document.getElementById('loading').textContent = '読み込みに失敗しました: ' + err;
});

/* ---------------- カメラ初期化 ---------------- */
let yaw = DEF.start.yaw;
let pitch = 0;
camera.position.set(DEF.start.x, EYE, DEF.start.z);
function applyCamera() {
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
}
applyCamera();

/* ---------------- 補間アニメーション ---------------- */
const tweens = [];
function tween(dur, onUpdate, onDone) {
  tweens.push({ t: 0, dur, onUpdate, onDone });
}
function easeInOut(k) {
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
}
function stepTweens(dt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    tw.t += dt;
    const k = Math.min(tw.t / tw.dur, 1);
    tw.onUpdate(easeInOut(k));
    if (k >= 1) {
      tweens.splice(i, 1);
      if (tw.onDone) tw.onDone();
    }
  }
}

/* ---------------- クリアとステージ遷移 ---------------- */
const clock = new THREE.Clock();
function fmt(sec) {
  return Math.floor(sec / 60) + '分' + String(sec % 60).padStart(2, '0') + '秒';
}
function makeButton(label, primary, onTap) {
  const b = document.createElement('button');
  b.textContent = label;
  if (primary) b.className = 'primary';
  b.addEventListener('click', onTap);
  return b;
}
function clearGame() {
  if (state.cleared) return;
  state.cleared = true;
  const sec = Math.round(clock.elapsedTime);
  const title = document.getElementById('clear-title');
  const time = document.getElementById('clear-time');
  const btns = document.getElementById('clear-buttons');
  title.textContent = DEF.clearTitle;
  btns.innerHTML = '';

  if (STAGE === 1) {
    time.textContent = fmt(sec);
    btns.appendChild(makeButton('次のステージへ', true, () => {
      fadeEl.style.opacity = '1';
      setTimeout(() => { location.href = 'tapi.html?stage=2&t=' + sec; }, 350);
    }));
    btns.appendChild(makeButton('ここで終わる', false, () => {
      title.textContent = 'プレイ終了';
      time.textContent = fmt(sec);
      btns.innerHTML = '';
      btns.appendChild(makeButton('最初から遊ぶ', true, () => {
        location.href = 'tapi.html';
      }));
    }));
  } else {
    time.textContent =
      '全ステージクリア\nステージ2 ' + fmt(sec) +
      (PREV_SEC ? ' ／ 合計 ' + fmt(PREV_SEC + sec) : '');
    btns.appendChild(makeButton('最初から遊ぶ', true, () => {
      location.href = 'tapi.html';
    }));
  }
  document.getElementById('clear').classList.add('show');
}

/* ---------------- レバー: 1回押すと対応する桁が1つ進む ---------------- */
function pressLever(i) {
  const pivot = leverPivots[i];
  if (!pivot || state.solved) return;
  // 数字は押した瞬間に進める（アニメ待ちにすると連打の取りこぼしが起きる）
  state.dial[i] = (state.dial[i] + 1) % 10;
  dialSegs[i].set(state.dial[i]);
  checkSolved();
  // レバーの振りは飾り。動作中の連打では振り直さない
  if (!leverBusy[i]) {
    leverBusy[i] = true;
    const rest = -0.6, down = -2.0;
    tween(0.12, (k) => { pivot.rotation.z = rest + (down - rest) * k; }, () => {
      tween(0.14, (k) => { pivot.rotation.z = down + (rest - down) * k; }, () => {
        leverBusy[i] = false;
      });
    });
  }
}

function checkSolved() {
  if (state.solved) return;
  const c = DEF.correct;
  if (state.dial[0] === c[0] && state.dial[1] === c[1] && state.dial[2] === c[2]) {
    state.solved = true;
    if (doorZone.mode === 'hinge') {
      // 蝶番で外へ振り開く
      tween(1.2, (k) => {
        doorZone.hinge.rotation.y = doorZone.hingeAngle * k;
      });
    } else {
      // 横にスライドして開く
      const parts = doorParts.map((m) => ({
        m, from: m.position[doorZone.slideAxis],
      }));
      tween(1.2, (k) => {
        for (const p of parts) p.m.position[doorZone.slideAxis] = p.from + doorZone.slideBy * k;
      });
    }
  }
}

/* ---------------- タップ判定 ---------------- */
const raycaster = new THREE.Raycaster();
// 触れる距離より遠くは判定しない。メッシュ数の多い部屋（教室は1776個）でも
// 境界球の足切りが効いてタップ判定が軽くなる
raycaster.far = PLACE_DIST + 1.5;
const ndc = new THREE.Vector2();
function pick(clientX, clientY, excludeNode) {
  // 描画フレームを待たずに正しい位置関係で判定する
  camera.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);
  ndc.set((clientX / viewW) * 2 - 1, -(clientY / viewH) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(raycastList, true);
  for (const h of hits) {
    let tagged = null;
    let inExcluded = false;
    let p = h.object;
    while (p) {
      if (excludeNode && p === excludeNode) inExcluded = true;
      if (!tagged && p.userData && p.userData.tag) tagged = p;
      p = p.parent;
    }
    if (inExcluded) continue;
    return { hit: h, tagged, tag: tagged ? tagged.userData.tag : null, node: tagged };
  }
  return null;
}
window.__pick = pick; // 動作検証用
window.__cam = camera; // 動作検証用
window.__pos = () => camera.position.toArray();
window.__setView = (x, y, z, yw, pt) => { // 動作検証用
  camera.position.set(x, y, z);
  yaw = yw;
  pitch = pt;
  applyCamera();
};

const upNormal = new THREE.Vector3();
function handleTap(x, y) {
  if (!ready || state.cleared) return;
  if (state.inspecting) return; // 観察中は「もどる」を押すまで置けない
  const heldEntry = state.holding ? carryables.get(state.holding) : null;
  const res = pick(x, y, heldEntry ? heldEntry.node : null);
  if (!res) return;

  if (state.holding) {
    // 置く: 上を向いた面を近距離でタップしたときだけ
    if (res.hit.distance > PLACE_DIST) return;
    upNormal.copy(res.hit.face.normal).transformDirection(res.hit.object.matrixWorld);
    if (upNormal.y < 0.6) return;
    const entry = carryables.get(state.holding);
    const node = entry.node;
    const target = res.hit.point.clone();
    target.y += 0.005;
    const parent = node.parent;
    const local = parent.worldToLocal(target.clone());
    const fromLocal = node.position.clone();
    const fromQuat = node.quaternion.clone();
    const scl = new THREE.Vector3();
    parent.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scl);
    local.y += entry.offsetY / scl.y;
    tween(0.2, (k) => {
      node.position.lerpVectors(fromLocal, local, k);
      node.quaternion.slerpQuaternions(fromQuat, entry.quat0, k); // 元の向きに戻す
    });
    state.holding = null;
    return;
  }

  if (res.tag === 'lever') {
    if (res.hit.distance <= PLACE_DIST) pressLever(res.node.userData.leverIndex);
    return;
  }
  if (res.tag === 'carry') {
    if (res.hit.distance <= PLACE_DIST) {
      state.holding = res.node.name;
      updateHoldDist();
    }
  }
}

/* ---------------- ポインタ操作（視点ドラッグ + タップ） ---------------- */
const pointer = { id: null, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false };
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (state.cleared) return;
  if (pointer.id !== null) return;
  pointer.id = e.pointerId;
  pointer.startX = pointer.lastX = e.clientX;
  pointer.startY = pointer.lastY = e.clientY;
  pointer.moved = false;
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch (err) { /* 継続 */ }
});
const rotTmp = new THREE.Vector3();
const rotQ = new THREE.Quaternion();
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.pointerId !== pointer.id) return;
  const dx = e.clientX - pointer.lastX;
  const dy = e.clientY - pointer.lastY;
  pointer.lastX = e.clientX;
  pointer.lastY = e.clientY;
  if (Math.abs(e.clientX - pointer.startX) + Math.abs(e.clientY - pointer.startY) > 10) {
    pointer.moved = true;
  }
  if (state.inspecting && state.holding) {
    // 観察中: ドラッグで持ち物を回す（画面幅いっぱいで360度）
    const entry = carryables.get(state.holding);
    const k = (2 * Math.PI) / viewW;
    const up = rotTmp.set(0, 1, 0).applyQuaternion(camera.quaternion).clone();
    const right = rotTmp.set(1, 0, 0).applyQuaternion(camera.quaternion).clone();
    entry.node.quaternion.premultiply(rotQ.setFromAxisAngle(up, dx * k));
    entry.node.quaternion.premultiply(rotQ.setFromAxisAngle(right, dy * k));
    return;
  }
  // 視点: スワイプした方向に視点が動く（左スワイプ→左を向く）
  yaw -= (dx / viewW) * Math.PI;
  pitch -= (dy / viewW) * Math.PI;
  pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  applyCamera();
});
function endPointer(e) {
  if (e.pointerId !== pointer.id) return;
  const wasTap = !pointer.moved;
  pointer.id = null;
  if (wasTap) handleTap(pointer.startX, pointer.startY);
}
renderer.domElement.addEventListener('pointerup', endPointer);
renderer.domElement.addEventListener('pointercancel', endPointer);
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);

/* ---------------- 「詳細を見る」ボタン ---------------- */
const inspectBtn = document.getElementById('inspect');
let holdDist = 1.1;     // 通常の保持距離（前方に棚があれば詰める）
let inspectDist = 0.85; // 観察中の保持距離
// 目の前に棚や壁があるときは、その手前まで保持位置を詰める
// （持った物が家具の中に埋まって見えなくなるのを防ぐ）
function updateHoldDist() {
  const entry = state.holding ? carryables.get(state.holding) : null;
  const res = pick(viewW / 2, viewH / 2, entry ? entry.node : null);
  const free = res ? res.hit.distance : 99;
  holdDist = Math.min(HOLD_DIST, Math.max(0.45, free - 0.55));
  inspectDist = Math.min(0.85, Math.max(0.4, free - 0.55));
}
inspectBtn.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  e.preventDefault();
  if (!state.holding || state.cleared) return;
  state.inspecting = !state.inspecting;
  if (state.inspecting) updateHoldDist();
});
function syncInspectUI() {
  const show = !!state.holding && !state.cleared;
  const label = state.inspecting ? 'もどる' : '詳細を見る';
  if (inspectBtn.style.display !== (show ? 'block' : 'none')) {
    inspectBtn.style.display = show ? 'block' : 'none';
  }
  if (inspectBtn.textContent !== label) inspectBtn.textContent = label;
  if (!state.holding) state.inspecting = false;
  const pad = document.getElementById('dpad');
  const padDisplay = state.inspecting ? 'none' : 'block';
  if (pad.style.display !== padDisplay) pad.style.display = padDisplay;
}

/* ---------------- 十字パッド ---------------- */
const padVec = { x: 0, y: 0 };
{
  const pad = document.getElementById('dpad');
  const knob = document.getElementById('dpad-knob');
  let padId = null;
  const PAD_MAX = 42;
  const updatePad = (e) => {
    const r = pad.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > PAD_MAX) { dx *= PAD_MAX / len; dy *= PAD_MAX / len; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    padVec.x = Math.abs(dx) < 6 ? 0 : dx / PAD_MAX;
    padVec.y = Math.abs(dy) < 6 ? 0 : dy / PAD_MAX;
  };
  const resetPad = () => {
    padId = null;
    padVec.x = 0;
    padVec.y = 0;
    knob.style.transform = '';
  };
  pad.addEventListener('pointerdown', (e) => {
    if (padId !== null || state.cleared) return;
    padId = e.pointerId;
    try { pad.setPointerCapture(e.pointerId); } catch (err) { /* 継続 */ }
    updatePad(e);
  });
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === padId) updatePad(e); });
  pad.addEventListener('pointerup', (e) => { if (e.pointerId === padId) resetPad(); });
  pad.addEventListener('pointercancel', (e) => { if (e.pointerId === padId) resetPad(); });
}

/* ---------------- 移動と衝突 ---------------- */
function collideMove(nx, nz) {
  if (doorZone && doorZone.axis === 'x') {
    // ステージ1: 西壁のドア
    const through = state.solved && nz > doorZone.lat1 && nz < doorZone.lat2;
    nx = Math.max(through ? doorZone.out - 1.0 : bounds.x1, Math.min(bounds.x2, nx));
    nz = Math.max(bounds.z1, Math.min(bounds.z2, nz));
  } else if (doorZone) {
    // ステージ2: 入口の引き戸（+z側）
    const through = state.solved && nx > doorZone.lat1 && nx < doorZone.lat2;
    nx = Math.max(bounds.x1, Math.min(bounds.x2, nx));
    nz = Math.max(bounds.z1,
      Math.min(through ? doorZone.out + 1.0 : Math.min(bounds.z2, doorZone.bound - PLAYER_R), nz));
  } else {
    nx = Math.max(bounds.x1, Math.min(bounds.x2, nx));
    nz = Math.max(bounds.z1, Math.min(bounds.z2, nz));
  }
  for (const c of colliders) {
    if (nx > c.x1 && nx < c.x2 && nz > c.z1 && nz < c.z2) {
      const pen = [nx - c.x1, c.x2 - nx, nz - c.z1, c.z2 - nz];
      const m = Math.min(...pen);
      if (m === pen[0]) nx = c.x1;
      else if (m === pen[1]) nx = c.x2;
      else if (m === pen[2]) nz = c.z1;
      else nz = c.z2;
    }
  }
  return [nx, nz];
}

/* ---------------- fps計測（?fps=1のときだけ表示） ---------------- */
let fpsFrames = 0, fpsTime = 0, fpsWarmup = 3;
window.__fps = 0;
window.__fpsMin = Infinity;
const fpsEl = (() => {
  if (!params.has('fps')) return null;
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;top:4px;left:4px;padding:2px 6px;background:rgba(0,0,0,.5);' +
    'color:#0f0;font:12px monospace;pointer-events:none;z-index:10;';
  document.body.appendChild(el);
  return el;
})();
function stepFps(dt) {
  fpsFrames++;
  fpsTime += dt;
  if (fpsWarmup > 0) fpsWarmup -= dt;
  if (fpsTime >= 1) {
    window.__fps = Math.round(fpsFrames / fpsTime);
    if (fpsWarmup <= 0 && window.__fps < window.__fpsMin) window.__fpsMin = window.__fps;
    fpsFrames = 0;
    fpsTime = 0;
    if (fpsEl) {
      fpsEl.textContent = window.__fps + ' fps (min ' +
        (window.__fpsMin === Infinity ? '-' : window.__fpsMin) + ')';
    }
  }
}

/* ---------------- メインループ ---------------- */
const walkFwd = new THREE.Vector3();
const holdTarget = new THREE.Vector3();
function loop() {
  requestAnimationFrame(loop);
  if (window.innerWidth && (window.innerWidth !== viewW || window.innerHeight !== viewH)) {
    onResize();
  }
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);

  stepFps(rawDt);
  stepTweens(dt);

  if (ready && !state.cleared && (padVec.x !== 0 || padVec.y !== 0)) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const step = WALK_SPEED * dt;
    let nx = camera.position.x + (fx * -padVec.y + -fz * padVec.x) * step;
    let nz = camera.position.z + (fz * -padVec.y + fx * padVec.x) * step;
    [nx, nz] = collideMove(nx, nz);
    camera.position.x = nx;
    camera.position.z = nz;
    // 開いた出口を歩いて通り抜けたらクリア
    if (state.solved && doorZone) {
      if (doorZone.axis === 'x' && nx < doorZone.out) clearGame();
      if (doorZone.axis === 'z' && nz > doorZone.out) clearGame();
    }
  }

  // 持っている物はカメラ前に追従。観察中は画面中央・やや近めに寄せる
  if (ready && state.holding) {
    const entry = carryables.get(state.holding);
    camera.getWorldDirection(walkFwd);
    if (state.inspecting) {
      holdTarget.copy(camera.position).addScaledVector(walkFwd, inspectDist);
    } else {
      holdTarget.copy(camera.position).addScaledVector(walkFwd, holdDist);
      holdTarget.y -= 0.35 * (holdDist / HOLD_DIST); // 下げて視界を確保
    }
    const parent = entry.node.parent;
    const local = parent.worldToLocal(holdTarget.clone());
    entry.node.position.lerp(local, 1 - Math.exp(-12 * dt));
  }
  syncInspectUI();

  renderer.render(scene, camera);
}
loop();
