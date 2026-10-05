// Based on the free-pose editor of ComfyUI-Fisher-Pose (MIT, (c) 2026 Work-Fisher); see LICENSE and THIRD_PARTY_NOTICES.md.
// Free-pose editor: one VNCCS MakeHuman mannequin. Editing uses a free orbit view;
// the output is always the VNCCS front capture (yaw 0 / pitch 0, white background,
// flat white ambient light), which is what the VNCCS_QI2_PoseStudio LoRA was trained on.
import { PoseViewerCore } from '../vnccs/vnccs_pose_studio_core.mjs';
import { loadMorphPack, solveMorph, buildStaticModelData } from '../vnccs/vnccs_pose_morph_runtime.mjs';
import { HAND_PRESETS } from '../vnccs/vnccs_hand_presets.mjs';
import { parseXyz, applyFlips, toWorldKeypoints, exportXyz } from './xyz-pose.mjs';
import { t, applyI18n } from './i18n.mjs';

applyI18n();

const $ = selector => document.querySelector(selector);
// "qwen" mode (HMQwenFreePoseXYZ node) adds the extra prompt and the person image; the XYZ pose editor node leaves them out.
const qwenMode = new URLSearchParams(location.search).get('mode') === 'qwen';
for (const element of document.querySelectorAll('.qwen-only')) element.hidden = !qwenMode;
const INSTRUCTION = 'Draw character from image2';
let extraPrompt = '';
const promptText = () => [INSTRUCTION, ...extraPrompt.split('\n').map(line => line.trim())].filter(Boolean).join('\n');
const embedded = new URLSearchParams(location.search).has('embedded');
const FRONT = { yaw: 0, pitch: 0 };
const CAPTURE_BACKGROUND = [255, 255, 255];
const CAPTURE_LIGHTS = [{ type: 'ambient', color: '#ffffff', intensity: 1.0 }];
const DEFAULT_MESH = { age: 25, gender: 0.5, weight: 0.5, muscle: 0.5, height: 0.5, breast_size: 0, firmness: 0.5, show_genitals: false };
const BODY_SLIDERS = [
    ['gender', t('fp.body.gender'), 0, 1, 0.01], ['age', t('fp.body.age'), 1, 90, 1], ['height', t('fp.body.height'), 0, 1, 0.01],
    ['weight', t('fp.body.weight'), 0, 1, 0.01], ['muscle', t('fp.body.muscle'), 0, 1, 0.01],
];
const NEUTRAL_TRANSFORM = { x: 0, y: 0, z: 0, zoom: 1 };
// Head / neck / torso / limb proportions as scale factors (1 = MakeHuman default).
const PROPORTIONS = [
    ['head', t('fp.prop.head'), 0.75, 1.3], ['neck', t('fp.prop.neck'), 0.5, 2],
    ['shoulder', t('fp.prop.shoulder'), 0.7, 1.4], ['spine', t('fp.prop.spine'), 0.7, 1.4],
    ['upper_arm', t('fp.prop.upper_arm'), 0.6, 1.6], ['forearm', t('fp.prop.forearm'), 0.6, 1.6],
    ['thigh', t('fp.prop.thigh'), 0.6, 1.6], ['shin', t('fp.prop.shin'), 0.6, 1.6],
];
const DEFAULT_PROPORTIONS = Object.fromEntries(PROPORTIONS.map(([key]) => [key, 1]));
// VNCCS bone-length groups (both sides together); the core maps a group value v to scale 0.5 + v.
const PROPORTION_GROUPS = {
    shoulder: ['shoulder_l', 'shoulder_r'], spine: ['spine'],
    upper_arm: ['upper_arm_l', 'upper_arm_r'], forearm: ['forearm_l', 'forearm_r'],
    thigh: ['thigh_l', 'thigh_r'], shin: ['shin_l', 'shin_r'],
};
// Our 2D joint names → MakeHuman bones whose head sits on that joint.
const JOINT_BONES = { ls: 'upperarm_l', le: 'lowerarm_l', lw: 'hand_l', rs: 'upperarm_r', re: 'lowerarm_r', rw: 'hand_r', lh: 'thigh_l', lk: 'calf_l', la: 'foot_l', rh: 'thigh_r', rk: 'calf_r', ra: 'foot_r' };
// The MakeHuman body pack ships uncompressed: cloud drives (网盘) delete archive files such as the
// upstream .bin.gz, which left the editor stuck on loading. The .gz is only a fallback for old copies;
// the VNCCS loader accepts both (it checks the gzip magic bytes).
const BODY_PACK_URLS = ['pose_studio_makehuman.v2.bin', 'pose_studio_makehuman.v2.bin.gz'].map(name => new URL(`../vnccs/assets/${name}`, import.meta.url));

async function loadBodyPack() {
    for (const url of BODY_PACK_URLS) {
        try { return await loadMorphPack(url); } catch { /* missing or truncated: try the next copy */ }
    }
    throw new Error(t('fp.err.bodyPack'));
}

