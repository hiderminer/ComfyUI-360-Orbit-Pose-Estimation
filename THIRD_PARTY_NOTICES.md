# Third-party notices

The code of this project (© 2026 AI Bard Guild, contact: @IsekaiBardGuild, GitHub: [hiderminer](https://github.com/hiderminer)) is under the MIT License ([LICENSE](LICENSE)), following
[ComfyUI-Fisher-Pose](https://github.com/Work-Fisher/ComfyUI-Fisher-Pose) (MIT, © 2026 Work-Fisher), which the editor is derived from.
The components below keep their own licenses.

## Included in this repository

| Location | What | License | Notes |
|---|---|---|---|
| `web/editor/xyzpose.*`, `web/editor/style.css`, `web/editor/i18n*` | Free-pose editor of ComfyUI-Fisher-Pose, changed to load, flip, rotate and save XYZ poses | MIT, © 2026 Work-Fisher | The license text is in [LICENSE](LICENSE). |
| `hm_qwen_free_pose.py`, `pose_reference.py` | Based on `free_pose.py` and `pose_reference.py` of ComfyUI-Fisher-Pose (Qwen Image 2.1 free-pose encoding) | MIT, © 2026 Work-Fisher | |
| `web/vnccs/` (`vnccs_*.mjs`, `textures/`, `README.md`) | VNCCS Pose Studio core ([AHEKOT/ComfyUI_VNCCS_Utils](https://github.com/AHEKOT/ComfyUI_VNCCS_Utils)) | MIT, © 2025 MiuProject | License: `web/vnccs/LICENSE`. Local changes are listed in `web/vnccs/README.md` (renamed `.js` to `.mjs`, decompressed body pack, edited skin texture). |
| `web/vnccs/assets/pose_studio_makehuman.v2.bin` | MakeHuman mesh, morph-target, rig and weight data (runtime-optimized derivative) | CC0 1.0 Universal | Texts: `web/vnccs/assets/pose_studio_makehuman.v2.LICENSE.md` and `…CC0-1.0.md`. |
| `web/vnccs/three.module.mjs`, `OrbitControls.mjs`, `TransformControls.mjs` | three.js (r160) and its controls | MIT, © 2010-2025 three.js authors | License text: [licenses/three.js-LICENSE.txt](licenses/three.js-LICENSE.txt). |
| `assets/pose-estimation-360-orbit-sample.mp4`, `assets/pose-estimation-360-orbit-preview.gif`, `assets/qwen-image-2.1-pose-image-sample.png` | The demo video, the preview GIF made from it, and the sample image (shown in the README) | Free of copyright claims: CC0 1.0 Universal | The pictures and the video were generated with AI, and no rights are claimed on them. This covers the maintainer's rights only; rights of third parties in other things shown (for example the names of the models) are not affected. |

## Not included (the user downloads them)

Model weights are not distributed with this project. Download them yourself and follow their licenses:

- SDPose (`sdpose_wholebody_fp16.safetensors`): see the license on its model page, [teemosliang/SDPose-Wholebody](https://huggingface.co/teemosliang/SDPose-Wholebody). You download it yourself and are responsible for following it.
- For the Qwen node: Qwen Image 2.1 and the VNCCS_QI2_PoseStudio LoRA – follow their licenses.
- The MiniMax H3 models used by the sample workflow – see their model pages.

This notice is a summary written for convenience. If a license text and this summary differ, the license text applies.
