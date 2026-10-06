# ComfyUI-360-Orbit-Pose-Estimation

[English](README.md) | [日本語](readme-jp.md) | [中文](readme-cn.md)

[![360-Orbit Pose Estimation demo (click to open the full video)](assets/pose-estimation-360-orbit-preview.gif)](assets/pose-estimation-360-orbit-sample.mp4)

*Click the animation to open the full video (mp4).*

## Overview

From a single person image, this project estimates the pose with high accuracy and generates XYZ coordinate data and skeleton images seen from any angle. The XYZ data can be used to specify poses for Qwen Image 2.1 with the VNCCS PoseStudio LoRA. The skeleton images can be used as ControlNet pose images for various image generators.

The pose is estimated as follows.

- Create a 360° orbit video from a person image with the MiniMax H3 360 Orbit LoRA.
- Take images at several angles from the orbit video and run pose estimation on each of them (estimating the x/y coordinates of the body parts).
- Estimate the z coordinate from the x/y data of the several angles with least squares and similar methods.

The 360° orbit video (a video in which the camera goes once around a still person) is expected to be made with the MiniMax H3 "360 ORBIT" workflow, but you do not have to use it. If you can produce a 360° orbit video that rotates at a constant speed, pose estimation also works on videos made by other generative AI or on live-action video.

## ComfyUI custom nodes

The following ComfyUI custom nodes are included in this repository.

- **360-Orbit Pose Estimation** – video (or keypoints) → XYZ pose JSON, plus OpenPose-style skeleton images.
- **360-Orbit XYZ Pose Editor** – a mannequin editor to load, fix, rotate and save XYZ poses.
- **HM Qwen2.1 Free Pose XYZ (beta)** – Fisher's Qwen Image 2.1 free-pose node whose editor can load XYZ pose files.

