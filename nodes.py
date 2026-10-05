"""360-Orbit Pose Estimation: a 360° camera-orbit video of a still person -> XYZ pose JSON."""
import json
import os

import torch

from .openpose_draw import draw_pose_images
from .storage import DEFAULT_SAVE_NAME, save_numbered

UPRIGHT_MIN = 0.15  # metres of neck above pelvis (the torso is 0.6 long)
from .recon360 import JOINTS, STANDING_JOINTS, EstimationError, facing_score, openpose_to_arrays, pick_frames, reconstruct, rotate_about_z

DEFAULT_MODEL = "sdpose_wholebody_fp16.safetensors"
_model_cache = {}


def _checkpoints():
    import folder_paths
    return folder_paths.get_filename_list("checkpoints") or [DEFAULT_MODEL]


def _load_pose_model(ckpt_name):
    """Same loader as CheckpointLoaderSimple; the last model stays cached between runs."""
    if ckpt_name not in _model_cache:
        import comfy.sample  # the SDPose extractor uses comfy.sample; ComfyUI imports it, a bare import does not
        import comfy.sd
        import folder_paths
        path = folder_paths.get_full_path_or_raise("checkpoints", ckpt_name)
        out = comfy.sd.load_checkpoint_guess_config(path, output_vae=True, output_clip=False,
                                                    embedding_directory=folder_paths.get_folder_paths("embeddings"))
        _model_cache.clear()
        _model_cache[ckpt_name] = (out[0], out[2])
    return _model_cache[ckpt_name]


def _extract_keypoints(images, ckpt_name, batch_size=1):
    try:
        from comfy_extras.nodes_sdpose import SDPoseKeypointExtractor
    except ImportError as error:
        raise RuntimeError("This node needs a ComfyUI that includes SDPoseKeypointExtractor, or connect "
                           "POSE_KEYPOINT from another pose estimator.") from error
    model, vae = _load_pose_model(ckpt_name)
    return SDPoseKeypointExtractor.execute(model=model, vae=vae, image=images, batch_size=batch_size).result[0]


def build_record(result, params):
    return {"kind": "orbit-pose-xyz", "version": 1, "units": "m", "up": "y", "joints": result["joints"],
            "confidence": result["confidence"],
            "meta": {**params, "used_frames": result["used_frames"], "frames": result["frames"], "rms_px": dict(zip(JOINTS, result["rms_px"]))}}


