"""Decode the mannequin front capture stored in the editor's pose_json.

Based on pose_reference.py of ComfyUI-Fisher-Pose (MIT, (c) 2026 Work-Fisher).
"""
import base64
import io
import json

from PIL import Image

PREFIX = "data:image/png;base64,"


def reference_image(pose_json):
    data = json.loads(pose_json or "{}")
    encoded = data.get("poseReference", "")
    if not encoded:
        raise ValueError('Open the editor and click "Apply to node" first.')
    if not isinstance(encoded, str) or not encoded.startswith(PREFIX) or len(encoded) > 32_000_000:
        raise ValueError("The mannequin image data is invalid. Apply the editor again.")
    image = Image.open(io.BytesIO(base64.b64decode(encoded[len(PREFIX):], validate=True)))
    if not all(64 <= value <= 4096 for value in image.size):
        raise ValueError("The mannequin image must be 64–4096 pixels on each side. Apply the editor again.")
    return image.convert("RGB")