let doc = { mesh: { ...DEFAULT_MESH }, proportions: { ...DEFAULT_PROPORTIONS }, pose: null, transform: { ...NEUTRAL_TRANSFORM }, width: 1024, height: 1024, xyz: null };
let pack = null;
let ready = false;
let selectedBoneName = null;
let previewTimer = null;
let morphTimer = null;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round16 = value => clamp(Math.round(value / 16) * 16, 64, 4096);

function toast(text, duration = 2400) {
    const element = $('#toast');
    element.textContent = text;
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove("show"), duration);
}

const canvas = $('#viewport-canvas');
const stage = $('#stage');
canvas.width = stage.clientWidth || 800;
canvas.height = stage.clientHeight || 600;
const viewer = new PoseViewerCore(canvas, {
    skinMode: 'naked',
    enableTextureSkinning: true,
    showSkeletonHelper: true,
    showCaptureFrame: true,
    syncMode: 'end',
    useHandControlPopover: false,
    captureHistoryContext: () => ({ transform: { ...doc.transform } }),
    onHistoryRestore: pose => {
        if (pose.editorState) {
            doc.transform = { ...pose.editorState.transform };
            viewer.setActiveCharacterAppearance({ transform: doc.transform });
            updateCamera(false);
        }
        refreshControls();
    },
    onBoneSelectionChange: ({ boneName }) => { selectedBoneName = boneName; refreshBoneSliders(); },
    onPoseChange: () => { refreshControls(); schedulePreview(); },
});
viewer.maxHistory = 60; // match the studio editor; VNCCS keeps only 10

function modelData(morph, staticData) {
    const bones = staticData.bones.map((bone, index) => {
        const headPos = Array.from(morph.bonePositions.subarray(index * 6, index * 6 + 3));
        const tailPos = Array.from(morph.bonePositions.subarray(index * 6 + 3, index * 6 + 6));
        return { name: bone.name, parent: bone.parent || null, headPos, tailPos, length: Math.hypot(...tailPos.map((v, i) => v - headPos[i])) };
    });
    return {
        vertices: morph.vertices, uvs: staticData.uvs, indices: staticData.indices, bones,
        skinIndices: staticData.skinIndices, skinWeights: staticData.skinWeights,
        landmarks: morph.landmarks || {}, landmark_indices: morph.landmarkIndices || {},
    };
}

// Absolute IK positions depend on bone lengths, so a body-shape change keeps only rotations.
function rotationsOnly(pose) {
    const { bonePositions, ikEffectorPositions, poleTargetPositions, hipBonePosition, camera, cameraParams, ...rest } = pose || {};
    return rest;
}

function savedPose() {
    const { camera, cameraParams, ...pose } = viewer.getPose();
    return pose;
}

// The core has no neck group, so the neck scales the head bone's offset from neck_01
// the same way its limb groups scale child offsets, and caches it as the new rest.
function applyNeck() {
    viewer._setBoneOffsetScale('head', doc.proportions.neck);
    for (const bone of viewer.boneList) bone.updateMatrixWorld(true);
    viewer.skeleton?.update();
    viewer._cacheShapedRestBonePositions(['head']);
    viewer.updateIKEffectorPositions?.();
    viewer.requestRender();
}

function setProportion(key, value) {
    doc.proportions = { ...doc.proportions, [key]: value };
    if (key === 'head') viewer.updateHeadScale(value);
    else if (key === 'neck') applyNeck();
    else for (const group of PROPORTION_GROUPS[key]) viewer.updateBoneLengthScale(group, value - 0.5);
}

// resetPose() restores the core's own groups but not our neck offset.
function resetPose() {
    viewer.resetPose();
    applyNeck();
}

function loadModel(pose) {
    const morph = solveMorph(pack, doc.mesh);
    viewer.setSkinMode('naked');
    // loadData() applies these cached scales while it builds the new rig.
    viewer.headScale = doc.proportions.head;
    viewer.boneLengthParams = {
        ...viewer.boneLengthParams,
        ...Object.fromEntries(Object.entries(PROPORTION_GROUPS).flatMap(([key, groups]) => groups.map(group => [group, doc.proportions[key] - 0.5]))),
    };
    viewer.loadData(modelData(morph, buildStaticModelData(pack, morph.includeGenitals)), true);
    applyNeck();
    viewer.updateLights(CAPTURE_LIGHTS);
    if (pose) viewer.setPose(pose, true);
    viewer.setActiveCharacterAppearance({ color: '#ffffff', transform: doc.transform });
}

// The capture camera never moves; `snap` also brings the free editing view back to it.
function updateCamera(snap) {
    const args = [doc.width, doc.height, 1, 0, 0, FRONT.yaw, FRONT.pitch];
    if (snap) viewer.snapToCaptureCamera(...args);
    else viewer.updateCaptureCamera(...args);
    refreshControls();
    schedulePreview();
}

function fitFrame(snap = false) {
    viewer.setActiveCharacterAppearance({ transform: NEUTRAL_TRANSFORM });
    const framing = viewer.computeModelFitFraming(doc.width, doc.height, FRONT.yaw, FRONT.pitch, 0.08);
    const pivot = viewer.sceneCameraTarget;
    if (framing && pivot) {
        const zoom = framing.zoom;
        doc.transform = {
            x: clamp((1 - zoom) * pivot.x + zoom * framing.offsetX, -50, 50),
            y: clamp((1 - zoom) * pivot.y + zoom * framing.offsetY, -50, 50),
            z: clamp((1 - zoom) * pivot.z, -40, 40),
            zoom,
        };
    }
    viewer.setActiveCharacterAppearance({ transform: doc.transform });
    updateCamera(snap);
}

