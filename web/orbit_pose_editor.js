// Front end of the "360-Orbit XYZ Pose Editor" and "HM Qwen2.1 Free Pose XYZ (beta)" nodes: opens the XYZ pose editor
// in a modal iframe (same bridge as Fisher's free-pose editor) and writes its result into the node's widgets.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { resolveLang, translate } from "./editor/i18n.mjs";

const EDITOR_URL = new URL("./editor/xyzpose.html", import.meta.url);
const VERSION = "20261005";
// fields: node widgets exchanged with the editor; the first one holds the editor state. mode "qwen" adds the extra prompt
// and the person image to the editor. image: the node input whose upstream picture the editor shows.
const NODES = {
    Orbit360PoseEditor: { mode: "", fields: ["pose_json"], size: [380, 300] },
    HMQwenFreePoseXYZ: { mode: "qwen", fields: ["pose_json", "extra_prompt"], size: [400, 340], image: "reference_image" },
};
const configOf = node => NODES[node.comfyClass || node.type];
const widget = (node, name) => node.widgets.find(item => item.name === name);
let activeEditor = null;
const uiLang = () => resolveLang(app.extensionManager?.setting?.get?.("Comfy.Locale") ?? app.ui?.settings?.getSettingValue?.("Comfy.Locale") ?? navigator.language);

// The XYZ JSON the connected 360-Orbit Pose Estimation node produced in its last run (its "orbit_xyz" UI output).
function upstreamXyz(node) {
    const link = node.inputs?.find(input => input.name === "xyz_json")?.link;
    const edge = link != null ? app.graph.links[link] : null;
    return edge ? app.nodeOutputs?.[edge.origin_id]?.orbit_xyz?.[0] ?? "" : "";
}

// The picture feeding an IMAGE input: the upstream preview, else the file of a LoadImage node (like Fisher's editor).
function upstreamPreview(node, inputName) {
    const input = node.inputs?.find(item => item.name === inputName);
    let link = input?.link;
    const seen = new Set();
    for (let depth = 0; link != null && depth < 12; depth++) {
        const edge = app.graph.links[link];
        if (!edge) return null;
        const source = app.graph.getNodeById(edge.origin_id);
        if (!source || seen.has(source.id)) return null;
        seen.add(source.id);
        const preview = source.imgs?.[source.imageIndex || 0]?.src;
        if (preview) return preview;
        if (source.comfyClass === "LoadImage" || source.type === "LoadImage") {
            const file = source.widgets?.find(item => item.name === "image")?.value;
            if (typeof file === "string" && file) {
                const cleaned = file.replace(/ \[(input|output|temp)\]$/, "");
                const slash = cleaned.lastIndexOf("/");
                return new URL("/view?" + new URLSearchParams({ filename: cleaned.slice(slash + 1), subfolder: slash >= 0 ? cleaned.slice(0, slash) : "", type: "input" }), location.origin).href;
            }
        }
        link = source.inputs?.find(item => item.type === "IMAGE" && item.link != null)?.link;
    }
    return null;
}

// Show the applied mannequin image on the node without running the workflow (temp upload, like Fisher's editor).
async function showPoseImage(node) {
    let reference;
    try { reference = JSON.parse(widget(node, "pose_json")?.value || "{}").poseReference; } catch { return; }
    if (typeof reference !== "string" || !reference.startsWith("data:image/png;base64,")) return;
    let hash = 2166136261;
    for (let i = 0; i < reference.length; i += 7) hash = Math.imul(hash ^ reference.charCodeAt(i), 16777619);
    const form = new FormData();
    form.append("image", await (await fetch(reference)).blob(), `orbit360_pose_${(hash >>> 0).toString(16)}.png`);
    form.append("type", "temp");
    form.append("overwrite", "true");
    const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
    if (!response.ok) return;
    const { name, subfolder } = await response.json();
    const images = [{ filename: name, subfolder: subfolder || "", type: "temp" }];
    // The nodes show the picture themselves and on PreviewImage nodes fed by their first IMAGE output.
    const slot = node.outputs?.findIndex(output => output.type === "IMAGE") ?? -1;
    const previews = (node.outputs?.[slot]?.links || []).map(id => app.graph.getNodeById(app.graph.links[id]?.target_id))
        .filter(target => target?.type === "PreviewImage");
    for (const target of [node, ...previews]) app.nodeOutputs[target.id] = { ...(app.nodeOutputs[target.id] || {}), images };
    app.graph.setDirtyCanvas(true, true);
}

