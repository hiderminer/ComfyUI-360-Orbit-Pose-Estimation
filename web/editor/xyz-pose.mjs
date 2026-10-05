// XYZ pose data ("orbit-pose-xyz"): 15 named joints in metres, y up, +z = the way the person faces,
// +x = the person's left. Pelvis sits at (0, 0.95, 0). Made by the 360-Orbit Pose Estimation node.
import { t } from './i18n.mjs';

export const JOINT_KEYS = ['pelvis', 'neck', 'head', 'left_shoulder', 'left_elbow', 'left_wrist', 'right_shoulder', 'right_elbow', 'right_wrist',
    'left_hip', 'left_knee', 'left_ankle', 'right_hip', 'right_knee', 'right_ankle'];
const PELVIS_Y = 0.95;
const TORSO_LENGTH = 0.6;

const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const length = v => Math.hypot(...v);
const isPoint = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

export function parseXyz(text) {
    let data;
    try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw Error(t('xyz.err.json')); }
    if (data?.kind !== 'orbit-pose-xyz' || typeof data.joints !== 'object') throw Error(t('xyz.err.kind'));
    const missing = JOINT_KEYS.filter(key => key !== 'pelvis' && !isPoint(data.joints[key]));
    if (missing.length) throw Error(t('xyz.err.missing', { names: missing.join(', ') }));
    return { joints: Object.fromEntries(JOINT_KEYS.map(key => [key, key === 'pelvis' && !isPoint(data.joints.pelvis) ? [0, PELVIS_Y, 0] : data.joints[key].slice()])),
             confidence: data.confidence || {}, meta: data.meta || {} };
}

// Flip groups: whole body, upper body lean, and each limb (whole / lower segment), like the Fisher depth fixes.
export const FLIP_GROUPS = ['body', 'torso', 'lArm', 'lForearm', 'rArm', 'rForearm', 'lLeg', 'lShin', 'rLeg', 'rShin'];
const LIMBS = { l: { arm: ['left_shoulder', 'left_elbow', 'left_wrist'], leg: ['left_hip', 'left_knee', 'left_ankle'] },
                r: { arm: ['right_shoulder', 'right_elbow', 'right_wrist'], leg: ['right_hip', 'right_knee', 'right_ankle'] } };

// Mirror the points' depth about the plane z = pivot.
function mirror(joints, names, pivotZ) {
    for (const name of names) joints[name][2] = 2 * pivotZ - joints[name][2];
}

export function applyFlips(joints, flips = {}) {
    const out = Object.fromEntries(Object.entries(joints).map(([key, value]) => [key, value.slice()]));
    const pelvisZ = out.pelvis[2];
    if (flips.torso) mirror(out, ['neck', 'head', 'left_shoulder', 'left_elbow', 'left_wrist', 'right_shoulder', 'right_elbow', 'right_wrist'], pelvisZ);
    for (const side of ['l', 'r']) {
        const [armRoot, armMid, armEnd] = LIMBS[side].arm, [legRoot, legMid, legEnd] = LIMBS[side].leg;
        if (flips[side + 'Arm']) mirror(out, [armMid, armEnd], out[armRoot][2]);
        if (flips[side + 'Forearm']) mirror(out, [armEnd], out[armMid][2]);
        if (flips[side + 'Leg']) mirror(out, [legMid, legEnd], out[legRoot][2]);
        if (flips[side + 'Shin']) mirror(out, [legEnd], out[legMid][2]);
    }
    if (flips.body) mirror(out, JOINT_KEYS.filter(key => key !== 'pelvis'), pelvisZ);
    return out;
}

/**
 * XYZ joints -> world keypoints for applyWorldKeypointImport, scaled so the torso matches the mannequin.
 * @param rest {anchor: pelvis bone [x,y,z], torso: neck-to-hip length, headDistance: neck-to-head-bone length}
 */
export function toWorldKeypoints(joints, rest) {
    const pelvis = joints.pelvis;
    const scale = rest.torso / (length(sub(joints.neck, pelvis)) || TORSO_LENGTH);
    const world = {};
    for (const key of JOINT_KEYS) world[key] = add(sub(joints[key], pelvis).map(v => v * scale), rest.anchor);
    // The spine IK target is the head bone origin, not the nose: keep the direction at the mannequin's head-bone distance.
    const direction = sub(world.head, world.neck);
    const norm = length(direction) || 1;
    world.head = add(world.neck, direction.map(v => v / norm * rest.headDistance));
    return world;
}

// Mannequin world positions (any pelvis position) -> XYZ pose record scaled to a 0.6 m torso.
export function exportXyz(world, extra = {}) {
    const pelvis = world.pelvis;
    const torso = length(sub(world.neck, pelvis)) || TORSO_LENGTH;
    const scale = TORSO_LENGTH / torso;
    const joints = Object.fromEntries(JOINT_KEYS.map(key => [key, key === 'pelvis' ? [0, PELVIS_Y, 0]
        : add(sub(world[key], pelvis).map(v => v * scale), [0, PELVIS_Y, 0]).map(v => Math.round(v * 1e5) / 1e5)]));
    return { kind: 'orbit-pose-xyz', version: 1, units: 'm', up: 'y', joints, ...extra };
}