function capture(width, height) {
    viewer.updateLights(CAPTURE_LIGHTS);
    return viewer.capture(width, height, 1, CAPTURE_BACKGROUND, 0, 0, FRONT.yaw, FRONT.pitch);
}

function schedulePreview() {
    if (!ready) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
        await viewer.waitForCaptureReady();
        const scale = Math.min(1, 480 / Math.max(doc.width, doc.height));
        const url = capture(Math.round(doc.width * scale), Math.round(doc.height * scale));
        if (url) { $('#capture-preview').src = url; $('#inset-preview').src = url; }
    }, 300);
}

// --- Unsaved edits ---------------------------------------------------------------
// The pose counts as saved once it is loaded, applied to the node or saved (XYZ file, download, My Poses).
// Edits since then are found by comparing the state, not by tracking events.
const round4 = (key, value) => (typeof value === 'number' ? Math.round(value * 1e4) / 1e4 : value);
function stateSignature(ignoreRoll = false) {  // flips keep the roll, so it does not count as an edit of the imported pose
    const pose = savedPose();
    if (ignoreRoll && pose.modelRotation) pose.modelRotation = [pose.modelRotation[0], pose.modelRotation[1], 0];
    return JSON.stringify({ mesh: doc.mesh, proportions: doc.proportions, transform: doc.transform, width: doc.width, height: doc.height,
        pose, grips: [$('#grip-l').value, $('#grip-r').value], extraPrompt }, round4);
}
let savedSignature = '';     // state at the last load / apply / save
let importedSignature = '';  // state right after the last import from XYZ data (flips redo the import)
const markSaved = () => { savedSignature = stateSignature(); };
const markImported = () => { savedSignature = stateSignature(); importedSignature = stateSignature(true); };
const confirmDiscard = (messageKey, since, ignoreRoll = false) => !ready || stateSignature(ignoreRoll) === since || confirm(t(messageKey));

// --- XYZ pose source -----------------------------------------------------------
// The XYZ joints (from the 360-Orbit Pose Estimation node or a saved file) are imported through the VNCCS
// world-keypoint path; flips act on the source joints, then the pose is imported again.

const XYZ_URL = '/orbit360/xyz_files';
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const worldOf = name => viewer.bones[name].getWorldPosition(new viewer.THREE.Vector3()).toArray();
const mid3 = (a, b) => a.map((v, i) => (v + b[i]) / 2);
const dist3 = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const MANNEQUIN_BONES = { left_shoulder: 'upperarm_l', left_elbow: 'lowerarm_l', left_wrist: 'hand_l', right_shoulder: 'upperarm_r', right_elbow: 'lowerarm_r',
    right_wrist: 'hand_r', left_hip: 'thigh_l', left_knee: 'calf_l', left_ankle: 'foot_l', right_hip: 'thigh_r', right_knee: 'calf_r', right_ankle: 'foot_r', head: 'head', pelvis: 'pelvis' };

function mannequinWorld() {
    const world = Object.fromEntries(Object.entries(MANNEQUIN_BONES).map(([key, bone]) => [key, worldOf(bone)]));
    world.neck = mid3(world.left_shoulder, world.right_shoulder);
    return world;
}

function applyXyz(keepRoll = false) {
    const { joints, flips } = doc.xyz;
    const roll = viewer.modelRotation.z;  // the import starts from an upright mannequin
    viewer.recordState();
    doc.transform = { ...NEUTRAL_TRANSFORM };
    viewer.setActiveCharacterAppearance({ transform: doc.transform });
    resetPose();
    viewer.skinnedMesh.updateMatrixWorld(true);
    const rest = mannequinWorld();
    const hipMid = mid3(rest.left_hip, rest.right_hip);
    const world = toWorldKeypoints(applyFlips(joints, flips), { anchor: rest.pelvis, torso: dist3(rest.neck, hipMid), headDistance: dist3(rest.head, rest.neck) });
    const THREE = viewer.THREE;
    const worldKps = Object.fromEntries(Object.entries(world).map(([key, value]) => [key, new THREE.Vector3(...value)]));
    // Hip sockets, head, hands and feet are not estimated reliably; keep the mannequin's own.
    viewer.applyWorldKeypointImport(worldKps, { drawFigure: false, placeHipRoots: false, alignHead: false, alignHands: false, alignFeet: false, dispatchPoseChange: false });
    if (keepRoll) viewer.setModelRotation(undefined, undefined, roll);  // flips redo the import but keep the roll
    fitFrame(true);
    refreshFlips();
    importedSignature = stateSignature(true);
}

function currentXyz() {
    const mesh = viewer.skinnedMesh;
    const roll = mesh.rotation.z;
    mesh.rotation.z = 0;
    mesh.updateMatrixWorld(true);
    try {
        return exportXyz(mannequinWorld(), { meta: { source: 'orbit360-editor', name: doc.xyz?.name || '' } });
    } finally {
        mesh.rotation.z = roll;
        mesh.updateMatrixWorld(true);
    }
}

