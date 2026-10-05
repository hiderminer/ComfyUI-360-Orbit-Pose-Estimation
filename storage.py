"""Local JSON storage for the XYZ pose editor.

- XYZ pose files: ComfyUI/output/orbit_pose/<name>.json (also where the estimation node saves).
- Saved poses ("My Poses"): the same folder and record format as ComfyUI-Fisher-Pose
  (user/default/fisher_pose/poses/<name>.json), so poses saved here also appear in the Fisher editor.
"""
import json
import os
import re
import time

MAX_NAME_LENGTH = 60
MAX_RECORD_BYTES = 8 * 1024 * 1024
FORBIDDEN = set('\\/:*?"<>|')


def safe_name(name):
    """The name doubles as the file name: reject path tricks instead of rewriting them."""
    if not isinstance(name, str):
        return None
    name = " ".join(name.split())
    if not name or len(name) > MAX_NAME_LENGTH or name.strip(".") == "" or name.startswith("."):
        return None
    if any(ch in FORBIDDEN or ord(ch) < 32 for ch in name):
        return None
    return name


def xyz_folder(output_directory):
    return os.path.join(output_directory, "orbit_pose")


def resolve_subfolder(root, relative):
    """(absolute folder, path parts) of a sub folder of `root`, or None when the path would leave it.

    Only plain folder names are accepted ("a/b"): no "..", no drive or absolute paths, and the real path
    (links resolved) must stay inside root.
    """
    parts = [part for part in re.split(r"[\\/]+", str(relative or "")) if part not in ("", ".")]
    if any(safe_name(part) != part for part in parts):
        return None
    path = os.path.join(root, *parts)
    real_root = os.path.realpath(root)
    try:
        if os.path.commonpath([os.path.realpath(path), real_root]) != real_root:
            return None
    except ValueError:  # another drive
        return None
    return path, parts


def list_folders(folder):
    if not os.path.isdir(folder):
        return []
    return sorted((name for name in os.listdir(folder) if safe_name(name) == name and os.path.isdir(os.path.join(folder, name))), key=str.lower)


def poses_folder(user_directory):
    return os.path.join(user_directory, "default", "fisher_pose", "poses")


def _path(folder, name):
    name = safe_name(name)
    return None if name is None else os.path.join(folder, name + ".json")


def read_record(folder, name):
    path = _path(folder, name)
    if path is None or not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as file:
        return json.load(file)


def list_names(folder):
    """(name, mtime in ms) of every .json file, newest first."""
    if not os.path.isdir(folder):
        return []
    items = []
    for file_name in os.listdir(folder):
        name = file_name[:-5]
        if file_name.endswith(".json") and safe_name(name) == name:
            items.append((name, int(os.path.getmtime(os.path.join(folder, file_name)) * 1000)))
    return sorted(items, key=lambda item: item[1], reverse=True)


