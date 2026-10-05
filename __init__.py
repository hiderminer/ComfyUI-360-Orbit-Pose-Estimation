from .hm_qwen_free_pose import HMQwenFreePoseXYZ
from .nodes import Orbit360PoseEditor, Orbit360PoseEstimation
from .storage import register_routes

register_routes()

NODE_CLASS_MAPPINGS = {"Orbit360PoseEstimation": Orbit360PoseEstimation, "Orbit360PoseEditor": Orbit360PoseEditor, "HMQwenFreePoseXYZ": HMQwenFreePoseXYZ}
NODE_DISPLAY_NAME_MAPPINGS = {"Orbit360PoseEstimation": "360-Orbit Pose Estimation", "Orbit360PoseEditor": "360-Orbit XYZ Pose Editor",
                           "HMQwenFreePoseXYZ": "HM Qwen2.1 Free Pose XYZ (beta)"}
WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
