// "360-Orbit Pose Estimation": show the result line of the last run on the node (the frontend shows a node's "text"
// output only for a few core nodes).
import { app } from "../../scripts/app.js";

const NODE = "Orbit360PoseEstimation";

app.registerExtension({
    name: "Orbit360.PoseEstimation",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            const status = document.createElement("textarea");
            status.readOnly = true;
            status.rows = 2;
            status.style.cssText = "width:100%;box-sizing:border-box;resize:none;font-size:12px;";
            this.orbitStatus = status;
            const resultWidget = this.addDOMWidget("result", "customtext", status, { getMinHeight: () => 44 });
            resultWidget.serialize = false;  // the frontend skips a widget whose own serialize is false (options.serialize is ignored)
            return result;
        };
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            executed?.apply(this, arguments);
            const text = message?.text?.[0];
            if (typeof text !== "string" || !this.orbitStatus) return;
            const failed = text.includes("FAILED");
            this.orbitStatus.value = text;
            this.orbitStatus.style.color = failed ? "#ff6b4a" : "";
            this.orbitStatus.style.fontWeight = failed ? "600" : "";
            this.bgcolor = failed ? "#4a2a2a" : undefined;
            this.setDirtyCanvas(true, true);
        };
    },
});
