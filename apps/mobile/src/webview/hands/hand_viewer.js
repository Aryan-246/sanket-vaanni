/**
 * Sanket Vaanni — shared 3D hand viewer core (Three.js r128).
 *
 * One implementation, used by `viewer_left.html`, `viewer_right.html`,
 * `viewer_both.html` and `viewer.html`. Those files do nothing but declare which
 * side they render; all behaviour lives here, so the four entry points cannot
 * drift apart the way they previously did.
 *
 * ## Why the framing does not use `Box3.setFromObject`
 *
 * The rigged GLB is authored in Blender centimetres and its mesh node carries a
 * 0.01 scale, while the skeleton is in metres. `Box3.setFromObject()` transforms
 * the *bind-pose geometry* by that node matrix, so a 24 cm hand measures 2.4 mm
 * — a factor of 100 wrong. The previous viewer framed from that box, put the
 * camera 5.7 mm from the model, and rendered nothing: the black viewport.
 *
 * `Box3.setFromObject` is also blind to skinning. The vertices that actually
 * reach the screen are the *skinned* ones, so this file measures them by
 * skinning every vertex on the CPU (`SkinnedMesh.boneTransform`) and taking the
 * world-space bounds of the result. That is the only box that matches the pixels.
 *
 * Bone positions are not a substitute either: the rig carries both arms' bones
 * (45 joints) while a single-hand GLB skins only one hand, so a bone-derived
 * centre lands ~0.27 m away from the mesh.
 *
 * ## Why `frustumCulled = false`
 *
 * A `SkinnedMesh`'s bounding sphere is computed from the bind pose and is
 * therefore ~100x too small here. With culling enabled the hand can be discarded
 * entirely before it is ever drawn, which produces a blank panel at some camera
 * angles and not others — an intermittent black viewport.
 *
 * ## Transparency
 *
 * The renderer is created with `alpha: true` and a zero-alpha clear colour, no
 * `scene.background` is set, and the page background is transparent, so the RN
 * card behind the WebView shows through. The hand materials stay opaque: only
 * the background is transparent.
 *
 * @see apps/mobile/src/hands/pose.ts for the `HandPose` contract.
 */