The UI is available in English, Japanese and Chinese (it follows ComfyUI's language setting).

## Install and requirements

1. Put this folder in `ComfyUI/custom_nodes/` and restart ComfyUI. Reload the browser page (Ctrl+F5) after updating, because the editor is a web extension.
2. Models are not included. Download them yourself, check their licenses for your purpose, and place them here:
   - SDPose (`sdpose_wholebody_fp16.safetensors`): `models/checkpoints/`
3. Requirements: a ComfyUI that has `SDPoseKeypointExtractor` (for pose estimation from a video) and `TextEncodeQwenImage21` (for the Qwen node).
4. The mannequin data (`web/vnccs/`, about 90 MB) is bundled; see "Credits and licenses".

The model can be downloaded from the link below. Check the license of each model for its terms of use.

- [sdpose_wholebody_fp16.safetensors](https://huggingface.co/Comfy-Org/SDPose/blob/main/checkpoints/sdpose_wholebody_fp16.safetensors)

## About the input video

The input video must meet all of the following. If any of them is not met, the accuracy of the pose estimation drops.

- It shows one person filmed continuously from all 360° while the person rotates horizontally
- It is 5 seconds long
- Its aspect ratio is 1:1
- The rotation angle of the person between frames is constant
- The pose of the person in the first and the last frame is the same

Tips to improve the accuracy:

- Use a plain background: a color that differs from the person's clothes, hair and skin is preferable.
- Make the head point to the top of the image: for a lying pose, rotate it so that the head is up and estimate the pose, then rotate the pose in the pose editor back to the lying pose.
- Keep the whole body of the person in the picture throughout the video: the accuracy drops if hands or feet leave the frame in some frames. It also drops when an object such as a desk hides the person, or when the person wears, carries or holds items (work tools, sports equipment such as a bat, musical instruments, bags and so on).
- Wear clothes that show the pose from every angle: capes, hoods, wide skirts, armor, helmets and the like that hide the hands, feet or head greatly lower the accuracy.

Person images that are not live action (for example anime or deformed characters) may not work well. The accuracy of the pose estimation depends on the performance of SDPose.

When you create the video with the MiniMax H3 360 Orbit LoRA, prepare the input image like this.

- Only one person is shown
- The aspect ratio is 1:1
- The background is a single color
- The head is toward the top of the image

## Workflows

1. [360° video generation workflow using the MiniMax H3 360 Orbit LoRA](workflow/MiniMax-H3-360-ORBIT.json)
2. [Workflow for high-accuracy pose estimation from a 360° video](workflow/PoseEstimation-360-orbit.json)
3. [Pose-specified image generation workflow using the Qwen Image 2.1 VNCCS PoseStudio LoRA](workflow/QwenImage2.1FreePose.json)

Please refer to [MiniMax-H3-360-Orbit-LoRA](https://huggingface.co/pablodawson/MiniMax-H3-360-Orbit-LoRA) about MiniMax-H3-360-ORBIT workflow.

## A very rough procedure

- Create a 360° rotation video from one image with workflow 1
- Load the video made in 1 into workflow 2 and run it, then open the XYZ pose editor and download the xyz pose data (a json file)
- In the "HM Qwen 2.1 Free Pose XYZ" node of workflow 3, load the downloaded xyz pose data (json file) (choose it with "Open a file…"), edit it if needed, and click the "Apply to node" button to apply it.
- Input an image of the person who should take the pose into workflow 3 and run it.

[![Image generation example with Qwen Image 2.1 (click to open the image)](assets/qwen-image-2.1-pose-image-sample.png)](assets/qwen-image-2.1-pose-image-sample.png)

## Nodes (category `360-Orbit`)

### 360-Orbit Pose Estimation

Assumptions: the person is still, the camera orbits them at a constant speed around the vertical axis, and the first sampled frame is the start of one full turn (the last frame closes the loop). Joint positions are fitted over all sampled frames as sinusoids of the camera angle, which gives X, Y and Z (weak-perspective model).

**Inputs** – use one of them (priority: `keypoints` → `images` → `video`; an error if none is connected):

| Input | Description |
|---|---|
| `images` | IMAGE batch of the orbit video |
| `video` | VIDEO (for example Create Video / Load Video) |
| `keypoints` | POSE_KEYPOINT for all frames from any estimator (pixel or 0–1 normalized coordinates) |

**Parameters**

| Parameter | Default | Description |
|---|---|---|
| `ckpt_name` | `sdpose_wholebody_fp16.safetensors` | SDPose model (checkpoints folder). |
| `batch_size` | 1 | Frames per SDPose pass. Keep it small to avoid running out of GPU memory. |
| `frame_count` | 24 | Frames used for the estimate, evenly spaced over one turn. |
| `direction` | `auto` | Camera rotation seen from above: `ccw`, `cw`, or `auto`. `auto` picks the direction that puts the nose in front of the neck and the knees in front of the hip–ankle line. A wrong direction mirrors front/back. |
| `start_angle` | 0 | Camera azimuth of the first frame in degrees (0 = the first frame sees the person's front). |
| `score_threshold` | 0.3 | A joint with a lower score counts as not detected. |
| `min_valid_ratio` | 2/3 | A frame whose ratio of detected joints is at or below this is ignored. |
| `save_name` | `orbit_pose/pose-data` | Save location relative to the output folder (sub folders allowed, never outside it). A 6-digit number is added: `pose-data_000001.json`, then `_000002`, … (counted per name, never overwrites). |
| `save_file` | on | Save the XYZ JSON to a file. |
| `pose_rotation` | 0 | Rotate the estimated pose by 0 / 90 / 180 / 270° counterclockwise (as seen from the first frame, about the pelvis). Use it only when the person really lies sideways in the video. For a sideways pose in the editor, use the editor's "Rotate in the picture" instead. |

**Outputs**

| Output | Description |
|---|---|
| `pose_xyz_json` | The XYZ pose JSON (format below). |
| `images` | OpenPose-style skeleton images of the corrected pose, one per sampled frame, same size as the input, on black. Connect them to a video node to get a skeleton video. Not rotated. |
| `rotated_images` | The same after `pose_rotation` (identical to `images` when it is 0). |

**Good to know**

- If too few joints are detected, the node does not fail: it outputs the default standing pose (`meta.estimated` is `false`, the reason is in `meta.error`) and black images, and the node shows "ESTIMATION FAILED". Lowering `score_threshold` or `min_valid_ratio` often helps. Setup errors (nothing connected, model missing) still raise errors.
- When the torso is not upright after rotation (neck not above the pelvis), the node shows a warning and `meta.upright` is `false`. The editor's import assumes a standing person and can show such poses front/back reversed.
- The chosen direction is shown on the node and stored in `meta.direction_used`.

### 360-Orbit XYZ Pose Editor

Opens the mannequin editor with the **Open XYZ pose editor** button. **Apply to node** stores the edited pose in the node.

- **Output:** `xyz_json` only: the edited pose if you applied it in the editor, otherwise the connected `xyz_json` input (an error if neither exists).
- **Input:** `xyz_json` (optional). The editor can load it after the connected estimation node has run.
- **Sample poses:** `defaults/` holds 100 samples (`pNN-xyz.json` with a thumbnail `pNN-xyz.png`). The editor lists them with thumbnails under "Sample poses" in the left panel; click one to load it (read only).

### HM Qwen2.1 Free Pose XYZ (beta) – `HMQwenFreePoseXYZ`

Fisher's `FisherQwenFreePose` (Qwen Image 2.1, single person) with XYZ pose loading in its editor. Inputs, outputs and encoding are the same: `clip`, `vae`, `reference_image`, `width`, `height`, `reference_resolution`, `extra_prompt`, `pose_json` → `positive`, `negative`, `latent`, `actual_prompt`, `mannequin_pose_image`. The mannequin render is image1, the person photo is image2, and the prompt is `Draw character from image2` plus `extra_prompt` (the VNCCS_QI2_PoseStudio LoRA convention).

- There is no XYZ input socket: load an XYZ file in the editor. The mannequin image is created when you click **Apply to node** after loading (running without applying is an error, as in Fisher's node).
- Besides the XYZ editor features, this node's editor shows the extra-prompt box and a preview of the person image.
- Not included: the OpenPose image gallery of Fisher's editor (built-in `pose-images/` skeletons and the user library) and its image-to-3D lifting. The skeleton images are not distributed; if you need them, use Fisher's node (ComfyUI-Fisher-Pose) at your own responsibility.
- It does not depend on Fisher's code (it calls ComfyUI's own `TextEncodeQwenImage21`). My Poses are stored in the same folder as Fisher's, so poses saved in either editor can be read by the other.

## The editor

Shared by the XYZ Pose Editor and the Qwen node.

- **Load XYZ:** the files of `output/orbit_pose/` with sub-folder navigation (you cannot go above `orbit_pose`), "Open a file…", and (XYZ Pose Editor only) the connected node's output.
- **Front/back flip:** whole body, upper body, and each arm and leg (whole / lower part). Each flip imports the pose again from the XYZ data, so manual joint edits are replaced (you are asked to confirm when there are any).
- **Rotate in the picture:** 0° / 90° / 180° / 270° buttons and a slider (counterclockwise). The pose is imported upright and the whole mannequin is rotated afterwards, which is how to get a sideways pose such as being on all fours. The rotation is applied to the picture sent to the node and kept in My Poses; saved and downloaded XYZ files stay upright. A flip keeps the rotation; loading another file resets it.
- **Save:** "Save XYZ JSON" (into the folder you are in, under `output/orbit_pose/`), "Download…", and My Poses (saved in `user/default/fisher_pose/poses/`).
- **Warnings:** a confirmation before a load or a flip would discard edits that were neither applied to the node nor saved; a notice when a loaded pose is the default standing pose of a failed estimation or is not upright.
- Body shape, proportions, hands and joint rotations are edited as in Fisher's free-pose editor.

## XYZ pose JSON (`orbit-pose-xyz`)

```json
{ "kind": "orbit-pose-xyz", "version": 1, "units": "m", "up": "y",
  "joints": { "pelvis": [0, 0.95, 0], "neck": [x, y, z], "head": [x, y, z],
              "left_shoulder": [..], "left_elbow": [..], "left_wrist": [..],
              "right_shoulder": [..], "right_elbow": [..], "right_wrist": [..],
              "left_hip": [..], "left_knee": [..], "left_ankle": [..],
              "right_hip": [..], "right_knee": [..], "right_ankle": [..] },
  "confidence": { }, "meta": { } }
```

15 joints in metres. Y is up, +Z is the way the person faces, +X is the person's left. The pelvis is at (0, 0.95, 0) and the neck–pelvis length is 0.6. `head` is the nose in estimated files and the head bone in files saved by the editor. `meta` records the settings and results (`direction_used`, `pose_rotation`, `estimated`, `upright`, …).

## Languages

- Node names, input/output names, tooltips and descriptions: `locales/{en,ja,zh}/nodeDefs.json` (follows ComfyUI's language setting; internal names saved in workflows do not change).
- Editor: `web/editor/i18n/{en,ja,zh}.mjs` (other languages fall back to English).
- Python error messages and console output are English only.
- When adding an input, output or text, add it to all three languages.

## Security notes

The editor of these nodes adds the following routes (`/orbit360/*`) to the ComfyUI server.

- List, read and save the XYZ files under `output/orbit_pose/`
- List, read, save and delete My Poses (`user/default/fisher_pose/poses/`)

Like ComfyUI's own `/view` and `/upload`, these routes have no authentication. If you expose ComfyUI to a network (the internet or a shared LAN) with `--listen` or similar, other devices on that network can read and write the files in these folders. When you expose it, restrict the access, for example with a firewall or the authentication of a reverse proxy.

- Only the JSON files inside the folders above can be read and written (`..` and absolute paths are refused, so nothing outside the folders can be reached).
- `save_name` of node A can only write inside the output folder, and it never overwrites an existing file.
- The code of this repository does not access the network and does not access files outside the ComfyUI folders (models are loaded as ComfyUI itself is configured).

## Credits and licenses

The code of this project (© 2026 AI Bard Guild; contact: @IsekaiBardGuild; GitHub: [hiderminer](https://github.com/hiderminer)) is released under the [MIT License](LICENSE), following ComfyUI-Fisher-Pose-i18n (derived from ComfyUI-Fisher-Pose, MIT, © 2026 Work-Fisher), from whose free-pose editor the editor here is derived. Third-party components keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

- `web/vnccs/`: VNCCS Pose Studio core (MiuProject, MIT), MakeHuman body pack (CC0) and three.js (MIT), copied as they are bundled with ComfyUI-Fisher-Pose. See the license files in each folder.
- `web/editor/xyzpose.*`, `style.css`, `i18n*`: derived from the free-pose editor of ComfyUI-Fisher-Pose (Work-Fisher, MIT), changed to load, flip, rotate and save XYZ poses.
- `assets/`: the demo video, the preview GIF made from it and the sample image were generated with AI and are free of copyright claims (CC0 1.0 Universal; this covers the maintainer's rights only).
- `defaults/`: the sample poses (pose data and thumbnails) are free to use, including for making commercial works. Commercial distribution is not allowed: bundling them with commercial software, or redistributing the data itself for commercial purposes ([defaults/LICENSE.md](defaults/LICENSE.md)).