function loadXyzText(text, name) {
    try {
        const { joints, meta } = parseXyz(text);
        doc.xyz = { name, joints, flips: {}, meta };
        applyXyz();
        markSaved();
        const failed = meta.estimated === false;
        $('#xyz-status').textContent = t('xyz.loaded', { name }) + (failed ? t('xyz.defaultPose') : '');
        const lying = joints.neck[1] - joints.pelvis[1] < 0.15;  // the import assumes a (roughly) standing person
        if (lying && !failed) $('#xyz-status').textContent += t('xyz.notUpright');
        $('#xyz-status').classList.toggle('fp-warn', failed || lying);
        if (failed) toast(t("xyz.failedToast"), 7000);
        else if (lying) toast(t('xyz.notUprightToast'), 7000);
        return true;
    } catch (error) {
        $('#xyz-status').textContent = t('xyz.loadFailed', { name, error: error.message });
        return false;
    }
}

function refreshFlips() {
    $('#depth-section').hidden = !doc.xyz;
    const flips = doc.xyz?.flips || {};
    for (const button of document.querySelectorAll('[data-flip]')) button.classList.toggle('on', Boolean(flips[button.dataset.flip]));
}

for (const button of document.querySelectorAll('[data-flip]')) {
    button.onclick = () => {
        if (!doc.xyz || !confirmDiscard('xyz.unsavedFlipConfirm', importedSignature, true)) return;
        const key = button.dataset.flip;
        doc.xyz.flips = { ...doc.xyz.flips, [key]: !doc.xyz.flips[key] };
        applyXyz(true);
    };
}

// The list shows one folder of output/orbit_pose; xyzPath is the chain of folder names below it.
let xyzFiles = [];
let xyzFolders = [];
let xyzPath = [];
const xyzQuery = () => '?path=' + encodeURIComponent(xyzPath.join('/'));
function folderRow(label, onOpen) {
    const button = document.createElement('button');
    button.className = 'fp-file fp-folder';
    button.textContent = label;
    button.onclick = onOpen;
    return button;
}
function renderXyzFiles() {
    const container = $('#xyz-files');
    $('#xyz-path').textContent = ['orbit_pose', ...xyzPath].join(' / ');
    const rows = [];
    if (xyzPath.length) rows.push(folderRow(t('xyz.folderUp'), () => { xyzPath = xyzPath.slice(0, -1); loadXyzList(); }));
    for (const name of xyzFolders) rows.push(folderRow('📁 ' + name, () => { xyzPath = [...xyzPath, name]; loadXyzList(); }));
    if (!xyzFiles.length && !rows.length) { container.innerHTML = `<p class="muted">${t('xyz.noFiles')}</p>`; return; }
    container.replaceChildren(...rows, ...xyzFiles.map(entry => {
        const button = document.createElement('button');
        button.className = 'fp-file' + (doc.xyz?.name === entry.name ? ' active' : '');
        button.textContent = entry.name;
        button.title = new Date(entry.savedAt).toLocaleString();
        button.onclick = async () => {
            if (!confirmDiscard('xyz.unsavedConfirm', savedSignature)) return;
            try {
                const response = await fetch(`${XYZ_URL}/${encodeURIComponent(entry.name)}${xyzQuery()}`, { cache: 'no-store' });
                if (!response.ok) throw Error(String(response.status));
                viewer.recordState();
                loadXyzText(await response.text(), entry.name);
                renderXyzFiles();
            } catch (error) { toast(t('xyz.loadFailed', { name: entry.name, error: error.message })); }
        };
        return button;
    }));
}

async function loadXyzList() {
    try {
        let response = await fetch(XYZ_URL + xyzQuery(), { cache: 'no-store' });
        if (!response.ok && xyzPath.length) {  // the folder is gone: back to the top
            xyzPath = [];
            response = await fetch(XYZ_URL + xyzQuery(), { cache: 'no-store' });
        }
        if (response.ok) {
            const list = await response.json();
            xyzFiles = list.files ?? [];
            xyzFolders = list.folders ?? [];
            xyzPath = list.path ? list.path.split('/') : [];
            if (list.folders === undefined) $('#xyz-status').textContent = t('xyz.restartServer');  // the server predates the folder list
        }
    } catch { /* standalone preview without the ComfyUI server */ }
    renderXyzFiles();
}
$('#refresh-xyz').onclick = loadXyzList;

async function openLocalXyz(files) {
    const file = files[0];
    if (!file || !confirmDiscard('xyz.unsavedConfirm', savedSignature)) return;
    viewer.recordState();
    loadXyzText(await file.text(), file.name.replace(/\.json$/i, ''));
    renderXyzFiles();
}
const xyzPicker = $('#pick-xyz');
xyzPicker.addEventListener('change', () => { openLocalXyz(xyzPicker.files); xyzPicker.value = ''; });
// Inside the ComfyUI modal the host page opens the picker (same as the Fisher editor).
xyzPicker.addEventListener('click', event => {
    const chooseInHost = window.frameElement?.fisherChooseFiles;
    if (!chooseInHost) return;
    event.preventDefault();
    try { chooseInHost(openLocalXyz, { json: true }); } catch { toast(t('xyz.pickerFailed')); }
});

