"""360° orbit 2D keypoints -> 3D joints (prototype; pure numpy, no ComfyUI).

Model: the person is static, the camera orbits the Y axis at constant speed (weak perspective).
World frame matches the Fisher editor: Y up, the person faces +Z at azimuth 0, the camera sits at
(sin a, ., cos a) and its right vector is (cos a, 0, -sin a) (see web/editor/state.mjs projectPoint).
    x_img = cx + X cos a - Z sin a      (pixel units)
    y_img = cy - Y
so each joint is a sinusoid in a: x = A cos a + B sin a + C  ->  X = A, Z = -B, and Y = -mean(y).
"""
import numpy as np

# Joint order used everywhere: OpenPose-18 body indices of the 14 editor joints.
JOINTS = ["head", "neck", "right_shoulder", "right_elbow", "right_wrist", "left_shoulder", "left_elbow",
          "left_wrist", "right_hip", "right_knee", "right_ankle", "left_hip", "left_knee", "left_ankle"]
OPENPOSE_INDEX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
PELVIS_REST_Y = 0.95   # BASE hip height in state.mjs
TORSO_LENGTH = 0.60    # neck -> hip midpoint, BASE value (the editor re-normalizes limbs anyway)
# The editor's default standing pose (BASE in state.mjs); left = +x, front = +z.
STANDING_JOINTS = {
    "pelvis": [0, 0.95, 0], "neck": [0, 1.55, 0], "head": [0, 1.79, 0],
    "left_shoulder": [.25, 1.48, 0], "left_elbow": [.39, 1.17, .03], "left_wrist": [.43, .87, .1],
    "right_shoulder": [-.25, 1.48, 0], "right_elbow": [-.39, 1.17, .03], "right_wrist": [-.43, .87, .1],
    "left_hip": [.14, .94, 0], "left_knee": [.18, .51, .025], "left_ankle": [.19, .08, .02],
    "right_hip": [-.14, .94, 0], "right_knee": [-.18, .51, .025], "right_ankle": [-.19, .08, .02],
}


class EstimationError(ValueError):
    """Too few usable detections to reconstruct the pose."""


def pick_frames(total, frame_count):
    """Evenly spaced source frames covering one full turn. The video is assumed to close the loop
    (last frame == first view), so frame_count samples span total-1 intervals without repeating the start."""
    frame_count = max(3, min(frame_count, total))
    return [round(i * (total - 1) / frame_count) % total for i in range(frame_count)], frame_count


def openpose_to_arrays(frames, person=0):
    """POSE_KEYPOINT frames (list of dicts) -> xy (F,14,2), score (F,14). Missing person -> score 0."""
    xy = np.zeros((len(frames), 14, 2))
    score = np.zeros((len(frames), 14))
    for f, frame in enumerate(frames):
        people = frame.get("people", [])
        if len(people) <= person:
            continue
        kp = np.asarray(people[person]["pose_keypoints_2d"], float).reshape(-1, 3)
        used = kp[OPENPOSE_INDEX]
        # Some estimators (e.g. controlnet_aux) give coordinates normalized to 0..1: scale them to pixels.
        if frame.get("canvas_width") and frame.get("canvas_height") and used[used[:, 2] > 0, :2].max(initial=0) <= 1.5:
            kp = kp.copy()
            kp[:, 0] *= frame["canvas_width"]
            kp[:, 1] *= frame["canvas_height"]
        xy[f] = kp[OPENPOSE_INDEX, :2]
        score[f] = kp[OPENPOSE_INDEX, 2]
        score[f][(kp[OPENPOSE_INDEX, 0] < 0) | (kp[OPENPOSE_INDEX, 1] < 0)] = 0  # SDPose marks missing as -1
    return xy, score


def fit_sinusoid(angle, value, weight, iterations=6):
    """Robust (Huber IRLS) fit of value = A cos + B sin + C. Returns (A, B, C, residual_rms) or None."""
    if (weight > 0).sum() < 4:
        return None
    design = np.stack([np.cos(angle), np.sin(angle), np.ones_like(angle)], axis=1)
    w = weight.astype(float).copy()
    coef = np.zeros(3)
    for _ in range(iterations):
        sw = np.sqrt(w)[:, None]
        coef = np.linalg.lstsq(design * sw, value * sw[:, 0], rcond=None)[0]
        residual = value - design @ coef
        scale = max(1.4826 * np.median(np.abs(residual[weight > 0])), 1e-6)
        k = 1.5 * scale
        w = weight * np.where(np.abs(residual) <= k, 1.0, k / np.maximum(np.abs(residual), 1e-12))
    residual = value - design @ coef
    rms = float(np.sqrt(np.average(residual ** 2, weights=np.maximum(w, 1e-9))))
    return coef[0], coef[1], coef[2], rms