function openEditor(node) {
    activeEditor?.();
    const config = configOf(node);
    const lang = uiLang();
    const overlay = document.createElement("dialog");
    overlay.style.cssText = "width:96vw;max-width:1700px;height:94vh;max-height:1100px;padding:0;border:1px solid #dce3ed;border-radius:12px;background:#f4f6f8;box-shadow:0 20px 90px #0007;overflow:hidden;";
    const frame = document.createElement("iframe");
    frame.title = translate(lang, "node.titleXyz");
    frame.style.cssText = "border:0;width:100%;height:100%;display:block";
    frame.src = EDITOR_URL.href + "?embedded=1&lang=" + lang + (config.mode ? "&mode=" + config.mode : "") + "&v=" + VERSION;
    // The file picker must be opened by the host page, inside the modal, from the user's click.
    frame.fisherChooseFiles = (onFiles, { json = false } = {}) => {
        const picker = document.createElement("input");
        picker.type = "file";
        picker.accept = json ? ".json,application/json" : "image/*";
        picker.hidden = true;
        picker.addEventListener("click", event => event.stopPropagation());
        picker.onchange = () => { if (picker.files.length) onFiles([...picker.files]); picker.remove(); };
        overlay.append(picker);
        picker.click();
    };
    overlay.append(frame);
    const oldFocus = document.activeElement;
    function close() {
        window.removeEventListener("message", receive);
        overlay.close();
        overlay.remove();
        oldFocus?.focus();
        activeEditor = null;
    }
    function receive(event) {
        if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
        if (event.data?.type === "fisher-ready") {
            const payload = Object.fromEntries(config.fields.map(name => [name, widget(node, name).value]));
            payload.xyz_json = upstreamXyz(node);
            if (config.image) payload.referencePreview = upstreamPreview(node, config.image);
            frame.contentWindow.postMessage({ type: "fisher-load", payload }, location.origin);
        }
        if (event.data?.type === "fisher-close") close();
        if (event.data?.type === "fisher-apply") {
            const payload = event.data.payload;
            if (!payload || typeof payload[config.fields[0]] !== "string") return;
            for (const name of config.fields) {
                if (typeof payload[name] !== "string") continue;
                const item = widget(node, name);
                item.value = payload[name];
                item.callback?.(item.value);
            }
            node.setDirtyCanvas(true, true);
            app.graph.change();
            close();
            void showPoseImage(node).catch(error => console.warn("360-Orbit: pose preview failed", error));
        }
    }
    window.addEventListener("message", receive);
    // A file picker inside the dialog fires its own "cancel" event, and that one bubbles: only react to the dialog's own (Esc key).
    overlay.addEventListener("cancel", event => { if (event.target !== overlay) return; event.preventDefault(); close(); });
    document.body.append(overlay);
    overlay.showModal();
    activeEditor = close;
}

app.registerExtension({
    name: "Orbit360.XyzPoseEditor",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const config = NODES[nodeData.name];
        if (!config) return;
        const original = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = original?.apply(this, arguments);
            const poseJson = widget(this, "pose_json");
            poseJson.type = "fisher_hidden";
            poseJson.computeSize = () => [0, -4];
            if (poseJson.element) poseJson.element.style.display = "none";
            const openButton = this.addWidget("button", translate(uiLang(), "node.openXyz"), null, () => openEditor(this));
            openButton.serialize = false;  // a button has no value to save
            this.size = config.size;
            return result;
        };
        // A workflow saved with a pose shows its mannequin image again on load (outputs are reset while loading).
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = configure?.apply(this, arguments);
            setTimeout(() => void showPoseImage(this).catch(() => {}), 600);
            return result;
        };
    },
});
