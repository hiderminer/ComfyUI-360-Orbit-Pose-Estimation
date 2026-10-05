"""OpenPose-style skeleton images of the fitted (corrected) pose, one per sampled frame, on a black canvas."""
import math

import numpy as np
from PIL import Image, ImageDraw

from .recon360 import JOINTS, reproject

# JOINTS order = OpenPose body indices 0..13; limb pairs and colours as in the OpenPose body drawing.
LIMBS = [(1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13), (1, 0)]
COLORS = [(255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0), (0, 255, 0), (0, 255, 85),
          (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255)]


def draw_pose(points, size):
    """points: {joint name: (x, y)} in pixels; size: (width, height). Returns HxWx3 uint8."""
    stick = max(2, round(max(size) / 128))
    canvas = Image.new("RGB", size, (0, 0, 0))
    for color, (a, b) in zip(COLORS, LIMBS):
        if JOINTS[a] not in points or JOINTS[b] not in points:
            continue
        (x1, y1), (x2, y2) = points[JOINTS[a]], points[JOINTS[b]]
        # A filled ellipse along the limb, blended at 60% like OpenPose's body drawing.
        half, angle = math.hypot(x1 - x2, y1 - y2) / 2, math.atan2(y2 - y1, x2 - x1)
        outline = [((x1 + x2) / 2 + half * math.cos(t) * math.cos(angle) - stick * math.sin(t) * math.sin(angle),
                    (y1 + y2) / 2 + half * math.cos(t) * math.sin(angle) + stick * math.sin(t) * math.cos(angle))
                   for t in np.linspace(0, 2 * math.pi, 25)]
        layer = canvas.copy()
        ImageDraw.Draw(layer).polygon(outline, fill=color)
        canvas = Image.blend(canvas, layer, 0.6)
    draw = ImageDraw.Draw(canvas)
    for color, name in zip(COLORS, JOINTS):
        if name in points:
            x, y = points[name]
            draw.ellipse([x - stick, y - stick, x + stick, y + stick], fill=color)
    return np.asarray(canvas)


def draw_pose_images(result, size, degrees=0):
    """One image per sampled frame, from the fitted sinusoids (so noise and dropped detections are corrected).

    degrees rotates the pose first (see recon360.reproject); the frames still show the orbiting camera's views.
    """
    return np.stack([draw_pose(reproject(result, frame, degrees), size) for frame in range(len(result["angles"]))])