def reconstruct(xy, score, direction=1, start_angle=0.0, score_threshold=0.3, min_valid_ratio=2 / 3,
                min_joint_frames=6):
    """xy (F,14,2) pixels and score (F,14) for F frames evenly spaced over one full turn.

    direction: +1 = azimuth grows with frame index, -1 = shrinks. A wrong direction mirrors Z (front/back).
    start_angle: azimuth in degrees of frame 0 (0 = camera in front of the person).
    Frames whose fraction of joints with score >= score_threshold is <= min_valid_ratio are ignored.
    Returns dict: joints {name: [x,y,z]} (metres-ish, pelvis at (0, 0.95, 0)), confidence, used_frames, rms.
    """
    count = len(xy)
    angle = np.radians(start_angle) + direction * 2 * np.pi * np.arange(count) / count
    good = score >= score_threshold
    frame_ok = good.mean(axis=1) > min_valid_ratio
    pos = np.full((14, 3), np.nan)   # pixel units: X, Y(up), Z
    rms = np.zeros(14)
    fits = {}  # joint -> [A, B, C, mean image y]: the sinusoid fitted to its x(angle) and its height
    for j in range(14):
        w = (good[:, j] & frame_ok).astype(float)
        if w.sum() < min_joint_frames:
            continue
        fit = fit_sinusoid(angle, xy[:, j, 0], w)
        if fit is None:
            continue
        a, b, _, r = fit
        mean_y = float(np.average(xy[w > 0, j, 1]))
        pos[j] = [a, -mean_y, -b]
        fits[JOINTS[j]] = [float(a), float(b), float(fit[2]), mean_y]
        rms[j] = r
    names = {n: i for i, n in enumerate(JOINTS)}
    valid = ~np.isnan(pos[:, 0])
    hips = [names["left_hip"], names["right_hip"]]
    if not (valid[hips].all() and valid[names["neck"]]):
        missing = [n for n in ("neck", "left_hip", "right_hip") if not valid[names[n]]]
        raise EstimationError(
            f"{', '.join(missing)} could not be estimated: {int(frame_ok.sum())} of {count} frames are usable "
            f"(a frame needs more than {min_valid_ratio:.2f} of the 14 joints at score >= {score_threshold:.2f}; "
            f"detected joints per frame: {good.sum(axis=1).tolist()}; "
            f"frames where {', '.join(missing)} passed the score: {[int((good[:, names[n]] & frame_ok).sum()) for n in missing]}, "
            f"at least {min_joint_frames} needed). Lower score_threshold or min_valid_ratio, or check the pose detection.")
    pelvis = pos[hips].mean(axis=0)
    torso = np.linalg.norm(pos[names["neck"]] - pelvis)
    scale = TORSO_LENGTH / max(torso, 1e-6)
    out = (pos - pelvis) * scale + np.array([0, PELVIS_REST_Y, 0])
    confidence = np.where(valid, 1.0, 0.0)
    joints = {"pelvis": [0.0, PELVIS_REST_Y, 0.0]}
    for n, i in names.items():
        if valid[i]:
            joints[n] = out[i].round(5).tolist()
    return {"joints": joints, "confidence": dict(zip(JOINTS, confidence.tolist())),
            "used_frames": int(frame_ok.sum()), "frames": count, "rms_px": (rms * 1.0).round(3).tolist(),
            "scale_m_per_px": float(scale),
            "fits": fits, "angles": angle.tolist()}


def reproject(result, frame=0, degrees=0):
    """Image positions {joint: (x, y)} the fitted model gives for one of the sampled frames (0 = the first frame).

    degrees != 0 first rotates the fitted pose counterclockwise in the first camera's image plane about the pelvis
    (like rotate_about_z), then projects it with this frame's camera.
    """
    a = result["angles"][frame]
    fits = result["fits"]
    if not degrees:
        return {name: (A * np.cos(a) + B * np.sin(a) + C, y) for name, (A, B, C, y) in fits.items()}
    angle = np.radians(degrees)
    c, s = round(float(np.cos(angle)), 12), round(float(np.sin(angle)), 12)
    hips = [fits["left_hip"], fits["right_hip"]]
    px, py = np.mean([hip[0] for hip in hips]), -np.mean([hip[3] for hip in hips])  # pelvis, y up
    center = np.mean([fit[2] for fit in fits.values()])  # the image x of the orbit axis
    out = {}
    for name, (A, B, C, y) in fits.items():
        u, v = A - px, -y - py
        x_world, y_world, z_world = px + c * u - s * v, py + s * u + c * v, -B
        out[name] = (center + x_world * np.cos(a) - z_world * np.sin(a), -y_world)
    return out


def facing_score(joints):
    """> 0 when the pose faces the way its left/right labels imply: the nose is in front of the neck and the knees in
    front of the hip-ankle line. Mirroring the depth (a wrong orbit direction) negates it exactly; the left/right
    labels come from the 2D detection, so they do not change. "Front" is taken from the body itself (shoulder and hip
    line, neck-pelvis axis), so it works for any facing angle and a rotated person.
    """
    p = {name: np.array(value, float) for name, value in joints.items()}
    forward = np.cross((p["left_shoulder"] - p["right_shoulder"]) + (p["left_hip"] - p["right_hip"]), p["neck"] - p["pelvis"])
    length = np.linalg.norm(forward)
    if length < 1e-9:
        return 0.0
    forward /= length
    score = float(np.dot(p["head"] - p["neck"], forward))
    for side in ("left", "right"):
        score += float(np.dot(p[side + "_knee"] - (p[side + "_hip"] + p[side + "_ankle"]) / 2, forward))
    return score


def rotate_about_z(joints, degrees):
    """Rotate the pose counterclockwise by `degrees` as seen from the first frame's camera, about the pelvis.

    That is the image-plane rotation: it stands up a person who lies sideways because the source image was rotated.
    """
    angle = np.radians(degrees)
    c, s = round(float(np.cos(angle)), 12), round(float(np.sin(angle)), 12)  # exact 0/1/-1 for the quarter turns
    px, py, pz = joints["pelvis"]
    return {name: [round(px + c * (x - px) - s * (y - py), 5), round(py + s * (x - px) + c * (y - py), 5), z]
            for name, (x, y, z) in joints.items()}


def flip_depth(result, names=None):
    """Front/back flip (the editor button): negate Z about the pelvis for all joints, or only `names`."""
    out = {k: list(v) for k, v in result["joints"].items()}
    for n in (names or out):
        if n != "pelvis" and n in out:
            out[n][2] = -out[n][2]
    return {**result, "joints": out}