(function () {
  'use strict';

  var RAD = Math.PI / 180;
  var FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];

  // --- which side this instance renders ------------------------------------
  var params = new URLSearchParams(window.location.search);
  var declared = String(window.SANKET_HAND_SIDE || params.get('side') || 'left').toLowerCase();
  var activeSide = declared === 'right' ? 'right' : declared === 'both' ? 'both' : 'left';

  // Measured-pose limits. Bends are 0 = extended, 1 = fully flexed, so a ratio
  // above 1 is a saturated reading rather than a request to bend past the joint.
  var BEND_MIN = -0.2;
  var BEND_MAX = 1.2;

  // Joint distribution, in degrees, from a single finger-bend measurement.
  // A real flex sensor reports one number per digit; these ratios spread that
  // number across the chain. They are estimates, not measurements, and are kept
  // in one place so they can be recalibrated against a physical glove.
  var CHAIN_DEG = {
    finger: { 1: 62, 2: 78, 3: 66, 4: 44 }, // MCP, PIP, DIP, distal
    thumb: { 1: 40, 2: 50, 3: 46, 4: 34 },
  };
  var THUMB_OPPOSITION_DEG = 26;

  // The MPU6050 gives wrist tilt only, already in radians. Yaw is not
  // measurable and is never synthesised here.
  var WRIST_PITCH_LIMIT = 1.4;
  var WRIST_ROLL_LIMIT = 1.6;

  var scene = null;
  var camera = null;
  var renderer = null;
  var controls = null;
  var pivot = null;
  var currentModel = null;
  var bonesMap = {};
  /**
   * The rotation every bone is authored with, captured once when the model
   * loads.
   *
   * The rig ships wearing a natural relaxed hand, so a bend ratio has to be an
   * *offset* from that pose rather than a replacement for it. Writing the
   * rotation outright threw the rig's own curl away, so a bend of 0 forced
   * every finger straight and fanned the hand wide — the opposite of the
   * relaxed hand the resting pose is documented to show. On the palm-facing
   * viewer that straightened palm then presented a broad flat surface to the
   * cool fill light, which is what read as a blue bruise across the fingers.
   */
  var restRotations = {};
  var isLoaded = false;
  var pendingPose = null;
  var frameDistance = 1;
  var started = false;
  var probe = params.get('probe') === '1';

  /*
   * Render-loop state.
   *
   * The loop used to be unconditional: an infinite `requestAnimationFrame`
   * chain that called `renderer.render` 60 times a second from the moment the
   * page loaded until it was destroyed. That is the right cost while the hand
   * is on screen and pure waste the moment it is not.
   *
   * The app unmounts the WebView when the user leaves the Dashboard, so a tab
   * change destroys the whole page. What survives is the *backgrounded* app,
   * where the page is kept alive and nobody can see it — measured on the real
   * page in Chrome at 393x851, counting GPU draw calls: 60 per second while
   * visible, and 60 per second with the document marked hidden.
   *
   * The loop is now derived from two inputs — the host's instruction and the
   * document's own visibility — and `needsRender` keeps a pose that arrives
   * while it is stopped from being lost.
   */
  var loopRunning = false;
  var needsRender = false;
  /** Last instruction from the host app; see `syncLoop`. */
  var hostActive = true;

  // Resolved in `init`, not here: this file is loaded from <head>, so at
  // execution time the document body (and these elements) may not exist yet.
  var container = null;
  var canvas = null;
  var overlay = null;
  var overlayText = null;

  /** Report a state change back to React Native, if we are inside a WebView. */
  function notifyRN(data) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(data));
      }
    } catch (e) {
      /* the bridge is best-effort; never let it break rendering */
    }
  }

  function showOverlay(message, tone) {
    if (!overlay) return;
    overlay.style.display = 'flex';
    overlay.style.opacity = '1';
    overlay.classList.remove('is-hidden');
    if (tone) overlay.setAttribute('data-tone', tone);
    if (overlayText) overlayText.textContent = message;
  }

  function hideOverlay() {
    if (!overlay) return;
    overlay.classList.add('is-hidden');
    window.setTimeout(function () {
      if (overlay) overlay.style.display = 'none';
    }, 300);
  }

  // --- numeric hygiene ------------------------------------------------------

  /** Clamp a bend ratio; anything non-finite reads as "no bend reported". */
  function sanitizeBend(value) {
    if (typeof value !== 'number' || !isFinite(value)) return 0;
    return Math.max(BEND_MIN, Math.min(BEND_MAX, value));
  }

  /**
   * The rotation the rig is authored with, or zeros for a bone outside it.
   *
   * Every angle in `applySidePose` is applied as `rest + delta`, so a reading of
   * zero means "leave this joint as the rig has it" rather than "straighten
   * it".
   */
  function restOf(bone) {
    var rest = bone ? restRotations[bone.name] : null;
    return rest || { x: 0, y: 0, z: 0 };
  }

  /** Clamp a wrist angle that is already in radians; `null` means unmeasurable. */
  function sanitizeAngle(value, limit) {
    if (typeof value !== 'number' || !isFinite(value)) return 0;
    return Math.max(-limit, Math.min(limit, value));
  }

  // --- geometry measurement -------------------------------------------------

  /**
   * World-space bounds of what a `SkinnedMesh` actually draws.
   *
   * Skins every vertex on the CPU and transforms it into world space. This is
   * the only measurement that reflects the rendered silhouette: it is immune to
   * the node's cm/m scale, to the unused bones of the opposite arm, and to the
   * bind-pose bounding sphere.
   */
  function skinnedBox(root) {
    var box = new THREE.Box3();
    var vertex = new THREE.Vector3();
    root.updateMatrixWorld(true);
    root.traverse(function (child) {
      if (!child.isSkinnedMesh || !child.geometry || !child.geometry.attributes.position) return;
      if (child.skeleton && child.skeleton.update) child.skeleton.update();
      var position = child.geometry.attributes.position;
      for (var i = 0; i < position.count; i++) {
        try {
          child.boneTransform(i, vertex);
        } catch (e) {
          continue;
        }
        vertex.applyMatrix4(child.matrixWorld);
        if (isFinite(vertex.x) && isFinite(vertex.y) && isFinite(vertex.z)) {
          box.expandByPoint(vertex);
        }
      }
    });
    return box;
  }

  /** Fallback for a non-skinned mesh: the plain geometry box in world space. */
  function staticBox(root) {
    var box = new THREE.Box3();
    var skinned = 0;
    root.updateMatrixWorld(true);
    root.traverse(function (child) {
      if (child.isSkinnedMesh) {
        skinned++;
        return;
      }
      if (child.isMesh && child.geometry) {
        child.geometry.computeBoundingBox();
        if (child.geometry.boundingBox) {
          box.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
        }
      }
    });
    return skinned > 0 ? skinnedBox(root) : box;
  }

  // --- framing --------------------------------------------------------------

  /**
   * Frame the model in the pivot, using the true rendered bounds.
   *
   * Fits on **both** axes. A vertical-only fit is correct for one hand but crops
   * a two-hand layout entirely, because two hands are far wider than they are
   * tall; taking `max(fitVertical, fitHorizontal)` frames either shape.
   */
  function frameModel() {
    var width = container.clientWidth || window.innerWidth || 300;
    var height = container.clientHeight || window.innerHeight || 300;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    var box = staticBox(pivot);
    if (box.isEmpty()) return;

    var size = box.getSize(new THREE.Vector3());
    var centre = box.getCenter(new THREE.Vector3());

    // Recentre on the pivot so rotation happens about the hand, not the origin.
    // Incremental, not absolute: this runs again on every resize, and an
    // absolute assignment would undo the earlier offset (the box measures ~0
    // once centred, so `= -centre` would put the model back where it started).
    pivot.position.sub(centre);
    pivot.updateMatrixWorld(true);

    var halfFovTan = Math.tan((camera.fov * RAD) / 2);
    var fitVertical = size.y / 2 / halfFovTan;
    var fitHorizontal = size.x / 2 / (halfFovTan * camera.aspect);
    // 1.12 leaves a margin so fingertips never touch the viewport edge while
    // still letting the hand read as the centrepiece of the card.
    var distance = Math.max(fitVertical, fitHorizontal) * 1.12 + size.z / 2;

    frameDistance = distance;
    camera.position.set(0, 0, distance);
    camera.near = Math.max(distance / 100, 0.001);
    camera.far = distance * 40;
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);

    if (controls) {
      // Keep the model as the visual centrepiece: allow close inspection but
      // never so far that the hand becomes a speck.
      controls.minDistance = distance * 0.45;
      controls.maxDistance = distance * 1.9;
      controls.target.set(0, 0, 0);
      controls.update();
    }

    notifyRN({
      type: 'framed',
      side: activeSide,
      distance: Math.round(distance * 1000) / 1000,
      size: [round4(size.x), round4(size.y), round4(size.z)],
    });
  }

  function round4(v) {
    return Math.round(v * 10000) / 10000;
  }

  // --- pose -----------------------------------------------------------------

  /**
   * Drive one hand.
   *
   * `prefix` is the rig's own naming (`J_Left_Hand` / `J_Right_Hand`), so the
   * bones resolved here are the real ones in the GLB.
   */
  function applySidePose(prefix, isLeft, fingers, wrist) {
    var bends = fingers && fingers.length ? fingers : [];

    // --- wrist: rotation is already in radians, apply it directly ----------
    var wristBone = bonesMap[prefix];
    if (wristBone) {
      var w = wrist || {};
      // `pitch`/`roll` are radians and are null when no glove reports them.
      var wristRest = restOf(wristBone);
      wristBone.rotation.x = wristRest.x + sanitizeAngle(w.pitch, WRIST_PITCH_LIMIT);
      wristBone.rotation.z =
        wristRest.z + (isLeft ? 1 : -1) * sanitizeAngle(w.roll, WRIST_ROLL_LIMIT);
    }

    // --- thumb: flexion plus opposition across the palm -------------------
    var thumb = sanitizeBend(bends[0]);
    for (var t = 1; t <= 4; t++) {
      var thumbBone = bonesMap[prefix + 'Thumb' + t];
      if (!thumbBone) continue;
      thumbBone.rotation.x = restOf(thumbBone).x + thumb * CHAIN_DEG.thumb[t] * RAD;
    }
    var thumbBase = bonesMap[prefix + 'Thumb1'];
    if (thumbBase) {
      thumbBase.rotation.y =
        restOf(thumbBase).y + (isLeft ? 1 : -1) * thumb * THUMB_OPPOSITION_DEG * RAD;
    }

    // --- four fingers, each chain driven independently --------------------
    for (var f = 0; f < FINGERS.length; f++) {
      var bend = sanitizeBend(bends[f + 1]);
      for (var j = 1; j <= 4; j++) {
        var bone = bonesMap[prefix + FINGERS[f] + j];
        if (!bone) continue;
        bone.rotation.x = restOf(bone).x + bend * CHAIN_DEG.finger[j] * RAD;
      }
    }
  }

  function applyPose(pose) {
    if (!isLoaded || !currentModel) {
      pendingPose = pose; // replayed once the model arrives
      return;
    }
    if (!pose) return;

    if (activeSide === 'both') {
      // A two-hand GLB carries both rigs; each is driven by its own pose.
      var left = pose.left || pose;
      var right = pose.right || pose;
      applySidePose('J_Left_Hand', true, left && left.fingers, left && left.wrist);
      applySidePose('J_Right_Hand', false, right && right.fingers, right && right.wrist);
    } else {
      var isLeft = activeSide === 'left';
      applySidePose(isLeft ? 'J_Left_Hand' : 'J_Right_Hand', isLeft, pose.fingers, pose.wrist);
    }

    if (pivot) pivot.updateMatrixWorld(true);

    /*
     * A pose that lands while the loop is stopped still has to reach the
     * screen. The bones are already updated above; this only records that the
     * canvas is now one frame behind, so resuming draws immediately instead of
     * showing whatever was on it when it was paused.
     */
    if (!loopRunning) needsRender = true;
  }

  // --- diagnostics ----------------------------------------------------------

  /** Replace the spinner with a readable failure state instead of a blank panel. */
  function showFailure(headline, detail) {
    if (!overlay) return;
    overlay.style.display = 'flex';
    overlay.style.opacity = '1';
    overlay.setAttribute('data-tone', 'error');
    overlay.innerHTML =
      '<div class="overlay-inner">' +
      '<div class="overlay-title">' +
      headline +
      '</div>' +
      '<div class="overlay-detail">' +
      detail +
      '</div>' +
      '</div>';
  }

  // --- lifecycle ------------------------------------------------------------

  function init() {
    if (started) return; // never run two render loops in one page
    started = true;

    // Optional card-matching background. True transparency is the default and
    // is what the app uses; if a device's WebView will not composite a
    // transparent WebGL layer, `?bg=card&c=%23RRGGBB` paints the card's own
    // colour instead — a clean match, never a black box.
    if (params.get('bg') === 'card') {
      var colour = params.get('c') || '#0B132B';
      document.documentElement.style.background = colour;
      document.body.style.background = colour;
    }

    container = document.getElementById('viewport');
    canvas = document.getElementById('canvas3d');
    overlay = document.getElementById('loading');
    overlayText = document.getElementById('loading-text');

    if (!container || !canvas) {
      // Nothing to draw into — say so rather than failing silently.
      notifyRN({ type: 'error', side: activeSide, error: 'viewer DOM missing' });
      return;
    }

    var width = container.clientWidth || window.innerWidth || 300;
    var height = container.clientHeight || window.innerHeight || 300;

    scene = new THREE.Scene();
    // No `scene.background`: the card behind the WebView supplies the surface.
    // An opaque background here is what produced the black rectangle.

    camera = new THREE.PerspectiveCamera(38, width / height, 0.01, 100);
    camera.position.set(0, 0, 1);

    pivot = new THREE.Group();
    scene.add(pivot);

    renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: probe,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0); // fully transparent clear
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    if (THREE.OrbitControls) {
      controls = new THREE.OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enablePan = false;
      controls.rotateSpeed = 0.55;
      controls.zoomSpeed = 0.7;
      controls.target.set(0, 0, 0);
    }

    // Three-point studio lighting: a neutral key so the skin reads correctly,
    // a cool fill for the app's palette, and a rim to separate the hand from
    // whatever surface it is composited over.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x141e33, 1.5));

    var key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(1.4, 2.6, 3.4);
    scene.add(key);

    var fill = new THREE.DirectionalLight(0x38bdf8, 1.15);
    fill.position.set(-2.4, 0.4, 2.0);
    scene.add(fill);

    var rim = new THREE.DirectionalLight(0x60a5fa, 0.85);
    rim.position.set(0, -2.4, -2.0);
    scene.add(rim);

    window.addEventListener('resize', onResize);
    loadModel();
    syncLoop();

    if (probe) {
      // Read-only hooks used by the automated pixel/fit checks. Harmless in
      // production because `probe` is only true with an explicit query flag.
      window.__rig = {
        bones: bonesMap,
        scene: scene,
        camera: camera,
        pivot: pivot,
        renderer: renderer,
        loaded: function () {
          return isLoaded;
        },
        side: activeSide,
        frameDistance: function () {
          return frameDistance;
        },
        /** Re-frame at the element's current size (used by the fit checks). */
        reframe: function () {
          frameModel();
        },
        /** Resize the drawing buffer to match a test viewport. */
        resizeTo: function (w, h) {
          renderer.setSize(w, h, false);
          frameModel();
        },
      };
    }
  }

  var resizeTimer = null;
  function onResize() {
    // Android fires several resizes while the WebView settles; coalesce them,
    // then re-frame, because the framing distance depends on the aspect ratio.
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      var width = container.clientWidth || window.innerWidth;
      var height = container.clientHeight || window.innerHeight;
      if (!width || !height || !renderer || !camera) return;
      renderer.setSize(width, height, false);
      if (isLoaded) frameModel();
    }, 120);
  }

  function loadModel() {
    var file = 'sanket_vaani_' + activeSide + '.glb';
    showOverlay('Loading 3D hand…', 'loading');

    new THREE.GLTFLoader().load(
      file,
      function (gltf) {
        try {
          onModelLoaded(gltf);
        } catch (err) {
          console.error('[hand_viewer] post-load failure', err);
          showFailure('3D hand could not be prepared', String(err && err.message ? err.message : err));
          notifyRN({ type: 'error', side: activeSide, error: String(err) });
        }
      },
      undefined,
      function (err) {
        console.error('[hand_viewer] GLB load failed', file, err);
        showFailure(
          '3D hand asset not available',
          'Could not read ' + file + ' from the app bundle.',
        );
        notifyRN({
          type: 'error',
          side: activeSide,
          error: String((err && err.message) || err || 'load failed'),
        });
      },
    );
  }

  function onModelLoaded(gltf) {
    currentModel = gltf.scene;

    // Clear in place rather than rebinding: `bonesMap` is published to the
    // diagnostics hooks, and reassigning it would leave those holding a stale
    // empty object.
    for (var key in bonesMap) {
      if (Object.prototype.hasOwnProperty.call(bonesMap, key)) delete bonesMap[key];
    }
    // Recaptured from the bind pose of the model about to be traversed, so a
    // reload cannot carry the previous model's rotations over as if they were
    // authored.
    restRotations = {};

    currentModel.traverse(function (child) {
      if (child.isBone) {
        bonesMap[child.name] = child;
        bonesMap[child.name.replace(/\./g, '')] = child;
        // Read before any pose is applied, and never overwritten by one.
        restRotations[child.name] = {
          x: child.rotation.x,
          y: child.rotation.y,
          z: child.rotation.z,
        };
      }
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
        // The bind-pose bounding sphere is ~100x too small for a SkinnedMesh
        // here, so culling can drop the hand before it is drawn.
        if (child.isSkinnedMesh) child.frustumCulled = false;
        if (child.material) {
          // Skin stays opaque and lit; only the background is transparent.
          child.material.transparent = false;
          child.material.opacity = 1;
          child.material.depthWrite = true;
          child.material.side = THREE.DoubleSide;
          child.material.roughness = 0.55;
          child.material.metalness = 0.05;
          child.material.needsUpdate = true;
        }
      }
    });

    // Orient so the fingers point up and the palm faces the viewer. The mesh
    // hangs down -Y with the wrist at the top, so a half-turn about X stands it
    // up; the yaw below turns the palm to the camera.
    //
    // The yaw is the whole difference between a legible hand and a silhouette of
    // one edge. This model is built lying along X — the palm normal points along
    // the *X* axis — so a yaw near zero looks straight down the flat of the hand
    // and stacks the fingers behind each other. Measured at the size the app
    // actually renders (161x217 inside a dashboard card), the silhouette went
    // from 29.2% of the viewport width at a small yaw to 75.8% at a quarter
    // turn, and only at the quarter turn are the five digits separately
    // visible. `Math.PI / 2` is exactly palm-on; the 0.15 rad pulls it back to a
    // shallow three-quarter so the hand still reads as a solid object with
    // depth rather than a flat cut-out.
    //
    // The yaw has to be *mirrored* for the left hand, because the two rigs
    // present mirrored hands. Their model-space palm normals, measured from the
    // bind pose as (index MCP - wrist) x (pinky MCP - wrist) and signed by the
    // direction the fingers curl, are
    //
    //     left   [-0.9483, -0.0969, 0.3021]
    //     right  [+0.9483, -0.0969, 0.3021]   -- the exact X mirror
    //
    // (The bone *local rest rotations* are identical in the two files; it is the
    // hand geometry that is a mirror pair, and each file binds the shared mesh
    // to its own chain.) So a single shared yaw turns the right palm towards the
    // viewer and the left palm away from it: it rendered the left hand's dorsal
    // side. That was the reported defect, and the false premise behind it was
    // assuming mirrored models need one shared turn.
    //
    // Measured through the live rig, palm normals in world space:
    //
    //     right hand, shared yaw   (+1.4208)  ->  z = +0.8977   palm
    //     left hand,  shared yaw   (+1.4208)  ->  z = -0.9642   BACK   <- defect
    //     left hand,  mirrored yaw (-1.4208)  ->  z = +0.8977   palm
    //
    // The mirrored result is the exact X mirror of the right hand's,
    // (-0.4404, -0.0107, +0.8977) against (0.4405, -0.0107, +0.8977), and the
    // resting tilt comes out mirrored too: -7.24 degrees on the left against
    // +7.23 on the right.
    //
    // Viewing the other face of a hand reverses the apparent direction of every
    // rotation whose axis lies in the screen plane, so this flip also reverses
    // the left hand's wrist pitch and finger curls: pitch reads -10.94 degrees
    // against the right hand's +10.88, and each finger bend mirrors its opposite
    // number to within 0.0007. Both were *wrong* before the flip -- with the
    // shared yaw the left hand's pitch ran +14.54 degrees, the same direction as
    // the right instead of the opposite one. The wrist roll is the one channel
    // that still does not mirror (left -45.50 against right -49.23, both the
    // same way), because it is the one channel `applySidePose` multiplies by
    // `(isLeft ? 1 : -1)`; see the note there.
    var yaw = Math.PI / 2 - 0.15;
    pivot.add(currentModel);
    pivot.rotation.set(Math.PI + 0.12, activeSide === 'left' ? -yaw : yaw, 0);
    pivot.updateMatrixWorld(true);

    frameModel();

    isLoaded = true;
    hideOverlay();
    notifyRN({ type: 'loaded', side: activeSide });

    if (pendingPose) {
      var replay = pendingPose;
      pendingPose = null;
      applyPose(replay);
    }
  }

  /** One frame of the loop. Draws only when the viewer is meant to be live. */
  function animate() {
    if (!loopRunning) return;
    window.requestAnimationFrame(animate);
    draw();
  }

  /** Renders one frame if the scene is up; safe to call at any time. */
  function draw() {
    if (controls) controls.update();
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
      needsRender = false;
    }
  }

  /**
   * Starts or stops the render loop, from the two inputs that decide it.
   *
   * Stopping is the point: an off-screen viewer that keeps drawing burns the
   * GPU and the WebView's renderer thread for a surface nobody can see, which
   * is felt as lag in the app in front of it.
   *
   * Both inputs are consulted every time rather than being folded into a single
   * flag by the caller, because they arrive independently and either one alone
   * is enough to make drawing pointless: the host knows about tabs and screens,
   * and the document knows when the platform has hidden the WebView. Deriving
   * the state here also means the answer cannot depend on which event happened
   * to arrive first — a page that initialises while it is already hidden, or is
   * told to stop before it has finished loading, both end up in the same place.
   *
   * Restarting is deliberately cheap and idempotent, because these fire more
   * than once for a single transition.
   */
  function syncLoop() {
    var active = hostActive && !document.hidden;
    if (active === loopRunning) {
      if (active && needsRender) draw();
      return;
    }
    loopRunning = active;
    if (active) {
      // Draw before the first frame lands, so a viewer that was paused with a
      // stale frame does not show it for one more tick.
      if (needsRender) draw();
      window.requestAnimationFrame(animate);
    }
  }

  // --- public API -----------------------------------------------------------

  /**
   * Lets the host app pause a viewer it has navigated away from.
   *
   * Visibility alone is not enough: a tab that is mounted but behind another
   * one, or a viewer scrolled out of the viewport, is still "visible" to the
   * document while being invisible to the user. React Native knows about those
   * cases and the page does not, so the decision is left to the caller that has
   * the full picture.
   */
  window.setViewerActive = function (active) {
    hostActive = !!active;
    syncLoop();
  };

  window.updatePose = function (poseData) {
    if (typeof poseData === 'string') {
      try {
        poseData = JSON.parse(poseData);
      } catch (e) {
        return;
      }
    }
    applyPose(poseData);
  };

  function handleMessage(event) {
    var msg = event.data;
    if (typeof msg === 'string') {
      try {
        msg = JSON.parse(msg);
      } catch (e) {
        return;
      }
    }
    if (msg && msg.type === 'updatePose' && msg.pose) applyPose(msg.pose);
  }

  window.addEventListener('message', handleMessage);
  document.addEventListener('message', handleMessage);

  /*
   * The document's own visibility, which the platform drives when the app goes
   * to the background or the WebView is detached. This is the page's own
   * signal, independent of the host, so it covers the cases React Native
   * cannot see — a system dialog, the app switcher, the screen locking.
   */
  document.addEventListener('visibilitychange', function () {
    syncLoop();
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    window.setTimeout(init, 0);
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();