let upstreamXyz = '';
$('#load-upstream').onclick = () => { if (!confirmDiscard('xyz.unsavedConfirm', savedSignature)) return; viewer.recordState(); loadXyzText(upstreamXyz, t('xyz.upstreamName')); renderXyzFiles(); };

const defaultXyzName = () => doc.xyz?.name?.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'pose';
async function saveXyzFile() {
    if (!ready) return;
    const name = prompt(t('xyz.namePrompt'), defaultXyzName())?.trim();
    if (!name) return;
    const record = currentXyz();
    try {
        let response = await postJson(XYZ_URL, { name, record, overwrite: false, path: xyzPath.join('/') });
        if (response.status === 409) {
            if (!confirm(t('fp.confirmOverwrite', { name }))) return;
            response = await postJson(XYZ_URL, { name, record, overwrite: true, path: xyzPath.join('/') });
        }
        const result = await response.json();
        if (!response.ok) { toast(result.error || t('fp.saveFailed')); return; }
        await loadXyzList();
        toast(t('xyz.savedFile', { name: result.name }));
        markSaved();
    } catch { toast(t('fp.saveOffline')); }
}
$('#save-xyz').onclick = saveXyzFile;
$('#download-xyz').onclick = () => {
    if (!ready) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(currentXyz(), null, 1)], { type: 'application/json' }));
    link.download = defaultXyzName() + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    markSaved();
};

// --- 我的姿势: whole editor states saved on the server (see saved_poses.py) ---

const SAVED_URL = '/orbit360/saved_poses';
let savedPoses = [];
let savedAvailable = false;
let activeSavedName = null;

function renderSaved() {
    const container = $('#saved-poses');
    $('#save-pose').disabled = !savedAvailable;
    $('#saved-count').textContent = savedPoses.length ? t('fp.savedCount', { n: savedPoses.length }) : '';
    if (!savedAvailable) { container.innerHTML = `<p class="muted">${t('fp.savedNeedsComfy')}</p>`; return; }
    if (!savedPoses.length) { container.innerHTML = `<p class="muted">${t('fp.savedEmpty')}</p>`; return; }
    container.replaceChildren(...savedPoses.map(entry => {
        const button = document.createElement('button');
        button.className = 'fp-thumb' + (entry.name === activeSavedName ? ' active' : '');
        button.title = `${entry.name}\n${t('fp.clickToLoad')}`;
        button.innerHTML = `<img alt=""><span></span><i class="fp-delete" title="${t('common.delete')}">×</i>`;
        button.querySelector('img').src = entry.thumbnail;
        button.querySelector('span').textContent = entry.name;
        button.onclick = event => (event.target.closest('.fp-delete') ? deleteSavedPose(entry) : loadSavedPose(entry));
        return button;
    }));
}

async function loadSavedList() {
    try {
        const response = await fetch(SAVED_URL, { cache: 'no-store' });
        if (response.ok) {
            savedPoses = (await response.json()).poses;
            savedAvailable = true;
        }
    } catch { /* standalone preview without the ComfyUI server */ }
    renderSaved();
}