def write_record(folder, name, record, overwrite=False):
    """Returns (status, message): 'saved', 'exists' or 'invalid'."""
    path = _path(folder, name)
    if path is None:
        return "invalid", "The name must be 1–60 characters and cannot contain \\ / : * ? \" < > |"
    if os.path.exists(path) and not overwrite:
        return "exists", "A file with this name already exists"
    text = json.dumps(record, ensure_ascii=False)
    if len(text.encode("utf-8")) > MAX_RECORD_BYTES:
        return "invalid", "The data is too large"
    os.makedirs(folder, exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as file:
        file.write(text)
    os.replace(temporary, path)  # never leave a half-written file behind
    return "saved", safe_name(name)


DEFAULT_SAVE_NAME = "orbit_pose/pose-data"
NUMBER_DIGITS = 6


def save_numbered(output_directory, prefix, text):
    """Write <output>/<prefix>_000001.json, taking the next free number, and return the path.

    The prefix may contain sub folders ("orbit_pose/pose-data") but cannot leave the output folder.
    """
    parts = [part for part in re.split(r"[\\/]+", str(prefix).strip()) if part.strip() not in ("", ".")]
    if ".." in parts:
        raise ValueError('save_name must stay inside the output folder (no "..").')
    parts = [re.sub(r'[:*?"<>|\x00-\x1f]', "_", " ".join(part.split())).strip(". ")[:80] or "_" for part in parts] or DEFAULT_SAVE_NAME.split("/")
    folder, base = os.path.join(output_directory, *parts[:-1]), parts[-1]
    os.makedirs(folder, exist_ok=True)
    pattern = re.compile(rf"^{re.escape(base)}_(\d+)\.json$")
    number = max((int(match.group(1)) for match in map(pattern.match, os.listdir(folder)) if match), default=0)
    while True:
        number += 1
        path = os.path.join(folder, f"{base}_{number:0{NUMBER_DIGITS}d}.json")
        try:
            with open(path, "x", encoding="utf-8") as file:  # "x": never overwrite an existing file
                file.write(text)
            return path
        except FileExistsError:
            continue


def valid_xyz(record):
    return isinstance(record, dict) and record.get("kind") == "orbit-pose-xyz" and isinstance(record.get("joints"), dict)


def list_poses(folder):
    poses = []
    for name, _ in list_names(folder):
        try:
            record = read_record(folder, name)
        except (OSError, ValueError):
            continue
        if isinstance(record, dict):
            poses.append({"name": name, "savedAt": record.get("savedAt", 0), "thumbnail": record.get("thumbnail", "")})
    return sorted(poses, key=lambda pose: pose["savedAt"], reverse=True)


def save_pose(folder, name, record, overwrite=False):
    if not isinstance(record, dict) or not isinstance(record.get("doc"), dict):
        return "invalid", "The pose data is incomplete"
    record = {**record, "kind": "fisher-saved-pose", "name": safe_name(name), "savedAt": int(time.time() * 1000)}
    return write_record(folder, name, record, overwrite)


def delete_record(folder, name):
    path = _path(folder, name)
    if path is None or not os.path.isfile(path):
        return False
    os.remove(path)
    return True


def register_routes():
    try:
        import folder_paths
        from aiohttp import web
        from server import PromptServer
        routes = PromptServer.instance.routes
    except (ImportError, AttributeError):  # unit tests import the package without a running server
        return

    async def body_of(request):
        try:
            return await request.json()
        except ValueError:
            return None

    def reply(status, message):
        if status == "saved":
            return web.json_response({"name": message})
        return web.json_response({"error": message}, status=409 if status == "exists" else 400)

    def xyz_location(relative):
        return resolve_subfolder(xyz_folder(folder_paths.get_output_directory()), relative)

    @routes.get("/orbit360/xyz_files")
    async def get_xyz_list(request):
        location = xyz_location(request.query.get("path"))
        if location is None:
            return web.json_response({"error": "Invalid folder"}, status=400)
        folder, parts = location
        return web.json_response({"path": "/".join(parts), "folders": list_folders(folder),
                                  "files": [{"name": n, "savedAt": t} for n, t in list_names(folder)]})

    @routes.get("/orbit360/xyz_files/{name}")
    async def get_xyz(request):
        location = xyz_location(request.query.get("path"))
        try:
            record = read_record(location[0], request.match_info["name"]) if location else None
        except (OSError, ValueError):
            record = None
        return web.json_response(record) if record is not None else web.Response(status=404)

    @routes.post("/orbit360/xyz_files")
    async def post_xyz(request):
        body = await body_of(request)
        if not isinstance(body, dict) or not valid_xyz(body.get("record")):
            return web.json_response({"error": "Invalid request format"}, status=400)
        location = xyz_location(body.get("path"))
        if location is None:
            return web.json_response({"error": "Invalid folder"}, status=400)
        return reply(*write_record(location[0], body.get("name"), body["record"], bool(body.get("overwrite"))))

    @routes.get("/orbit360/saved_poses")
    async def get_poses(request):
        return web.json_response({"poses": list_poses(poses_folder(folder_paths.get_user_directory()))})

    @routes.get("/orbit360/saved_poses/{name}")
    async def get_pose(request):
        try:
            record = read_record(poses_folder(folder_paths.get_user_directory()), request.match_info["name"])
        except (OSError, ValueError):
            record = None
        return web.json_response(record) if record is not None else web.Response(status=404)

    @routes.post("/orbit360/saved_poses")
    async def post_pose(request):
        body = await body_of(request)
        if not isinstance(body, dict):
            return web.json_response({"error": "Invalid request format"}, status=400)
        return reply(*save_pose(poses_folder(folder_paths.get_user_directory()), body.get("name"), body.get("record"), bool(body.get("overwrite"))))

    @routes.post("/orbit360/saved_poses/{name}/delete")
    async def post_delete(request):
        return web.json_response({"removed": delete_record(poses_folder(folder_paths.get_user_directory()), request.match_info["name"])})