class Orbit360PoseEstimation:
    @classmethod
    def INPUT_TYPES(cls):
        models = _checkpoints()
        return {
            "required": {
                "ckpt_name": (models, {"default": DEFAULT_MODEL if DEFAULT_MODEL in models else models[0],
                                       "tooltip": "SDPose model (checkpoints folder). Used when images or video is connected."}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64, "step": 1,
                                       "tooltip": "Frames per SDPose pass. Keep it small (1) to avoid running out of GPU memory."}),
                "frame_count": ("INT", {"default": 24, "min": 4, "max": 360, "step": 1,
                                        "tooltip": "Frames used for the estimate, evenly spaced over one full turn."}),
                "direction": (["auto", "ccw", "cw"], {"default": "auto",
                                              "tooltip": "Camera rotation seen from above. auto picks the direction that puts the nose and knees in front of the body. A wrong direction mirrors front/back (the editor's flip button fixes it)."}),
                "start_angle": ("FLOAT", {"default": 0.0, "min": -360.0, "max": 360.0, "step": 1.0,
                                          "tooltip": "Camera azimuth of the first frame in degrees. 0 = the first frame sees the person's front."}),
                "score_threshold": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.01,
                                              "tooltip": "A joint with a lower score counts as not detected."}),
                "min_valid_ratio": ("FLOAT", {"default": 2 / 3, "min": 0.0, "max": 1.0, "step": 0.01,
                                              "tooltip": "A frame whose ratio of detected joints is at or below this is ignored."}),
                "save_name": ("STRING", {"default": DEFAULT_SAVE_NAME, "tooltip": "Where to save, relative to the output folder; a 6-digit number is added (pose-data_000001.json, then _000002 ...)."}),
                "save_file": ("BOOLEAN", {"default": True, "tooltip": "Save the XYZ JSON to a file."}),
                "pose_rotation": (["0", "90", "180", "270"], {"default": "0", "tooltip": "Rotate the estimated pose counterclockwise (degrees, as seen from the first frame) to stand up a sideways person, e.g. 270 for a source image rotated 90 degrees left. images is not rotated."}),
            },
            "optional": {
                "images": ("IMAGE", {"tooltip": "The 360° orbit video frames."}),
                "video": ("VIDEO", {"tooltip": "A VIDEO (e.g. Create Video / Load Video). Used when images is not connected."}),
                "keypoints": ("POSE_KEYPOINT", {"tooltip": "Keypoints for all frames from any estimator. Used instead of the video inputs."}),
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE", "IMAGE")
    RETURN_NAMES = ("pose_xyz_json", "images", "rotated_images")
    FUNCTION = "estimate"
    CATEGORY = "360-Orbit"
    OUTPUT_NODE = True
    DESCRIPTION = "Estimates a still person's 3D joints from a 360° orbit video and saves them as XYZ pose JSON. images are OpenPose-style skeletons of the corrected pose, one per frame used (connect them to a video node); rotated_images show the pose after pose_rotation."

    def estimate(self, ckpt_name, batch_size, frame_count, direction, start_angle, score_threshold, min_valid_ratio, save_name, save_file, pose_rotation,
                 images=None, video=None, keypoints=None):
        used_model = False
        if keypoints is None and images is None and video is not None:
            images = video.get_components().images
        if keypoints is None and images is None:
            raise ValueError("Connect images or video (the orbit video) or keypoints (POSE_KEYPOINT).")
        if keypoints is None:
            indices, frame_count = pick_frames(images.shape[0], frame_count)
            keypoints = _extract_keypoints(images[indices], ckpt_name, batch_size)
            used_model = True
        elif not used_model:
            indices, frame_count = pick_frames(len(keypoints), frame_count)
            keypoints = [keypoints[i] for i in indices]
        xy, score = openpose_to_arrays(keypoints)
        failure = None
        try:
            sign = -1 if direction == "cw" else 1
            result = reconstruct(xy, score, sign, start_angle, score_threshold, min_valid_ratio)
            if direction == "auto" and facing_score(result["joints"]) < 0:  # the depth is mirrored: the other direction is the right one
                sign = -1
                result = reconstruct(xy, score, sign, start_angle, score_threshold, min_valid_ratio)
        except EstimationError as error:  # keep the workflow running: default standing pose, black images
            failure = str(error)
            print(f"[360-Orbit] Pose estimation failed, outputting the default standing pose: {failure}")
            result = {"joints": STANDING_JOINTS, "confidence": {name: 0.0 for name in JOINTS}, "used_frames": 0, "frames": frame_count, "rms_px": [0.0] * len(JOINTS)}
        if failure is None and pose_rotation != "0":
            result = {**result, "joints": rotate_about_z(result["joints"], int(pose_rotation))}
        neck_height = result["joints"]["neck"][1] - result["joints"]["pelvis"][1]
        upright = neck_height > UPRIGHT_MIN  # the editor's import assumes a person who is (roughly) standing
        params = {"model": ckpt_name if used_model else None, "frame_count": frame_count, "direction": direction, "direction_used": None if failure else ("ccw" if sign == 1 else "cw"),
                  "start_angle": start_angle, "score_threshold": score_threshold, "min_valid_ratio": min_valid_ratio,
                  "estimated": failure is None, "error": failure, "upright": upright, "pose_rotation": int(pose_rotation)}
        text = json.dumps(build_record(result, params), ensure_ascii=False, indent=1)
        import folder_paths
        saved = os.path.relpath(save_numbered(folder_paths.get_output_directory(), save_name, text), folder_paths.get_output_directory()) if save_file else "not saved"
        width, height = (images.shape[2], images.shape[1]) if images is not None else (keypoints[0].get("canvas_width", 768), keypoints[0].get("canvas_height", 768))
        if failure is None:
            pose_images = torch.from_numpy(draw_pose_images(result, (int(width), int(height)))).float() / 255.0
            turned = int(pose_rotation)
            rotated_images = torch.from_numpy(draw_pose_images(result, (int(width), int(height)), turned)).float() / 255.0 if turned else pose_images
        else:
            pose_images = rotated_images = torch.zeros((frame_count, int(height), int(width), 3))
        status = f"{result['used_frames']}/{result['frames']} frames used, direction {'ccw' if sign == 1 else 'cw'}{' (auto)' if direction == 'auto' else ''}" if failure is None else "ESTIMATION FAILED, default standing pose output"
        if not upright:
            status += " | WARNING: the torso is not upright (check pose_rotation)"
        return {"ui": {"text": [f"{status} -> {saved}"],
                       "orbit_xyz": [text]},  # read by the editor node's front end when this node feeds it
                "result": (text, pose_images, rotated_images)}


class Orbit360PoseEditor:
    """Edit XYZ pose data in the Fisher free-pose editor; saves XYZ JSON or Fisher-compatible My Poses."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"pose_json": ("STRING", {"default": "{}", "multiline": True})},
            "optional": {"xyz_json": ("STRING", {"forceInput": True, "tooltip": "XYZ pose JSON from 360-Orbit Pose Estimation. The editor loads it after that node has run."})},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("xyz_json",)
    FUNCTION = "output"
    CATEGORY = "360-Orbit"
    DESCRIPTION = "Edits XYZ pose data in the free-pose editor. Outputs the edited pose, or the connected xyz_json when nothing was applied in the editor."

    def output(self, pose_json, xyz_json=None):
        try:
            edited = json.loads(pose_json or "{}").get("xyzOut")
        except ValueError:
            edited = None
        if edited is not None:
            return (json.dumps(edited, ensure_ascii=False),)
        if xyz_json:
            return (xyz_json,)
        raise ValueError('Connect xyz_json, or open the editor, load an XYZ pose and click "Apply to node".')