// Named after the OpenPose image it came from when there is one, else 姿势 N; never an existing name.
function defaultPoseName() {
    const taken = new Set(savedPoses.map(entry => entry.name));
    const base = doc.xyz?.name ? doc.xyz.name.replace(/[\\/:*?"<>|]/g, ' ').trim() : t('fp.defaultPoseName');
    if (doc.xyz?.name && !taken.has(base)) return base;
    for (let n = savedPoses.length + 1; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

const postPose = (name, record, overwrite) => fetch(SAVED_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, record, overwrite }),
});

async function saveCurrentPose(presetName) {
    if (!savedAvailable || !ready) return;
    const name = (typeof presetName === 'string' ? presetName : prompt(t('fp.namePrompt'), defaultPoseName()))?.trim();
    if (!name) return;
    await viewer.waitForCaptureReady();
    const scale = 256 / Math.max(doc.width, doc.height);
    const thumbnail = capture(Math.round(doc.width * scale), Math.round(doc.height * scale));
    updateCamera(false);
    const record = {
        version: 1, thumbnail,
        doc: { ...doc, pose: savedPose() },
        grips: { l: Number($('#grip-l').value), r: Number($('#grip-r').value) },
    };
    try {
        let response = await postPose(name, record, false);
        if (response.status === 409) {
            if (!confirm(t('fp.confirmOverwrite', { name }))) return;
            response = await postPose(name, record, true);
        }
        const result = await response.json();
        if (!response.ok) { toast(result.error || t('fp.saveFailed')); return; }
        activeSavedName = result.name;
        await loadSavedList();
        toast(t('fp.saved', { name: result.name }));
        markSaved();
    } catch { toast(t('fp.saveOffline')); }
}

async function loadSavedPose(entry) {
    if (!confirmDiscard('xyz.unsavedConfirm', savedSignature)) return;
    try {
        const response = await fetch(`${SAVED_URL}/${encodeURIComponent(entry.name)}`, { cache: 'no-store' });
        if (!response.ok) { toast(t('fp.poseGone')); await loadSavedList(); return; }
        const record = await response.json();
        viewer.recordState();
        doc = docFrom(record.doc);
        loadModel(doc.pose);
        for (const side of ['l', 'r']) $(`#grip-${side}`).value = record.grips?.[side] ?? 0;
        updateCamera(true);
        refreshFlips();
        activeSavedName = entry.name;
        renderSaved();
        markImported();
        $('#import-status').textContent = t('fp.loaded', { name: entry.name });
    } catch (error) { toast(t('fp.loadFailed', { error: error.message })); }
}

async function deleteSavedPose(entry, skipConfirm = false) {
    if (!skipConfirm && !confirm(t('fp.confirmDelete', { name: entry.name }))) return;
    try {
        await fetch(`${SAVED_URL}/${encodeURIComponent(entry.name)}/delete`, { method: 'POST' });
        if (activeSavedName === entry.name) activeSavedName = null;
        await loadSavedList();
        toast(t('fp.deleted', { name: entry.name }));
    } catch { toast(t('fp.deleteOffline')); }
}

$('#save-pose').onclick = () => saveCurrentPose();

// --- Viewport interaction: our editor's feel on top of the VNCCS core -------

function setupInteraction() {
    const THREE = viewer.THREE;
    viewer.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    // Shift+drag moves the person inside the front frame; it must pre-empt orbit and bone picking.
    canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !event.shiftKey || !ready) return;
        event.stopImmediatePropagation();
        event.preventDefault();
        viewer.recordState();
        const camera = viewer.camera;
        const distance = camera.position.distanceTo(viewer.orbit.target);
        const perPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (canvas.clientHeight * camera.zoom);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        const start = { x: event.clientX, y: event.clientY, transform: { ...doc.transform } };
        const move = moveEvent => {
            const delta = right.clone().multiplyScalar((moveEvent.clientX - start.x) * perPixel)
                .add(up.clone().multiplyScalar(-(moveEvent.clientY - start.y) * perPixel));
            doc.transform = { ...start.transform, x: clamp(start.transform.x + delta.x, -50, 50), y: clamp(start.transform.y + delta.y, -50, 50) };
            viewer.setActiveCharacterAppearance({ transform: doc.transform });
            refreshControls();
        };
        const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); schedulePreview(); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end);
    }, { capture: true });
    // Runs after the core's own handler: if it grabbed a joint, the drag must not also orbit.
    canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        if (viewer.directDrag?.active || viewer.selectedBone || viewer.selectedIKEffector || viewer.selectedPoleTarget || viewer.transform?.dragging) {
            viewer.orbit.enabled = false;
            window.addEventListener('pointerup', () => { viewer.orbit.enabled = true; }, { once: true });
        }
    });
}

// --- Controls ---------------------------------------------------------------

const setOutput = (id, text) => { $(`#${id}-value`).textContent = text; };

function refreshBoneSliders() {
    const bone = selectedBoneName && viewer.bones?.[selectedBoneName];
    $('#bone-name').textContent = bone ? selectedBoneName : t('fp.noneSelected');
    $('#bone-sliders').classList.toggle('fp-disabled', !bone);
    for (const axis of ['x', 'y', 'z']) {
        const degrees = bone ? Math.round(bone.rotation[axis] * 180 / Math.PI) : 0;
        $(`#r${axis}`).value = degrees;
        setOutput(`r${axis}`, bone ? `${degrees}°` : '—');
    }
}

function refreshControls() {
    $('#zoom').value = doc.transform.zoom; setOutput('zoom', doc.transform.zoom.toFixed(2));
    $('#tx').value = doc.transform.x; setOutput('tx', doc.transform.x.toFixed(1));
    $('#ty').value = doc.transform.y; setOutput('ty', doc.transform.y.toFixed(1));
    const turn = Math.round(viewer.modelRotation?.y || 0);
    $('#turn').value = turn; setOutput('turn', `${turn}°`);
    const roll = Math.round(viewer.modelRotation?.z || 0);
    $('#roll').value = roll; setOutput('roll', `${roll}°`);
    $('#output-width').value = doc.width;
    $('#output-height').value = doc.height;
    $('#preview-size').textContent = `${doc.width}×${doc.height}`;
    for (const button of document.querySelectorAll('#ratios button')) {
        const [a, b] = button.dataset.ratio.split(':').map(Number);
        button.classList.toggle('active', Math.abs(doc.width / doc.height - a / b) < 0.02);
    }
    for (const [key] of BODY_SLIDERS) {
        const input = $(`#body-${key}`);
        if (input) { input.value = doc.mesh[key]; setOutput(`body-${key}`, key === 'age' ? String(doc.mesh[key]) : Number(doc.mesh[key]).toFixed(2)); }
    }
    for (const side of ['l', 'r']) setOutput(`grip-${side}`, Number($(`#grip-${side}`).value).toFixed(2));
    for (const [key] of PROPORTIONS) {
        const input = $(`#prop-${key}`);
        if (input) { input.value = doc.proportions[key]; setOutput(`prop-${key}`, `${Math.round(doc.proportions[key] * 100)}%`); }
    }
    $('#description').textContent = promptText();
    refreshBoneSliders();
}

// One undo entry per slider gesture: record before the first input event.
function bindSlider(input, onValue) {
    let gesture = false;
    input.addEventListener('input', () => {
        if (!gesture && ready) { viewer.recordState(); gesture = true; }
        onValue(Number(input.value));
    });
    input.addEventListener('change', () => { gesture = false; });
}

for (const [id, key] of [['zoom', 'zoom'], ['tx', 'x'], ['ty', 'y']]) {
    bindSlider($(`#${id}`), value => {
        doc.transform = { ...doc.transform, [key]: value };
        viewer.setActiveCharacterAppearance({ transform: doc.transform });
        refreshControls(); schedulePreview();
    });
}
const turnTo = value => { viewer.setModelRotation(undefined, value, undefined); refreshControls(); schedulePreview(); };
// Roll = rotation in the picture plane (model rotation about z), counterclockwise as the capture camera sees it.
const rollTo = value => { viewer.setModelRotation(undefined, undefined, value); refreshControls(); schedulePreview(); };
bindSlider($('#roll'), rollTo);
for (const button of document.querySelectorAll('[data-roll]')) button.onclick = () => { viewer.recordState(); rollTo(Number(button.dataset.roll)); fitFrame(); };
bindSlider($('#turn'), turnTo);
for (const button of document.querySelectorAll('[data-turn]')) button.onclick = () => { viewer.recordState(); turnTo(Number(button.dataset.turn)); };
for (const axis of ['x', 'y', 'z']) {
    bindSlider($(`#r${axis}`), value => {
        const bone = viewer.bones?.[selectedBoneName];
        if (!bone) return;
        bone.rotation[axis] = value * Math.PI / 180;
        bone.updateMatrixWorld(true);
        viewer.updateIKEffectorPositions?.();
        viewer.updateMarkers?.();
        viewer.requestRender();
        setOutput(`r${axis}`, `${value}°`);
        schedulePreview();
    });
}
for (const button of document.querySelectorAll('[data-preset]')) {
    button.onclick = () => {
        viewer.applyHandPreset(button.dataset.hand, HAND_PRESETS[button.dataset.preset]);
        $(`#grip-${button.dataset.hand}`).value = button.dataset.preset === 'FIST' ? 1 : 0;
        refreshControls(); schedulePreview();
    };
}
for (const side of ['l', 'r']) {
    bindSlider($(`#grip-${side}`), value => {
        viewer.interpolateHandPose(HAND_PRESETS.OPEN, HAND_PRESETS.FIST, value, side);
        refreshControls(); schedulePreview();
    });
}
$('#snap-view').onclick = () => updateCamera(true);
$('#fit-frame').onclick = $('#fit-frame-2').onclick = () => { viewer.recordState(); fitFrame(); };
$('#reset-bone').onclick = () => { viewer.recordState(); viewer.resetSelectedBone(); refreshControls(); schedulePreview(); };
$('#reset-pose').onclick = () => { viewer.recordState(); resetPose(); doc.xyz = null; refreshFlips(); refreshControls(); schedulePreview(); };
$('#undo').onclick = () => viewer.undo();
$('#redo').onclick = () => viewer.redo();

function setSize(width, height) {
    doc.width = round16(width);
    doc.height = round16(height);
    updateCamera(false);
}
$('#output-width').onchange = event => setSize(Number(event.target.value) || doc.width, doc.height);
$('#output-height').onchange = event => setSize(doc.width, Number(event.target.value) || doc.height);
for (const button of document.querySelectorAll('#ratios button')) {
    button.onclick = () => {
        const [a, b] = button.dataset.ratio.split(':').map(Number);
        const longSide = Math.max(doc.width, doc.height);
        setSize(a >= b ? longSide : longSide * a / b, a >= b ? longSide * b / a : longSide);
    };
}

const bodyContainer = $('#body-sliders');
for (const [key, label, min, max, step] of BODY_SLIDERS) {
    bodyContainer.insertAdjacentHTML('beforeend', `<label class="slider-label">${label}<output id="body-${key}-value"></output></label><input id="body-${key}" type="range" min="${min}" max="${max}" step="${step}">`);
    $(`#body-${key}`).addEventListener('input', event => {
        doc.mesh = { ...doc.mesh, [key]: Number(event.target.value) };
        refreshControls();
        clearTimeout(morphTimer);
        morphTimer = setTimeout(() => { loadModel(rotationsOnly(viewer.getPose())); updateCamera(false); }, 120);
    });
}
$('#reset-body').onclick = () => { doc.mesh = { ...DEFAULT_MESH }; loadModel(rotationsOnly(viewer.getPose())); updateCamera(false); };

const proportionContainer = $('#proportion-sliders');
for (const [key, label, min, max] of PROPORTIONS) {
    proportionContainer.insertAdjacentHTML('beforeend', `<label class="slider-label">${label}<output id="prop-${key}-value"></output></label><input id="prop-${key}" type="range" min="${min}" max="${max}" step="0.01">`);
    $(`#prop-${key}`).addEventListener('input', event => {
        setProportion(key, Number(event.target.value));
        refreshControls();
        schedulePreview();
    });
}
$('#reset-proportions').onclick = () => {
    for (const [key] of PROPORTIONS) setProportion(key, 1);
    refreshControls();
    schedulePreview();
};

for (const button of document.querySelectorAll('.panel-tabs button')) {
    button.onclick = () => {
        for (const other of document.querySelectorAll('.panel-tabs button')) other.classList.toggle('active', other === button);
        for (const tab of ['output', 'pose', 'body', 'proportion']) $(`#${tab}-panel`).hidden = tab !== button.dataset.tab;
    };
}
$('#extra-prompt').addEventListener('input', event => { extraPrompt = event.target.value; refreshControls(); });
$('#copy-description').onclick = async () => { try { await navigator.clipboard.writeText(promptText()); toast(t('common.copied')); } catch { toast(t('common.copyFailed')); } };

document.addEventListener('keydown', event => {
    if (event.target.closest?.('textarea, input[type=number], input[type=search]')) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) { event.preventDefault(); viewer.undo(); }
    else if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); viewer.redo(); }
});
new ResizeObserver(() => viewer.resize(stage.clientWidth, stage.clientHeight)).observe(stage);

// --- Node bridge ------------------------------------------------------------

async function serialize() {
    await viewer.waitForCaptureReady();
    const poseReference = capture(doc.width, doc.height);
    updateCamera(false);
    doc.pose = savedPose();
    return JSON.stringify({ version: 2, kind: 'vnccs-free-pose', ...doc, camera: FRONT, poseReference, xyzOut: currentXyz() });
}

// Shared by the node payload and 我的姿势: any saved editor state → a complete doc.
function docFrom(saved) {
    return {
        mesh: { ...DEFAULT_MESH, ...saved.mesh, breast_size: 0 }, pose: saved.pose || null, // flat chest is fixed
        proportions: { ...DEFAULT_PROPORTIONS, ...saved.proportions },
        transform: { ...NEUTRAL_TRANSFORM, ...saved.transform },
        // The mannequin size lives only here; the node's width/height are the separate output size.
        width: round16(Number(saved.width) || doc.width), height: round16(Number(saved.height) || doc.height),
        xyz: saved.xyz || null,
    };
}

function applyPayload(payload) {
    const saved = JSON.parse(payload.pose_json || '{}');
    const restored = saved.kind === 'vnccs-free-pose';
    if (restored) doc = docFrom(saved);
    upstreamXyz = payload.xyz_json || '';
    $('#load-upstream').hidden = !upstreamXyz;
    extraPrompt = payload.extra_prompt || '';
    $('#extra-prompt').value = extraPrompt;
    if (qwenMode && payload.referencePreview) {
        $('#person-preview').src = payload.referencePreview;
        $('#person-preview-wrap').hidden = false;
    }
    return restored;
}

let pendingPayload = null;
async function start(payload) {
    const restored = payload ? applyPayload(payload) : false;
    loadModel(doc.pose);
    setupInteraction();
    ready = true;
    if (restored) updateCamera(true);
    else fitFrame(true);
    refreshFlips();
    void loadXyzList();
    void loadSavedList();
    await viewer.waitForCaptureReady();
    $('#loading').hidden = true;
    $('#apply-editor').disabled = false;
    $('#save-status').textContent = t(restored ? 'fp.restored' : 'fp.newPose');
    if (!restored && upstreamXyz) loadXyzText(upstreamXyz, t('xyz.upstreamName'));
    markImported();
    schedulePreview();
}

window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'fisher-load') return;
    if (pack) start(event.data.payload).catch(showError);
    else pendingPayload = event.data.payload;
});
$('#cancel-editor').onclick = () => parent.postMessage({ type: 'fisher-close' }, location.origin);
$('#apply-editor').onclick = async () => {
    $('#apply-editor').disabled = true;
    try {
        const pose_json = await serialize();
        markSaved();
        parent.postMessage({ type: 'fisher-apply', payload: { pose_json, xyz_json: JSON.stringify(currentXyz()), extra_prompt: extraPrompt } }, location.origin);
    } catch (error) { showError(error); }
    finally { $('#apply-editor').disabled = false; }
};

function showError(error) {
    console.error(error);
    $('#loading-text').textContent = t('fp.loadError', { error: error?.message || error });
    $('#loading').hidden = false;
}

if (!embedded) { $('#apply-editor').hidden = true; $('#cancel-editor').hidden = true; }
window.xyzPose = { viewer, get doc() { return doc; }, serialize, fitFrame, currentXyz, loadXyzText, saveCurrentPose, loadSavedPose, deleteSavedPose };

(async () => {
    await viewer.init();
    if (!viewer.initialized) throw new Error(t('fp.webglFailed'));
    // The official QI2.1 workflow runs with the skydome disabled; it would otherwise be captured.
    viewer.setDirectionalSkydomeVisible(false);
    refreshControls();
    if (embedded) parent.postMessage({ type: 'fisher-ready' }, location.origin);
    pack = await loadBodyPack();
    if (embedded && !pendingPayload) return; // start() runs when the node payload arrives
    await start(pendingPayload);
})().catch(showError);
